import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { Indexer } from '../src/indexer.ts';
import { SeriesBindings } from '../src/series-binding.ts';
import type { Config, Provider, SeriesIdentity } from '../src/types.ts';
import { fakeCatalogue } from './fake-catalogue.ts';

const identity: SeriesIdentity = { tvdbId: 12345, title: 'Show Name', aliases: [], year: 2020, country: 'US' };
const config: Config = {
  host: '127.0.0.1', port: 8787, apiKey: 'a'.repeat(64), publicUrl: 'http://localhost:8787',
  dataDir: '/unused', downloadsDir: '/unused', concurrency: 1,
  ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', mp4decrypt: 'mp4decrypt', wvApiUrl: 'https://example.test/wv/',
  categories: ['tv', 'movies'], providers: {},
};

function indexer(lookups: number[] = []) {
  const store = new Store(':memory:');
  const provider: Provider = {
    id: 'oneplay', name: 'Oneplay', resolve: async () => [],
    seriesCandidates: async () => [{ id: 'src', title: 'Show Name', aliases: [], year: 2020, countries: ['US'] }],
    catalogue: fakeCatalogue(bound => bound === 'src' ? [{
      id: 'ep-1', provider: 'oneplay', title: 'Pilot', series: 'Provider Title', kind: 'tv', season: 1, episode: 1,
      url: 'https://oneplay.test/original/stream.mp4', programId: 'src',
    }] : []),
  };
  const bindings = new SeriesBindings(store.database, async tvdbId => { lookups.push(tvdbId); return identity; });
  return { store, indexer: new Indexer(config, store, new Map([[provider.id, provider]]), bindings) };
}

test('a tvdbid search is advertised and answered with the canonical title, tvdbid attribute and original source URL', async () => {
  const { store, indexer: newznab } = indexer();
  using dispose = store;
  assert.match(newznab.capabilities(), /supportedParams="q,season,ep,tvdbid"/);
  const feed = await newznab.search({ t: 'tvsearch', q: '', tvdbid: '12345' }, new AbortController().signal);
  assert.match(feed, /<title>Show Name S01E01 WEB-DL-oneplay<\/title>/);
  assert.match(feed, /<newznab:attr name="tvdbid" value="12345"\/>/);
  assert.match(feed, /<comments>https:\/\/oneplay\.test\/original\/stream\.mp4<\/comments>/);
  // The Task descriptor names the stamped Release.
  assert.equal(newznab.parseTaskDescriptor(newznab.taskDescriptor('ep-1').content).tvdbId, 12345);
});

test('invalid tvdbid values are rejected before any TVDB lookup', async () => {
  const lookups: number[] = [];
  const { store, indexer: newznab } = indexer(lookups);
  using dispose = store;
  for (const bad of ['0', '-5', '1.5', 'abc', '1e9999999']) {
    await assert.rejects(newznab.search({ t: 'tvsearch', q: '', tvdbid: bad }, new AbortController().signal));
  }
  await assert.rejects(newznab.search({ t: 'search', q: '', tvdbid: '12345' }, new AbortController().signal), /Invalid tvdbid/);
  assert.deepEqual(lookups, []);
});
