import { load as loadHtml } from 'cheerio';
import type { Catalogue, CatalogueQuery, MediaKind, MediaSource, Provider, ProviderConfig, Release } from '../types.ts';
import { fetchJson, fetchText, normalize, releaseId } from './common.ts';

// Ported from sune.app.mediadown.media_engine.streamcz.StreamCZEngine (Media Downloader).

const API_URL = 'https://api.stream.cz/graphql';
const REFERER = 'https://www.stream.cz/';
const CATEGORIES_URL = 'https://www.stream.cz/videa/filmy';
const BASE_URL = 'https://www.stream.cz/';
const REGEX_EPISODE = /^S(\d+):E(\d+)$/i;

// Boundary helper for navigating the loosely-typed APP_SERVER_STATE / GraphQL JSON blobs without
// scattering inline `as` shape assumptions through the traversal call sites.
function getPath(source: unknown, path: string): unknown {
  let current = source;
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || !(key in current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

interface CatalogNode { id: string; name: string; namePrefix: string | null; urlName: string; kind?: MediaKind }

/** A Stream.cz tag that lists episodes (a show or, for the `filmy` channel, individual movies). */
interface StreamCzProgram { id: string; title: string; kind: MediaKind; urlName: string }

function nodeFrom(source: unknown): CatalogNode | null {
  const id = getPath(source, 'id');
  const name = getPath(source, 'name');
  const urlName = getPath(source, 'urlName');
  if (typeof id !== 'string' || typeof name !== 'string' || typeof urlName !== 'string') return null;
  const namePrefix = getPath(source, 'namePrefix');
  return { id, name, urlName, namePrefix: typeof namePrefix === 'string' ? namePrefix : null };
}

async function graphqlRequest(query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  const response = await fetchJson<Record<string, unknown>>(API_URL, signal, {
    method: 'POST',
    headers: { 'content-type': 'application/json', referer: REFERER },
    body: JSON.stringify({ query, variables }),
  });
  if (Array.isArray(response.errors) && response.errors.length) throw new Error('Stream.cz rejected its catalog query');
  return response;
}

const QUERY_PROGRAMS = `query LoadTag($id: ID, $first: Int, $after: String) {
  childTagsData: tag(id: $id) {
    directTagsConnection(first: $first, after: $after, categories: [show, tag], mediaTypes: [video]) {
      totalCount
      pageInfo { endCursor hasNextPage }
      edges { node { id name urlName } }
    }
  }
}`;

// allEpisodesConnection has no orderBy argument; the connection order is upload order (oldest
// first). Relay's `last`/`before` args let newest-first browsing walk it backward, page by page,
// without first learning its length.
const QUERY_EPISODES = `query LoadTag($id: ID, $last: Int, $before: String) {
  tagData: tag(id: $id) {
    allEpisodesConnection(mediaTypes: [video], last: $last, before: $before) {
      pageInfo { startCursor hasPreviousPage }
      edges { node { id name namePrefix urlName } }
    }
  }
}`;

async function* paginateConnection(
  connectionPath: string, run: (cursor: string) => Promise<unknown>,
): AsyncGenerator<CatalogNode> {
  let cursor = '';
  for (;;) {
    const data = await run(cursor);
    const connection = getPath(data, connectionPath);
    const edges = getPath(connection, 'edges');
    if (Array.isArray(edges)) {
      for (const edge of edges) {
        const node = nodeFrom(getPath(edge, 'node'));
        if (node) yield node;
      }
    }
    const hasNextPage = getPath(connection, 'pageInfo.hasNextPage');
    if (hasNextPage !== true) return;
    const endCursor = getPath(connection, 'pageInfo.endCursor');
    cursor = typeof endCursor === 'string' ? endCursor : '';
  }
}

/** Same shape as `paginateConnection`, but walking a connection's `last`/`before` page backward. */
async function* paginateConnectionBackward(
  connectionPath: string, run: (cursor: string | null) => Promise<unknown>,
): AsyncGenerator<CatalogNode> {
  let cursor: string | null = null;
  for (;;) {
    const data = await run(cursor);
    const connection = getPath(data, connectionPath);
    const edges = getPath(connection, 'edges');
    const nodes: CatalogNode[] = [];
    if (Array.isArray(edges)) {
      for (const edge of edges) {
        const node = nodeFrom(getPath(edge, 'node'));
        if (node) nodes.push(node);
      }
    }
    for (let i = nodes.length - 1; i >= 0; i--) yield nodes[i]!;
    const hasPreviousPage = getPath(connection, 'pageInfo.hasPreviousPage');
    const startCursor = getPath(connection, 'pageInfo.startCursor');
    if (hasPreviousPage !== true || typeof startCursor !== 'string') return;
    cursor = startCursor;
  }
}

function programsOf(categoryId: string, signal: AbortSignal): AsyncGenerator<CatalogNode> {
  return paginateConnection('data.childTagsData.directTagsConnection', cursor =>
    graphqlRequest(QUERY_PROGRAMS, { id: categoryId, first: 24, after: cursor || null }, signal));
}

function episodesOf(programId: string, signal: AbortSignal): AsyncGenerator<CatalogNode> {
  return paginateConnectionBackward('data.tagData.allEpisodesConnection', cursor =>
    graphqlRequest(QUERY_EPISODES, { id: programId, last: 20, before: cursor }, signal));
}

function extractBalancedObject(text: string, openIndex: number): string | null {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(openIndex, i + 1); }
  }
  return null;
}

