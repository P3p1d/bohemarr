import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createPrimaProviders } from '../src/providers/prima.ts';
import { searchCatalogue } from '../src/catalogue.ts';
import { SeriesBindings } from '../src/series-binding.ts';
import { Store } from '../src/store.ts';
import { DatabaseSync } from 'node:sqlite';
import type { SeriesIdentity } from '../src/types.ts';

const root = 'https://www.iprima.cz';
const czechUri = `${root}/serialy/ano-sefe`;
const foreignUri = `${root}/serialy/ano-sefe-s-gordonem-ramsaym`;
const identity: SeriesIdentity = { tvdbId: 252180, title: 'Ano, šéfe!', aliases: [], year: 2009, country: 'cze' };

function nuxtPage(title: Record<string, unknown>): string {
  const table: unknown[] = [];
  function reference(value: unknown): number {
    const index = table.length;
    table.push(null);
    table[index] = Array.isArray(value) ? value.map(reference)
      : value !== null && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reference(item)])) : value;
    return index;
  }
  reference({ data: { page: { title } } });
  return `<script id="__NUXT_DATA__">${JSON.stringify(table)}</script>`;
}

function sitemap(entries: Array<{ uri: string; lastmod: string }>): string {
  return `<urlset>${entries.map(({ uri, lastmod }) => `<url><loc>${uri}</loc><lastmod>${lastmod}</lastmod></url>`).join('')}</urlset>`;
}

/** `beforeRequest` sees every request; `init.headers` is set only on authenticated Prima+ requests. */
function catalogue(t: TestContext, beforeRequest?: (url: string, init?: RequestInit) => void) {
  // The foreign edition changed more recently, so the index lists it first.
  const programs = [
    { uri: foreignUri, title: 'Ano, šéfe s Gordonem Ramsaym USA', type: 'tv_series', id: 'foreign', year: 2007, countries: [{ label: 'USA' }], lastmod: '2026-09-28T00:00:00+00:00' },
    { uri: czechUri, title: 'Ano, šéfe!', type: 'tv_series', id: 'czech', year: 2009, countries: [{ label: 'ČR' }], lastmod: '2026-09-01T00:00:00+00:00' },
  ];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    beforeRequest?.(url, init);
    if (url === `${root}/sitemap-series.xml`) return new Response(sitemap(programs));
    if (url === `${root}/sitemap-movie.xml`) return new Response(sitemap([]));
    if (url === 'https://ucet.iprima.cz/api/session/create') {
      return Response.json({ sessionId: 'session', accessToken: { value: 'test-token' } });
    }
    if (url === `${root}/profily`) {
      return new Response(`<script id="__NUXT_DATA__">${JSON.stringify([
        { state: 1 }, { profiles: 2 }, [3], { ulid: 4, name: 5 }, 'profile', 'Default',
      ])}</script><script>window.__NUXT__.config={public:{profileTokenSecret:'test-signing-key'}};</script>`);
    }
    if (url === 'https://gateway-api.prod.iprima.cz/json-rpc/') {
      const rpc = JSON.parse(String(init?.body));
      if (rpc.method === 'vdm.frontend.season.list.hbbtv') {
        return Response.json({ result: { data: [{ id: `${rpc.params.id}-season`, seasonNumber: 1 }] } });
      }
      if (rpc.method === 'vdm.frontend.episodes.list.hbbtv') {
        const program = programs.find(p => `${p.id}-season` === rpc.params.id)!;
        return Response.json({ result: { data: { seasonNumber: 1, episodes: [{
          title: program.id === 'czech' ? 'Restaurant Hrádek (Litoměřice)' : 'US restaurant',
          additionals: { episodeNumber: 1, webUrl: `${program.uri}/season-1/episode-1` }, distribution: {},
        }] } } });
      }
      throw new Error(`Unexpected RPC ${rpc.method}`);
    }
    const program = programs.find(p => p.uri === url);
    if (program) return new Response(`<head><title>${program.title} online ke zhlédnutí | prima+</title></head>${nuxtPage({ ...program, type: 'series' })}`);
    if (url.startsWith('https://zoom.iprima.cz/snippet/') || url === 'https://cnn.iprima.cz/porady') return new Response('');
    throw new Error(`Unexpected request ${url}`);
  });
  const database = new DatabaseSync(':memory:');
  const provider = createPrimaProviders({ iprima: { enabled: true, username: 'test@example.invalid', password: 'test-password' } }, database)[0]!;
  t.after(async () => { await provider.close?.(); database.close(); });
  return provider;
}

test('Prima exact show match is not hidden by a larger foreign edition before pagination', async t => {
  const provider = catalogue(t);
  const releases = await searchCatalogue(provider, { q: 'Ano, šéfe!', kind: 'tv', limit: 1, offset: 0 }, new AbortController().signal);
  assert.deepEqual(releases.map(r => r.url), [`${czechUri}/season-1/episode-1`]);
  const next = await searchCatalogue(provider, { q: 'Ano, šéfe!', kind: 'tv', limit: 1, offset: 1 }, new AbortController().signal);
  assert.deepEqual(next.map(r => r.url), [`${foreignUri}/season-1/episode-1`]);
});

test('Prima browse returns a full requested page without waiting for unrelated programmes', async t => {
  const controller = new AbortController();
  const provider = catalogue(t, (url, init) => {
    if (url === czechUri && init?.headers) {
      controller.abort(new Error('Request deadline exceeded while loading the next programme'));
      controller.signal.throwIfAborted();
    }
  });
  const releases = await searchCatalogue(provider, { q: '', kind: 'tv', limit: 1, offset: 0 }, controller.signal);
  assert.deepEqual(releases.map(r => r.url), [`${foreignUri}/season-1/episode-1`]);
});

test('Prima browse retains a partial final batch and applies the requested offset in catalogue order', async t => {
  const provider = catalogue(t);
  const signal = new AbortController().signal;
  const all = await searchCatalogue(provider, { q: '', kind: 'tv', limit: 10, offset: 0 }, signal);
  assert.deepEqual(all.map(r => r.url), [`${foreignUri}/season-1/episode-1`, `${czechUri}/season-1/episode-1`]);
  const page = await searchCatalogue(provider, { q: '', kind: 'tv', limit: 1, offset: 1 }, signal);
  assert.deepEqual(page.map(r => r.url), [`${czechUri}/season-1/episode-1`]);
});

test('Prima binds a TVDB series by programme year and Czech origin, then expands the bound programme only', async t => {
  const provider = catalogue(t);
  const signal = new AbortController().signal;
  const query = { q: '', kind: 'tv' as const, season: 1, episode: 1, limit: 20, offset: 0 };
  using store = new Store(':memory:');
  const bindings = new SeriesBindings(store.database);
  const costaRica = await bindings.search(provider, query, { ...identity, tvdbId: identity.tvdbId + 1, country: 'CRI' }, signal);
  assert.deepEqual(costaRica, { releases: [], unbound: 'country-mismatch' }, 'ČR is not ISO CR (Costa Rica)');

  const { releases, unbound } = await bindings.search(provider, query, identity, signal);
  assert.equal(unbound, undefined);
  assert.deepEqual(releases.map(r => ({ url: r.url, program: r.programId, season: r.season, episode: r.episode, tvdbId: r.tvdbId })), [
    { url: `${czechUri}/season-1/episode-1`, program: czechUri, season: 1, episode: 1, tvdbId: identity.tvdbId },
  ]);
});
