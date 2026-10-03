import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config, DownloadProgress, License, MediaSource } from '../types.ts';
import type { ProtectedTrack } from './mpd.ts';
import { parseManifest, selectVideoAndAudio } from './mpd.ts';
import { resolveHlsTracks } from './m3u8.ts';
import { obtainAndDecryptTrack } from './track-decrypt.ts';
import { ffmpegMux, type MuxInput } from './ffmpeg.ts';
import { validateMediaFile } from './ffprobe.ts';
import { runProcess } from './process.ts';

/** One Widevine content key: a key ID paired with the raw key bytes (hex), as returned by a CDM's license extraction step. */
export interface ContentKey { kid: string; key: string; }

/**
 * The only seam in the protected-media pipeline: a Content Decryption Module that turns a base64
 * PSSH into an opaque session + CDM challenge bytes, and later turns that session plus the raw
 * license server response into content keys. The provider's own license exchange (POSTing the
 * challenge to `License.url`/`License.headers`, or calling `License.exchange`) runs inside this
 * module, not inside the CDM: the CDM only ever sees challenge/response bytes.
 */
export interface Cdm {
  challenge(pssh: string, signal: AbortSignal): Promise<{ session: string; challenge: Uint8Array }>;
  keys(session: string, licenseResponse: Uint8Array, signal: AbortSignal): Promise<ContentKey[]>;
}

interface Period { video: ProtectedTrack; audio?: ProtectedTrack; durationSeconds?: number; }

/** ffmpeg concat-demuxer list entries require `'` escaped as `'\''` inside single-quoted paths. */
function concatListEntry(path: string): string {
  return `file '${path.replace(/'/g, "'\\''")}'\n`;
}

/** Losslessly concatenates same-codec ordered fragments (one per DASH Period) via ffmpeg's concat demuxer, preserving timestamps/audio without re-encoding. */
export async function concatOrdered(config: Config, paths: string[], listPath: string, outputPath: string, signal: AbortSignal): Promise<string> {
  if (paths.length === 1) return paths[0]!;
  await writeFile(listPath, paths.map(concatListEntry).join(''));
  await runProcess(config.ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath,
  ], signal);
  return outputPath;
}

