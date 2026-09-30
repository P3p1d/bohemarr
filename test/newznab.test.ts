import test from 'node:test';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';
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
  return { store, provider, indexer: new Indexer(config, store, new Map([[provider.id, provider]]), bindings) };
}

test('a tvdbid search is advertised and answered with the canonical title, tvdbid attribute and original source URL', async () => {
  const { store, indexer: newznab } = indexer();
  using dispose = store;
  assert.match(newznab.capabilities(), /supportedParams="q,season,ep,tvdbid"/);
  const feed = await newznab.search({ t: 'tvsearch', q: '', tvdbid: '12345' }, new AbortController().signal);
  assert.match(feed, /<newznab:attr name="tvdbid" value="12345"\/>/);
  assert.match(feed, /<comments>https:\/\/oneplay\.test\/original\/stream\.mp4<\/comments>/);
  // The Task descriptor names the stamped Release.
  const stamped = newznab.parseTaskDescriptor(newznab.taskDescriptor('ep-1').content);
  assert.equal(stamped.tvdbId, 12345);
  assert.equal(stamped.series, 'Show Name');
});

test('Newznab publishes highest available video with Czech audio and an honest AV size estimate', async t => {
  let uhdAvailable = false;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const response = new Response(`<MPD type="static"><Period duration="PT8S">
      <AdaptationSet contentType="video"><SegmentTemplate media="v-$RepresentationID$-$Number$.m4s" duration="2"/>
        <Representation id="720" height="720" bandwidth="12000000"/>
        <Representation id="1080-low" height="1080" bandwidth="6000000"/>
        <Representation id="1080-high" height="1080" bandwidth="8000000"/>
        ${uhdAvailable ? '<Representation id="2160" height="2160" bandwidth="16000000"/>' : ''}
      </AdaptationSet>
      <AdaptationSet contentType="audio" lang="en"><Representation id="en" bandwidth="512000"><SegmentTemplate media="en-$Number$.m4s" duration="2"/></Representation></AdaptationSet>
      <AdaptationSet contentType="audio" lang="cs-CZ"><Representation id="cz" bandwidth="128000"><SegmentTemplate media="cz-$Number$.m4s" duration="2"/></Representation></AdaptationSet>
    </Period></MPD>`);
    Object.defineProperty(response, 'url', { value: String(input) });
    return response;
  });
  const { store, provider, indexer: newznab } = indexer();
  using dispose = store;
  provider.resolve = async () => [{ url: 'https://cdn.example.test/master.mpd?token=private-only', type: 'dash', headers: { 'X-Stream-Token': 'private-only' } }];
  const params = { t: 'tvsearch', tvdbid: '12345', season: '1', ep: '1' };
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, isArray: name => name === 'newznab:attr' });
  const item = parser.parse(await newznab.search(params, new AbortController().signal)).rss.channel.item;
  assert.equal(item.title, 'Show Name S01E01 (CZ)[WEB-DL][1080p]');
  assert.equal(item.enclosure['@_length'], '8128000');
  assert.equal(item['newznab:attr'].find((attr: Record<string, string>) => attr['@_name'] === 'size')['@_value'], '8128000');
  assert.match(item.description, /estimated/i);
  const descriptor = newznab.taskDescriptor('ep-1');
  assert.equal(descriptor.name, 'Show Name S01E01 (CZ)[WEB-DL][1080p].nzb');
  assert.doesNotMatch(JSON.stringify(newznab.parseTaskDescriptor(descriptor.content)), /private-only|X-Stream-Token|master\.mpd/);

  // A durable episode URL can acquire a higher-quality rendition after the first search.
  uhdAvailable = true;
  const updated = parser.parse(await newznab.search(params, new AbortController().signal)).rss.channel.item;
  assert.equal(updated.title, 'Show Name S01E01 (CZ)[WEB-DL][2160p]');
  assert.equal(updated.enclosure['@_length'], '16128000');
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
