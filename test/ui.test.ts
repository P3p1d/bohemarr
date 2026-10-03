import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempDisposable, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Queue } from '../src/queue.ts';
import { createServer } from '../src/server.ts';
import { fakeCatalogue } from './fake-catalogue.ts';
import type { Config, Provider, Release } from '../src/types.ts';

const testRelease: Release = {
  id: 'test-release-1',
  provider: 'mockprovider',
  title: 'Test Show S01E01',
  series: 'Test Show',
  kind: 'tv',
  season: 1,
  episode: 1,
  url: 'https://mock.test/video1.mp4',
};

async function testFixture() {
  const dir = await mkdtempDisposable(join(tmpdir(), 'bohemarr-ui-test-'));
  const config: Config = {
    host: '127.0.0.1',
    port: 8787,
    apiKey: '0123456789abcdef0123456789abcdef',
    publicUrl: 'http://localhost:8787',
    dataDir: dir.path,
    downloadsDir: join(dir.path, 'downloads'),
    concurrency: 1,
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    mp4decrypt: 'mp4decrypt',
    wvApiUrl: 'https://example.test/wv/',
    categories: ['tv', 'movies'],
    providers: {},
  };

  const store = new Store(join(dir.path, 'state.sqlite'));

  const provider: Provider = {
    id: 'mockprovider',
    name: 'Mock Provider',
    catalogue: fakeCatalogue(() => [testRelease]),
    resolve: async () => [{ url: testRelease.url, type: 'file' }],
    resolveUrl: async (url) => {
      if (url.hostname === 'mock.test') {
        return {
          title: 'Resolved Test Show',
          kind: 'tv',
          releases: [testRelease],
        };
      }
      return undefined;
    },
  };

  const providers = new Map([[provider.id, provider]]);
  const queue = new Queue(store, config, providers, async (_sources, directory, _title, _signal, progress) => {
    await mkdir(directory, { recursive: true });
    const file = join(directory, 'test-video.mp4');
    await writeFile(file, 'SAMPLE-VIDEO-CONTENT-12345');
    progress({ bytes: 25, progress: 100 });
    return file;
  });

  const app = await createServer(config, store, queue, providers);

  return { dir, config, store, queue, providers, app };
}

test('UI: static files / and /ui/* are accessible without API key', async () => {
  const f = await testFixture();
  await using dir = f.dir;
  using store = f.store;
  await using queue = f.queue;
  await using app = f.app;

  // Root HTML
  const rootRes = await app.inject({ method: 'GET', url: '/' });
  assert.equal(rootRes.statusCode, 200);
  assert.match(rootRes.headers['content-type'] || '', /text\/html/);
  assert.match(rootRes.body, /Bohemarr/);

  // CSS file
  const cssRes = await app.inject({ method: 'GET', url: '/ui/app.css' });
  assert.equal(cssRes.statusCode, 200);
  assert.match(cssRes.headers['content-type'] || '', /text\/css/);

  // JS file
  const jsRes = await app.inject({ method: 'GET', url: '/ui/app.js' });
  assert.equal(jsRes.statusCode, 200);
  assert.match(jsRes.headers['content-type'] || '', /javascript/);

  // Health endpoint
  const healthRes = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(healthRes.statusCode, 200);
});

test('UI: /api/ui/auth verifies API key in header and query', async () => {
  const f = await testFixture();
  await using dir = f.dir;
  using store = f.store;
  await using queue = f.queue;
  await using app = f.app;

  // Without key -> 401
  const noKeyRes = await app.inject({ method: 'GET', url: '/api/ui/auth' });
  assert.equal(noKeyRes.statusCode, 401);

  // Wrong key -> 401
  const wrongKeyRes = await app.inject({
    method: 'GET',
    url: '/api/ui/auth',
    headers: { 'x-api-key': 'wrong-key-value' },
  });
  assert.equal(wrongKeyRes.statusCode, 401);

  // Correct key in x-api-key header -> 200
  const headerRes = await app.inject({
    method: 'GET',
    url: '/api/ui/auth',
    headers: { 'x-api-key': f.config.apiKey },
  });
  assert.equal(headerRes.statusCode, 200);
  const headerData = JSON.parse(headerRes.body);
  assert.equal(headerData.status, true);

  // Correct key in apikey query param -> 200
  const queryRes = await app.inject({
    method: 'GET',
    url: `/api/ui/auth?apikey=${encodeURIComponent(f.config.apiKey)}`,
  });
  assert.equal(queryRes.statusCode, 200);
});

