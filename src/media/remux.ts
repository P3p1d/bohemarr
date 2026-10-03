import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config, DownloadProgress, MediaSource } from '../types.ts';
import { ffmpegMux } from './ffmpeg.ts';
import type { MuxInput } from './ffmpeg.ts';
import { probeMedia, validateMediaFile, type ProbedStream } from './ffprobe.ts';
import { resolveHlsTracks } from './m3u8.ts';
import { parseManifest, selectVideoAndAudio, type ProtectedTrack } from './mpd.ts';
import { downloadSegmentsConcat } from './segment-download.ts';
import { concatOrdered } from './protected-media.ts';
import { DEFAULT_AUDIO_LANGUAGE } from './metadata.ts';
import { normalizeLanguage } from '../providers/common.ts';

/** Highest-bitrate audio stream, preferring one whose language matches `preferredLanguage`
 * (compared via `normalizeLanguage`, so e.g. `ces`/`cs-CZ` count as a Czech match). */
function bestAudioStream(streams: ProbedStream[], preferredLanguage: string | undefined): ProbedStream | undefined {
  const candidates = streams.filter(stream => stream.codec_type === 'audio');
  const preferredNormalized = preferredLanguage ? normalizeLanguage(preferredLanguage) : undefined;
  const matching = preferredNormalized ? candidates.filter(stream => normalizeLanguage(stream.tags?.language) === preferredNormalized) : [];
  const pool = matching.length ? matching : candidates;
  return pool.reduce<ProbedStream | undefined>((best, current) =>
    !best || Number(current.bit_rate || 0) > Number(best.bit_rate || 0) ? current : best, undefined);
}

/** Downloads one clear (unencrypted) track's init + media segments, concatenated in order. */
async function downloadClearTrack(
  track: ProtectedTrack, headers: Record<string, string> | undefined, outputPath: string,
  signal: AbortSignal, onBytes: (bytes: number) => void,
  onSegment?: (completedIndex: number, totalCount: number) => void,
): Promise<string> {
  const segments = track.initSegment ? [track.initSegment, ...track.mediaSegments] : track.mediaSegments;
  await downloadSegmentsConcat(segments, headers, outputPath, signal, onBytes, undefined, onSegment);
  return outputPath;
}

/**
 * Downloads a clear (non-DRM) DASH `source` by explicitly selecting the best video/audio
 * Representation per Period (the same selection `inspectMediaSources` uses), rather than trusting
 * ffmpeg's own DASH demuxer to auto-pick a Representation - which is not guaranteed to be the
 * highest quality or requested-language one.
 */
