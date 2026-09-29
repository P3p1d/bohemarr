import type { Config, DownloadMedia, MediaSource } from '../types.ts';
import { downloadDirectFile } from './http-download.ts';
import { downloadRemux } from './remux.ts';
import { downloadProtectedMedia } from './protected-media.ts';
import { wvApiCdm } from './wv-api.ts';

import { sanitizeFilename } from '../providers/common.ts';

/** Picks the highest-quality alternative among `sources` (by height, then bandwidth). */
function selectBestSource(sources: MediaSource[]): MediaSource {
  return sources.reduce((best, current) => {
    const bestHeight = best.height ?? 0;
    const currentHeight = current.height ?? 0;
    if (currentHeight !== bestHeight) return currentHeight > bestHeight ? current : best;
    return (current.bandwidth ?? 0) > (best.bandwidth ?? 0) ? current : best;
  });
}

function extensionFromUrl(url: string): string {
  const match = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec(new URL(url).pathname);
  return match?.[1]?.toLowerCase() ?? 'mp4';
}

/**
 * Builds the `DownloadMedia` function: dispatches each source to the direct-file streamer, the
 * clear HLS/DASH ffmpeg remuxer, or the encrypted HLS/DASH Widevine pipeline (manifest parse ->
 * WV license exchange -> mp4decrypt -> ffmpeg mux), always returning a path inside `outputDir`.
 */
export function createMediaDownloader(config: Config): DownloadMedia {
  const cdm = wvApiCdm(config);
  return async (sources, outputDir, title, signal, onProgress) => {
    signal.throwIfAborted();
    if (!sources.length) throw new Error('No media sources provided');
    const source = selectBestSource(sources);
    const safeTitle = sanitizeFilename(title);

    if (source.type === 'file' && (source.audioUrl || source.subtitles?.length) && !source.drm) {
      return downloadRemux(config, source, outputDir, safeTitle, signal, onProgress);
    }

    if (source.type === 'file') {
      if (source.drm) throw new Error('DRM-protected direct file sources are not supported');
      const finalPath = `${outputDir}/${safeTitle}.${extensionFromUrl(source.url)}`;
      await downloadDirectFile(config, source, finalPath, signal, onProgress);
      return finalPath;
    }

    if (source.drm) {
      return downloadProtectedMedia(config, cdm, source, outputDir, safeTitle, signal, onProgress);
    }

    return downloadRemux(config, source, outputDir, safeTitle, signal, onProgress);
  };
}