function appServerState(html: string): unknown {
  const $ = loadHtml(html);
  let result: unknown = null;
  $('script').each((_, el) => {
    if (result !== null) return;
    if ($(el).attr('src')) return;
    const content = $(el).html() ?? '';
    const markerIndex = content.indexOf('APP_SERVER_STATE = ');
    if (markerIndex < 0) return;
    const dataIndex = content.indexOf('data : ', markerIndex);
    if (dataIndex < 0) return;
    const braceIndex = content.indexOf('{', dataIndex);
    if (braceIndex < 0) return;
    const objectText = extractBalancedObject(content, braceIndex);
    if (!objectText) return;
    try { result = JSON.parse(objectText); } catch { /* try the next inline script tag, if any */ }
  });
  return result;
}

async function categories(signal: AbortSignal): Promise<CatalogNode[]> {
  const html = await fetchText(CATEGORIES_URL, signal, { headers: { referer: REFERER } });
  const state = appServerState(html);
  if (!state) return [];
  const nodes: CatalogNode[] = [];
  const navCategories = getPath(state, 'page.navigationCategories.data');
  if (Array.isArray(navCategories)) for (const entry of navCategories) { const node = nodeFrom(entry); if (node) nodes.push(node); }
  const channel = nodeFrom(getPath(state, 'fetchable.tag.channel.data'));
  if (channel) nodes.push({ ...channel, kind: 'movie' }); // channel on the explicit /videa/filmy page
  return nodes;
}

function programUrl(program: StreamCzProgram): string {
  return new URL(program.urlName.replace(/^\/+/, ''), BASE_URL).toString();
}

function parseSeasonEpisode(namePrefix: string | null): { season?: number; episode?: number } {
  const match = namePrefix ? REGEX_EPISODE.exec(namePrefix) : null;
  if (!match) return {};
  const season = match[1];
  const episode = match[2];
  return season && episode ? { season: Number(season), episode: Number(episode) } : {};
}

function buildRelease(program: StreamCzProgram, episode: CatalogNode): Release {
  const base = programUrl(program).replace(/\/?$/, '/');
  const url = new URL(episode.urlName.replace(/^\/+/, ''), base).toString();
  const { season, episode: episodeNum } = parseSeasonEpisode(episode.namePrefix);
  const kind: MediaKind = season !== undefined && episodeNum !== undefined ? 'tv' : program.kind;
  return {
    id: releaseId('streamcz', url), provider: 'streamcz', title: episode.name,
    url, kind, series: program.title, season, episode: episodeNum,
  };
}

async function* streamCzPrograms(query: CatalogueQuery, signal: AbortSignal): AsyncGenerator<StreamCzProgram> {
  for (const category of await categories(signal)) {
    const kind = category.kind ?? (normalize(category.name) === 'filmy' ? 'movie' : 'tv');
    if (query.kind && query.kind !== kind) continue;
    for await (const program of programsOf(category.id, signal)) {
      yield { id: program.id, title: program.name, kind, urlName: program.urlName };
    }
  }
}

async function* streamCzReleases(program: StreamCzProgram, signal: AbortSignal): AsyncGenerator<Release> {
  for await (const episode of episodesOf(program.id, signal)) yield buildRelease(program, episode);
}