async function resolvePeriods(source: MediaSource, signal: AbortSignal): Promise<Period[]> {
  if (source.type === 'hls') {
    const selection = await resolveHlsTracks(source.url, source.headers, source.height, source.audioLanguage, signal);
    if (selection.live) throw new Error('Live HLS streams are not supported for download');
    return [{ video: selection.video, audio: selection.audio }];
  }

  const response = await fetch(source.url, { headers: source.headers, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching DASH manifest`);
  const manifestText = await response.text();
  const manifest = parseManifest(manifestText, response.url);
  if (manifest.live) throw new Error('Live DASH streams are not supported for download');
  const selections = selectVideoAndAudio(manifest, source.height, source.audioLanguage);
  return selections.map(({ video, audio }) => ({ video, audio, durationSeconds: video.durationSeconds || undefined }));
}

/**
 * Downloads a Widevine-protected HLS or DASH `source` (whichever `source.type`/`source.drm`
 * indicate): resolves the best <=`source.height` video rendition and its linked/compatible audio
 * (ordered per DASH Period for multi-period sources; HLS always has exactly one), obtains content
 * keys through `cdm` and the provider's own license exchange, decrypts and concatenates the
 * tracks, muxes them (plus any plain subtitle tracks from `source.subtitles`) into a validated
 * `<outputDir>/<safeTitle>.mkv`, and only then atomically renames the result into place. Segment
 * downloads and decrypted tracks are checkpointed under a `.work` directory that is deliberately
 * left in place on failure so a later resumed attempt can skip already-completed work.
 */
export async function downloadProtectedMedia(
  config: Config, cdm: Cdm, source: MediaSource, outputDir: string, safeTitle: string,
  signal: AbortSignal, onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  if (!source.drm) throw new Error('Protected media source is missing DRM license information');
  const license: License = source.drm;
  const periods = await resolvePeriods(source, signal);
  if (!periods.length) throw new Error('Protected media source has no periods to download');

  const workDir = join(outputDir, `.${safeTitle}.work`);
  await mkdir(workDir, { recursive: true });

  const hasAudio = periods.some(period => period.audio);
  if (hasAudio && periods.some(period => !period.audio)) {
    throw new Error('Multi-period source has audio in some periods but not others: cannot concatenate without desyncing audio/video');
  }

  const bytesState = { value: 0 };
  let totalSegments = 0;
  for (const period of periods) {
    totalSegments += (period.video.initSegment ? 1 : 0) + period.video.mediaSegments.length;
    if (period.audio) {
      totalSegments += (period.audio.initSegment ? 1 : 0) + period.audio.mediaSegments.length;
    }
  }

  let completedSegmentsCount = 0;
  let currentTrackBase = 0;

  const emitProgress = (): void => {
    let progressPercent: number | undefined;
    let estimatedTotal: number | undefined;
    if (totalSegments > 0) {
      progressPercent = Math.min(90, Math.floor((completedSegmentsCount / totalSegments) * 90));
      if (completedSegmentsCount >= 2 && bytesState.value > 0) {
        estimatedTotal = Math.round((bytesState.value / completedSegmentsCount) * totalSegments);
      }
    }
    onProgress({ bytes: bytesState.value, progress: progressPercent, totalBytes: estimatedTotal });
  };

  const reportBytes = (delta: number): void => {
    bytesState.value += delta;
    emitProgress();
  };

  const createSegmentTracker = () => {
    const base = currentTrackBase;
    return (completedInTrack: number) => {
      completedSegmentsCount = base + completedInTrack;
      emitProgress();
    };
  };

  // Note: workDir (downloaded/decrypted track segments + resume checkpoints) is deliberately left
  // in place on error or abort so a later resumed attempt for the same job can skip already-
  // downloaded segments instead of re-fetching and re-decrypting everything from scratch.
  const videoPaths: string[] = [];
  const audioPaths: string[] = [];
  let totalDurationSeconds = 0;
  for (const [index, period] of periods.entries()) {
    const suffix = periods.length > 1 ? `-p${index}` : '';
    const videoTrackTotal = (period.video.initSegment ? 1 : 0) + period.video.mediaSegments.length;
    videoPaths.push(await obtainAndDecryptTrack(
      config, cdm, license, period.video, source.headers, workDir, `video${suffix}`, signal,
      reportBytes, createSegmentTracker(),
    ));
    currentTrackBase += videoTrackTotal;
    completedSegmentsCount = currentTrackBase;
    signal.throwIfAborted();

    if (period.audio) {
      const audioTrackTotal = (period.audio.initSegment ? 1 : 0) + period.audio.mediaSegments.length;
      audioPaths.push(await obtainAndDecryptTrack(
        config, cdm, license, period.audio, source.headers, workDir, `audio${suffix}`, signal,
        reportBytes, createSegmentTracker(),
      ));
      currentTrackBase += audioTrackTotal;
      completedSegmentsCount = currentTrackBase;
      signal.throwIfAborted();
    }
    totalDurationSeconds += period.durationSeconds ?? 0;
  }

  const videoPath = await concatOrdered(config, videoPaths, join(workDir, 'video.concat.txt'), join(workDir, 'video.concat.mp4'), signal);
  signal.throwIfAborted();
  const audioPath = audioPaths.length
    ? await concatOrdered(config, audioPaths, join(workDir, 'audio.concat.txt'), join(workDir, 'audio.concat.mp4'), signal)
    : undefined;
  signal.throwIfAborted();

  const inputs: MuxInput[] = [{ url: videoPath, kind: 'video' }];
  if (audioPath) inputs.push({ url: audioPath, kind: 'audio' });
  for (const subtitle of source.subtitles ?? []) inputs.push({ url: subtitle.url, headers: subtitle.headers, kind: 'subtitle', language: subtitle.language });

  const tempPath = join(outputDir, `.${safeTitle}.tmp.mkv`);
  const finalPath = join(outputDir, `${safeTitle}.mkv`);
  await ffmpegMux(config, inputs, tempPath, signal, progress => {
    const muxProgress = progress.progress !== undefined
      ? 90 + Math.min(9, Math.floor((progress.progress / 100) * 9))
      : 92;
    onProgress({ bytes: bytesState.value, progress: muxProgress });
  }, totalDurationSeconds || undefined);
  await validateMediaFile(config, tempPath, signal);
  await rename(tempPath, finalPath);
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
  return finalPath;
}
