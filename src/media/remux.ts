import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { Config, DownloadProgress, MediaSource } from '../types.ts';
import { ffmpegMux } from './ffmpeg.ts';
import type { MuxInput } from './ffmpeg.ts';
import { probeMedia, validateMediaFile } from './ffprobe.ts';
import { isHlsLive } from './m3u8.ts';

/** Clear adaptive streams and separate file tracks share the same explicit stream-selection path. */
export async function downloadRemux(
  config: Config, source: MediaSource, outputDir: string, safeTitle: string, signal: AbortSignal,
  onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  if (source.type === 'hls') {
    if (await isHlsLive(source.url, source.headers, signal)) throw new Error('An ongoing HLS live stream cannot be imported');
  } else if (source.type === 'dash') {
    const response = await fetch(source.url, { headers: source.headers, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching DASH manifest`);
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(await response.text());
    if (!parsed.MPD) throw new Error('Invalid DASH manifest');
    if (parsed.MPD['@_type'] === 'dynamic') throw new Error('An ongoing DASH live stream cannot be imported');
  }

  const media = await probeMedia(config, source.url, source.headers, signal);
  const video = media.streams.filter(stream => stream.codec_type === 'video' && (!source.height || (stream.height || 0) <= source.height))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || Number(b.bit_rate || 0) - Number(a.bit_rate || 0))[0];
  if (!video) throw new Error('Source contains no video matching the requested quality');
  const inputs: MuxInput[] = [{ url: source.url, headers: source.headers, kind: 'video', streamIndex: video.index }];
  if (source.audioUrl) {
    const audio = await probeMedia(config, source.audioUrl, source.headers, signal);
    const stream = audio.streams.filter(item => item.codec_type === 'audio')
      .sort((a, b) => Number(b.bit_rate || 0) - Number(a.bit_rate || 0))[0];
    if (!stream) throw new Error('Separate audio source contains no audio');
    inputs.push({ url: source.audioUrl, headers: source.headers, kind: 'audio', streamIndex: stream.index });
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