test('UI: config and providers endpoints return current configuration', async () => {
  const f = await testFixture();
  await using dir = f.dir;
  using store = f.store;
  await using queue = f.queue;
  await using app = f.app;

  const authHeader = { 'x-api-key': f.config.apiKey };

  // /api/ui/config
  const configRes = await app.inject({ method: 'GET', url: '/api/ui/config', headers: authHeader });
  assert.equal(configRes.statusCode, 200);
  const configData = JSON.parse(configRes.body);
  assert.deepEqual(configData.categories, ['tv', 'movies']);
  assert.equal(configData.version, '1.2.0');

  // /api/ui/version
  const verRes = await app.inject({ method: 'GET', url: '/api/ui/version', headers: authHeader });
  assert.equal(verRes.statusCode, 200);
  const verData = JSON.parse(verRes.body);
  assert.equal(verData.version, '1.2.0');
  assert.equal(typeof verData.build, 'string');

  // /api/ui/providers
  const provRes = await app.inject({ method: 'GET', url: '/api/ui/providers', headers: authHeader });
  assert.equal(provRes.statusCode, 200);
  const provData = JSON.parse(provRes.body);
  assert.equal(provData.length, 1);
  assert.equal(provData[0].id, 'mockprovider');
  assert.equal(provData[0].name, 'Mock Provider');
  assert.equal(provData[0].hasUrlResolve, true);
});

test('UI: resolve-url identifies provider and returns releases', async () => {
  const f = await testFixture();
  await using dir = f.dir;
  using store = f.store;
  await using queue = f.queue;
  await using app = f.app;

  const authHeader = { 'x-api-key': f.config.apiKey };

  // Unsupported URL -> 404
  const badRes = await app.inject({
    method: 'POST',
    url: '/api/ui/resolve-url',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://unsupported-site.test/video' }),
  });
  assert.equal(badRes.statusCode, 404);

  // Supported URL -> 200
  const goodRes = await app.inject({
    method: 'POST',
    url: '/api/ui/resolve-url',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://mock.test/show/1' }),
  });
  assert.equal(goodRes.statusCode, 200);
  const data = JSON.parse(goodRes.body);
  assert.equal(data.success, true);
  assert.equal(data.provider, 'mockprovider');
  assert.equal(data.title, 'Resolved Test Show');
  assert.equal(data.releases.length, 1);
  assert.equal(data.releases[0].id, testRelease.id);

  // Release was saved into store
  assert.ok(f.store.release(testRelease.id));
});

test('UI: queue lifecycle and direct file download with HTTP Range', async () => {
  const f = await testFixture();
  await using dir = f.dir;
  using store = f.store;
  await using queue = f.queue;
  await using app = f.app;

  const authHeader = { 'x-api-key': f.config.apiKey };

  // 1. Add release to queue
  const addRes = await app.inject({
    method: 'POST',
    url: '/api/ui/queue',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ release: testRelease, category: 'tv' }),
  });
  assert.equal(addRes.statusCode, 200);
  const addData = JSON.parse(addRes.body);
  assert.equal(addData.success, true);
  const jobId = addData.jobId;
  assert.ok(jobId);

  // 2. Queue list shows the job
  const queueRes = await app.inject({ method: 'GET', url: '/api/ui/queue', headers: authHeader });
  assert.equal(queueRes.statusCode, 200);
  const queueData = JSON.parse(queueRes.body);
  assert.ok(queueData.jobs.some((j: any) => j.id === jobId));

  // 3. Pause and Resume queue
  const pauseRes = await app.inject({
    method: 'POST',
    url: '/api/ui/queue/pause',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ id: jobId }),
  });
  assert.equal(pauseRes.statusCode, 200);

  const resumeRes = await app.inject({
    method: 'POST',
    url: '/api/ui/queue/resume',
    headers: { ...authHeader, 'content-type': 'application/json' },
    body: JSON.stringify({ id: jobId }),
  });
  assert.equal(resumeRes.statusCode, 200);

  // Wait a moment for download task to complete
  await new Promise(res => setTimeout(res, 200));

  // 4. Check completed downloads
  const downRes = await app.inject({ method: 'GET', url: '/api/ui/downloads', headers: authHeader });
  assert.equal(downRes.statusCode, 200);
  const downData = JSON.parse(downRes.body);
  const completedJob = downData.downloads.find((d: any) => d.id === jobId);
  assert.ok(completedJob);
  assert.equal(completedJob.status, 'Completed');
  assert.ok(completedJob.filePath);

  // 5. Download file directly via /api/ui/files/:id
  const fileRes = await app.inject({
    method: 'GET',
    url: `/api/ui/files/${jobId}`,
    headers: authHeader,
  });
  assert.equal(fileRes.statusCode, 200);
  assert.equal(fileRes.body, 'SAMPLE-VIDEO-CONTENT-12345');
  assert.equal(fileRes.headers['content-type'], 'video/mp4');

  // 6. Test HTTP Range request (e.g. first 6 bytes: 'SAMPLE')
  const rangeRes = await app.inject({
    method: 'GET',
    url: `/api/ui/files/${jobId}`,
    headers: { ...authHeader, range: 'bytes=0-5' },
  });
  assert.equal(rangeRes.statusCode, 206);
  assert.equal(rangeRes.body, 'SAMPLE');
  assert.equal(rangeRes.headers['content-range'], 'bytes 0-5/26');
  assert.equal(rangeRes.headers['content-length'], '6');
});