async function downloadClearDash(
  config: Config, source: MediaSource, outputDir: string, safeTitle: string, signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  const response = await fetch(source.url, { headers: source.headers, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching DASH manifest`);
  const manifest = parseManifest(await response.text(), response.url);
  if (manifest.live) throw new Error('An ongoing DASH live stream cannot be imported');
  const selections = selectVideoAndAudio(manifest, undefined, source.audioLanguage ?? DEFAULT_AUDIO_LANGUAGE);

  const workDir = join(outputDir, `.${safeTitle}.work`);
  await mkdir(workDir, { recursive: true });
  const bytesState = { value: 0 };
  let totalSegments = 0;
  for (const { video, audio } of selections) {
    totalSegments += (video.initSegment ? 1 : 0) + video.mediaSegments.length;
    if (audio) totalSegments += (audio.initSegment ? 1 : 0) + audio.mediaSegments.length;
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

  const videoPaths: string[] = [];
  const audioPaths: string[] = [];
  let totalDurationSeconds = 0;
  for (const [index, { video, audio }] of selections.entries()) {
    const suffix = selections.length > 1 ? `-p${index}` : '';
    const videoTrackTotal = (video.initSegment ? 1 : 0) + video.mediaSegments.length;
    videoPaths.push(await downloadClearTrack(
      video, source.headers, join(workDir, `video${suffix}.mp4`), signal,
      reportBytes, createSegmentTracker(),
    ));
    currentTrackBase += videoTrackTotal;
    completedSegmentsCount = currentTrackBase;
    signal.throwIfAborted();

    if (audio) {
      const audioTrackTotal = (audio.initSegment ? 1 : 0) + audio.mediaSegments.length;
      audioPaths.push(await downloadClearTrack(
        audio, source.headers, join(workDir, `audio${suffix}.mp4`), signal,
        reportBytes, createSegmentTracker(),
      ));
      currentTrackBase += audioTrackTotal;
      completedSegmentsCount = currentTrackBase;
      signal.throwIfAborted();
    }
    totalDurationSeconds += video.durationSeconds || 0;
  }
  if (audioPaths.length > 0 && audioPaths.length !== videoPaths.length) {
    throw new Error('Multi-period source has audio in some periods but not others: cannot concatenate without desyncing audio/video');
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
  const ext = source.subtitles?.length ? 'mkv' : 'mp4';
  const tempPath = join(outputDir, `.${safeTitle}.tmp.${ext}`);
  const finalPath = join(outputDir, `${safeTitle}.${ext}`);
  // The mux step only stream-copies the already-downloaded segments into a container: its own
  // `progress.bytes` (bytes written to the new container) must not be added on top of
  // `bytesState.value` (bytes already fetched), or the same data would be counted twice.
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

/**
 * Downloads a clear (non-DRM) HLS `source` by feeding ffmpeg the explicitly-resolved best variant
 * and linked-audio-group playlist URLs (rather than the master playlist, whose default rendition
 * ffmpeg's own HLS demuxer would otherwise pick), so the requested/highest quality and language
 * are what's actually downloaded.
 */
async function downloadClearHls(
  config: Config, source: MediaSource, outputDir: string, safeTitle: string, signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  const selection = await resolveHlsTracks(source.url, source.headers, undefined, source.audioLanguage ?? DEFAULT_AUDIO_LANGUAGE, signal);
  if (selection.live) throw new Error('An ongoing HLS live stream cannot be imported');

  const inputs: MuxInput[] = [{ url: selection.videoPlaylistUrl, headers: source.headers, kind: 'video' }];
  if (selection.audioPlaylistUrl) inputs.push({ url: selection.audioPlaylistUrl, headers: source.headers, kind: 'audio' });
  for (const subtitle of source.subtitles ?? []) inputs.push({ url: subtitle.url, headers: subtitle.headers, kind: 'subtitle', language: subtitle.language });
  const ext = source.subtitles?.length ? 'mkv' : 'mp4';
  const tempPath = join(outputDir, `.${safeTitle}.tmp.${ext}`);
  const finalPath = join(outputDir, `${safeTitle}.${ext}`);
  await ffmpegMux(config, inputs, tempPath, signal, onProgress, selection.video.durationSeconds || undefined);
  await validateMediaFile(config, tempPath, signal);
  await rename(tempPath, finalPath);
  return finalPath;
}

/** Clear adaptive streams and separate file tracks share the same explicit stream-selection path. */
export async function downloadRemux(
  config: Config, source: MediaSource, outputDir: string, safeTitle: string, signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  if (source.type === 'dash') return downloadClearDash(config, source, outputDir, safeTitle, signal, onProgress);
  if (source.type === 'hls') return downloadClearHls(config, source, outputDir, safeTitle, signal, onProgress);

  const media = await probeMedia(config, source.url, source.headers, signal);
  const video = media.streams.filter(stream => stream.codec_type === 'video' && (!source.height || (stream.height || 0) <= source.height))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || Number(b.bit_rate || 0) - Number(a.bit_rate || 0))[0];
  if (!video) throw new Error('Source contains no video matching the requested quality');
  const inputs: MuxInput[] = [{ url: source.url, headers: source.headers, kind: 'video', streamIndex: video.index }];
  const preferredLanguage = source.audioLanguage ?? DEFAULT_AUDIO_LANGUAGE;
  if (source.audioUrl) {
    const audio = await probeMedia(config, source.audioUrl, source.headers, signal);
    const stream = bestAudioStream(audio.streams, preferredLanguage);
    if (!stream) throw new Error('Separate audio source contains no audio');
    inputs.push({ url: source.audioUrl, headers: source.headers, kind: 'audio', streamIndex: stream.index });
  } else {
    // No separate audio file: an embedded track still needs an explicit pick, since ffmpeg's own
    // default (first) audio stream is not necessarily the highest-bitrate or preferred-language one.
    const stream = bestAudioStream(media.streams, preferredLanguage);
    if (stream) inputs.push({ url: source.url, headers: source.headers, kind: 'audio', streamIndex: stream.index });
  }
  for (const subtitle of source.subtitles ?? []) {
    inputs.push({ url: subtitle.url, headers: subtitle.headers, kind: 'subtitle', language: subtitle.language });
  }
  const ext = source.subtitles?.length ? 'mkv' : 'mp4';
  const tempPath = join(outputDir, `.${safeTitle}.tmp.${ext}`);
  const finalPath = join(outputDir, `${safeTitle}.${ext}`);
  await ffmpegMux(config, inputs, tempPath, signal, onProgress, media.duration);
  await validateMediaFile(config, tempPath, signal);
  await rename(tempPath, finalPath);
  return finalPath;
}
