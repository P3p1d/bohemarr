import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempDisposable, writeFile, access } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Queue } from '../src/queue.ts';
import { Indexer } from '../src/indexer.ts';
import { Sabnzbd } from '../src/sabnzbd.ts';
import { SeriesBindings } from '../src/series-binding.ts';
import { createProviders } from '../src/providers/index.ts';
import { fakeCatalogue } from './fake-catalogue.ts';
import type { Config, Provider, Release } from '../src/types.ts';

const release: Release = { id: 'episode-one', provider: 'direct', title: 'Example', series: 'Example', kind: 'tv', season: 1, episode: 1, url: 'https://example.test/video.mp4' };

async function fixture() {
  const dir = await mkdtempDisposable(join(tmpdir(), 'md-lifecycle-'));
  const config: Config = {
    host: '127.0.0.1', port: 8787, apiKey: 'a'.repeat(64), publicUrl: 'http://localhost:8787',
    dataDir: dir.path, downloadsDir: join(dir.path, 'downloads'), concurrency: 1,
    ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', mp4decrypt: 'mp4decrypt', wvApiUrl: 'https://example.test/wv/',
    categories: ['tv', 'movies'], providers: {},
  };
  const store = new Store(join(dir.path, 'state.sqlite'));
  const provider: Provider = { id: 'direct', name: 'Direct', catalogue: fakeCatalogue(() => [release]), resolve: async () => [{ url: release.url, type: 'file' }] };
  const providers = new Map([[provider.id, provider]]);
  return { dir, root: dir.path, config, store, providers };
}

test('pause wins against a late downloader completion and cancellation removes files after the worker stops', async () => {
  const f = await fixture();
  await using dir = f.dir;
  using store = f.store;
  const entered = Promise.withResolvers<void>();
  await using queue = new Queue(f.store, f.config, f.providers, async (_sources, directory, _title, signal, progress) => {
    entered.resolve();
    await once(signal, 'abort');
    const file = join(directory, 'late.mp4');
    await writeFile(file, 'late result');
    progress({ bytes: 11, progress: 100 });
    return file;
  });
  const job = queue.add(release, 'tv');
  await entered.promise;
  await queue.pause(job.id);
  assert.equal(f.store.job(job.id)?.status, 'Paused');
  assert.notEqual(f.store.job(job.id)?.progress, 100);
  await queue.remove(job.id, true);
  assert.equal(f.store.job(job.id), undefined);
  await assert.rejects(access(job.storage), { code: 'ENOENT' });
});

test('restart recovers interrupted work without losing per-job pause or global pause', async () => {
  const f = await fixture();
  await using dir = f.dir;
  let store = f.store;
  let queue = new Queue(store, f.config, f.providers, async () => { throw new Error('must remain paused'); });
  try {
    store.paused = true;
    const queued = queue.add(release, 'tv');
    const paused = queue.add({ ...release, id: 'episode-two', episode: 2 }, 'tv', -2);
    store.updateJob(queued.id, { status: 'Downloading', bytes: 123 });
    // Deliberate restart: close and reopen the Store to prove recovery from persisted state.
    await queue.close(); store.close();
    store = new Store(join(f.root, 'state.sqlite'));
    queue = new Queue(store, f.config, f.providers, async () => { throw new Error('must remain paused'); });
    queue.wake();
    assert.equal(store.job(queued.id)?.status, 'Queued');
    assert.equal(store.job(queued.id)?.bytes, 123);
    assert.equal(store.job(paused.id)?.status, 'Paused');
    assert.equal(store.paused, true);
  } finally {
    await queue.close(); store.close();
  }
});

test('authenticated task descriptor identity cannot be changed to another persisted source', async () => {
  const f = await fixture();
  await using dir = f.dir;
  using store = f.store;
  f.store.saveReleases([release, { ...release, id: 'other-id', url: 'https://other.test/private' }]);
  const indexer = new Indexer(f.config, f.store, f.providers, new SeriesBindings(f.store.database));
  const descriptor = indexer.taskDescriptor(release.id).content;
  assert.equal(indexer.parseTaskDescriptor(descriptor).id, release.id);
  assert.throws(() => indexer.parseTaskDescriptor(descriptor.replaceAll(release.id, 'other-id')), /signature/);
  assert.throws(() => indexer.parseTaskDescriptor('<nzb><file/></nzb>'), /not a Usenet client/);
});

