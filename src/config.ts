import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Config, ProviderConfig } from './types.ts';

export async function loadConfig(): Promise<Config> {
  const dataDir = resolve(process.env.DATA_DIR || './data');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const file = process.env.CONFIG_FILE || `${dataDir}/config.json`;
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Configuration must be a JSON object');
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || process.env.CONFIG_FILE) throw error;
  }
  const integer = (value: unknown, fallback: number, min: number, max: number): number => {
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(result) || result < min || result > max) throw new Error(`Expected an integer between ${min} and ${max}`);
    return result;
  };
  let apiKey = process.env.API_KEY || (typeof raw.apiKey === 'string' ? raw.apiKey : '');
  if (!apiKey) {
    const keyFile = `${dataDir}/api-key`;
    try {
      apiKey = (await readFile(keyFile, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      apiKey = randomBytes(32).toString('hex');
      await writeFile(keyFile, `${apiKey}\n`, { mode: 0o600, flag: 'wx' });
    }
  }
  if (apiKey.length < 32) throw new Error('API_KEY must contain at least 32 characters');
  const port = integer(process.env.PORT ?? raw.port, 8787, 1, 65535);
  const publicUrl = String(process.env.PUBLIC_URL || raw.publicUrl || `http://localhost:${port}`).replace(/\/$/, '');
  const parsedUrl = new URL(publicUrl);
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || parsedUrl.pathname !== '/') {
    throw new Error('PUBLIC_URL must be an HTTP(S) origin without path, credentials, query or fragment');
  }
  const downloadsDir = resolve(String(process.env.DOWNLOADS_DIR || raw.downloadsDir || './downloads'));
  const categories = raw.categories ?? ['tv', 'movies'];
  if (!Array.isArray(categories) || !categories.length || categories.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value))) {
    throw new Error('categories must contain safe, non-empty directory names');
  }
  const providers = raw.providers ?? {};
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) throw new Error('providers must be an object');
  for (const [id, value] of Object.entries(providers)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid provider configuration: ${id}`);
  }
  await Promise.all(categories.map(category => mkdir(resolve(downloadsDir, category), { recursive: true })));
  return {
    host: process.env.HOST || String(raw.host || '127.0.0.1'), port, apiKey, publicUrl, dataDir, downloadsDir,
    concurrency: integer(process.env.CONCURRENCY ?? raw.concurrency, 2, 1, 32),
    ffmpeg: process.env.FFMPEG || String(raw.ffmpeg || 'ffmpeg'),
    ffprobe: process.env.FFPROBE || String(raw.ffprobe || 'ffprobe'),
    mp4decrypt: process.env.MP4DECRYPT || String(raw.mp4decrypt || 'mp4decrypt'),
    wvApiUrl: process.env.WV_API_URL || String(raw.wvApiUrl || 'https://wv.api.md.sune.app/v1/'),
    categories, providers: providers as Record<string, ProviderConfig>,
  };
}