const streamCzCatalogue: Catalogue<StreamCzProgram> = {
  programs: (query, signal) => streamCzPrograms(query, signal),
  releases: (program, _query, signal) => streamCzReleases(program, signal),
};

// --- Playback resolution (StreamCZEngine#getMedia) ---------------------------------------------

function parseQualityHeight(label: string): number | undefined {
  const match = /(\d+)p?/.exec(label);
  const digits = match?.[1];
  return digits ? Number(digits) : undefined;
}

function collectSubtitleSources(subtitleEntries: Array<{ language: string; srt?: string; webvtt?: string }>): MediaSource['subtitles'] {
  const out: NonNullable<MediaSource['subtitles']> = [];
  for (const entry of subtitleEntries) {
    if (entry.srt) out.push({ url: entry.srt, language: entry.language });
    if (entry.webvtt) out.push({ url: entry.webvtt, language: entry.language });
  }
  return out.length ? out : undefined;
}

async function resolveStreamCz(release: Release, signal: AbortSignal): Promise<MediaSource[]> {
  const html = await fetchText(release.url, signal, { headers: { referer: REFERER } });
  const state = appServerState(html);
  if (!state) return [];
  const videoData = getPath(state, 'fetchable.episode.videoDetail.data');
  const spl = getPath(videoData, 'spl');
  if (typeof spl !== 'string') return [];
  const splUrl = `${spl}spl2,3,VOD`.replace(/\|/g, '%7C');
  const splUri = new URL(splUrl);
  const json = await fetchJson<unknown>(splUri, signal);

  const subtitleEntries: Array<{ language: string; srt?: string; webvtt?: string }> = [];
  const rawSubtitles = getPath(json, 'data.subtitles');
  if (Array.isArray(rawSubtitles)) {
    for (const entry of rawSubtitles) {
      const language = getPath(entry, 'language');
      const srt = getPath(entry, 'urls.srt');
      const webvtt = getPath(entry, 'urls.webvtt');
      subtitleEntries.push({
        language: typeof language === 'string' ? language : 'unknown',
        srt: typeof srt === 'string' ? new URL(srt.replace(/\|/g, '%7C'), splUri).toString() : undefined,
        webvtt: typeof webvtt === 'string' ? new URL(webvtt.replace(/\|/g, '%7C'), splUri).toString() : undefined,
      });
    }
  }

  const sources: MediaSource[] = [];
  const mp4 = getPath(json, 'data.mp4');
  if (mp4 && typeof mp4 === 'object') {
    for (const [quality, item] of Object.entries(mp4)) {
      const itemUrl = getPath(item, 'url');
      if (typeof itemUrl !== 'string') continue;
      const url = new URL(itemUrl.replace(/\|/g, '%7C'), splUri).toString();
      const resolution = getPath(item, 'resolution');
      const resolutionHeight = Array.isArray(resolution) ? resolution[1] : undefined;
      const height = typeof resolutionHeight === 'number' ? resolutionHeight : parseQualityHeight(quality);
      const bandwidthValue = getPath(item, 'bandwidth');
      const bandwidth = typeof bandwidthValue === 'number' && bandwidthValue >= 0 ? bandwidthValue : undefined;
      const source: MediaSource = { url, type: 'file', height, bandwidth };
      const subtitles = collectSubtitleSources(subtitleEntries);
      if (subtitles) source.subtitles = subtitles;
      sources.push(source);
    }
  }
  const hlsUrl = getPath(json, 'pls.hls.url');
  if (typeof hlsUrl === 'string') {
    const url = new URL(hlsUrl.replace(/\|/g, '%7C'), splUri).toString();
    const source: MediaSource = { url, type: 'hls' };
    const subtitles = collectSubtitleSources(subtitleEntries);
    if (subtitles) source.subtitles = subtitles;
    sources.push(source);
  }
  return sources;
}

/**
 * Stream.cz is a fully public catalog with no login required for standard VOD playback, so the
 * provider is enabled unless explicitly disabled via config. Upstream has no dedicated text-search
 * endpoint, so browsing walks the same category → program → episode tree the site itself uses.
 */
export function createStreamCzProvider(config: ProviderConfig = {}): Provider | null {
  if (config.enabled === false) return null;
  return {
    id: 'streamcz',
    name: 'Stream.cz',
    catalogue: streamCzCatalogue,
    async resolve(release, signal) { return resolveStreamCz(release, signal); },
  };
}