test('Sonarr daily queries select the air date without inventing a season-zero episode', async () => {
  const f = await fixture();
  await using dir = f.dir;
  using store = f.store;
  const today: Release = { ...release, id: 'daily', title: '28. 9. 2026', season: undefined, episode: undefined };
  const yesterday: Release = { ...today, id: 'yesterday', title: '27. 9. 2026' };
  const provider = f.providers.get('direct')!;
  provider.catalogue = fakeCatalogue(() => [today, yesterday]);
  const indexer = new Indexer(f.config, f.store, f.providers, new SeriesBindings(f.store.database));
  const feed = await indexer.search({ t: 'tvsearch', q: 'Example', season: '2026', ep: '09/28' }, new AbortController().signal);
  assert.match(feed, /Example 2026\.09\.28 WEB-DL-direct/);
  assert.doesNotMatch(feed, /2026\.09\.27|S00E00/);
  assert.equal(f.store.release('yesterday'), undefined);
  await assert.rejects(indexer.search({ t: 'tvsearch', season: '2026', ep: '02/30' }, new AbortController().signal), /Invalid daily/);
});

test('movie task names use the movie title rather than their source collection', async () => {
  const f = await fixture();
  await using dir = f.dir;
  using store = f.store;
  f.store.saveReleases([{ ...release, id: 'movie', kind: 'movie', title: 'Actual Film', series: 'Film Collection', season: undefined, episode: undefined, year: 2008 }]);
  const indexer = new Indexer(f.config, f.store, f.providers, new SeriesBindings(f.store.database));
  assert.equal(indexer.taskDescriptor('movie').name, 'Actual Film 2008 WEB-DL-direct.nzb');
});

test('Radarr title-and-year queries distinguish films with the same title', async () => {
  const f = await fixture();
  await using dir = f.dir;
  using store = f.store;
  const movie: Release = { id: 'original-film', provider: 'direct', kind: 'movie', title: 'Example Film', year: 2008, url: 'https://example.test/original.mp4' };
  const remake: Release = { ...movie, id: 'remade-film', year: 2024, url: 'https://example.test/remake.mp4' };
  const providers = createProviders({ ...f.config, providers: { direct: { enabled: true, catalog: [movie, remake] } } });
  const indexer = new Indexer(f.config, f.store, new Map([['direct', providers.get('direct')!]]), new SeriesBindings(f.store.database));
  const xml = await indexer.search({ t: 'search', cat: '2000', q: 'Example Film 2008' }, new AbortController().signal);
  assert.match(xml, /<comments>https:\/\/example\.test\/original\.mp4<\/comments>/);
  assert.doesNotMatch(xml, /remake\.mp4/);
});

test('Arr default priority is accepted and duplicate submissions retain their download ID', async () => {
  const f = await fixture();
  await using dir = f.dir;
  using store = f.store;
  await using queue = new Queue(f.store, f.config, f.providers, async () => { throw new Error('must remain paused'); });
  f.store.paused = true;
  f.store.saveReleases([release]);
  const indexer = new Indexer(f.config, f.store, f.providers, new SeriesBindings(f.store.database));
  const sab = new Sabnzbd(f.config, queue, indexer);
  const descriptor = indexer.taskDescriptor(release.id).content;
  const first = await sab.handle({ mode: 'addfile', cat: 'tv', priority: '-100' }, descriptor);
  assert.deepEqual(await sab.handle({ mode: 'addfile', cat: 'tv', priority: '-100' }, descriptor), first);
  assert.equal(f.store.jobs()[0]?.priority, 0);
  await assert.rejects(sab.handle({ mode: 'addfile', cat: '../escape' }, descriptor), /Unknown category/);
  assert.equal(f.store.jobs().length, 1);
});
