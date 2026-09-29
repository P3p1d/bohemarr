import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import { SeriesBindings, type IdentityLookup } from '../src/series-binding.ts';
import type { ProgramMetadata, Provider, Release, SearchQuery, SeriesIdentity } from '../src/types.ts';
import { fakeCatalogue } from './fake-catalogue.ts';

const signal = new AbortController().signal;
const identity: SeriesIdentity = { tvdbId: 12345, title: 'Show Name', aliases: ['Alt Name'], year: 2020, country: 'US' };
const other: SeriesIdentity = { tvdbId: 22222, title: 'Show Name', aliases: [], year: 2020, country: 'US' };
const correct: ProgramMetadata = { id: 'src-correct', title: 'Show Name', aliases: [], year: 2020, countries: ['US'] };
const foreign: ProgramMetadata = { id: 'src-foreign', title: 'Show Name', aliases: [], year: 2020, countries: ['GB'] };
const query: SearchQuery = { q: '', kind: 'tv', limit: 50, offset: 0 };

function episode(program: string, overrides: Partial<Release> = {}): Release {
  return {
    id: `${program}-ep1`, provider: 'oneplay', title: 'Show Name - S01E01', series: 'Show Name (provider title)',
    kind: 'tv', season: 1, episode: 1, url: `https://oneplay.test/${program}/stream.mp4`, programId: program, ...overrides,
  };
}

/** A metadata-backed provider whose Programs each hold one episode. */
function provider(candidates: (wanted: SeriesIdentity) => ProgramMetadata[] | Promise<ProgramMetadata[]>, overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'oneplay', name: 'Oneplay', resolve: async () => [],
    seriesCandidates: async wanted => candidates(wanted),
    catalogue: fakeCatalogue(bound => bound ? [episode(bound)] : [episode(correct.id), episode(foreign.id)]),
    ...overrides,
  };
}

const failingLookup: IdentityLookup = async () => { throw new Error('TVDB lookup must not be needed'); };

async function withStore(run: (store: Store) => Promise<void>): Promise<void> {
  using store = new Store(':memory:');
  await run(store);
}

test('binds the Program whose own metadata agrees and expands only it, stamped with the canonical identity', async () => {
  await withStore(async store => {
    const bindings = new SeriesBindings(store.database);
    const { releases, unbound } = await bindings.search(provider(() => [foreign, correct]), query, identity, signal);
    assert.equal(unbound, undefined);
    assert.deepEqual(releases.map(r => [r.id, r.series, r.tvdbId, r.url]), [
      ['src-correct-ep1', 'Show Name', 12345, 'https://oneplay.test/src-correct/stream.mp4'],
    ]);
  });
});

test('an unbound identity returns nothing and says why, and stores no binding', async () => {
  await withStore(async store => {
    const bindings = new SeriesBindings(store.database);
    const twin = { ...correct, id: 'src-twin' };
    assert.deepEqual(await bindings.search(provider(() => [correct, twin]), query, identity, signal), { releases: [], unbound: 'ambiguous' });
    // Nothing was stored: a later, unambiguous listing still binds.
    const { releases } = await bindings.search(provider(() => [correct]), query, identity, signal);
    assert.deepEqual(releases.map(r => r.id), ['src-correct-ep1']);
  });
});

test('a stored binding survives a restart and needs neither TVDB metadata nor the provider\'s candidates', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'md-binding-'));
  const path = join(dir.path, 'state.sqlite');
  const store = new Store(path);
  await new SeriesBindings(store.database).search(provider(() => [correct]), query, identity, signal);
  // Deliberate restart: close and reopen the Store to prove the binding was persisted.
  store.close();
  using reopened = new Store(path);
  const bindings = new SeriesBindings(reopened.database, failingLookup);
  assert.deepEqual(await bindings.identity(identity.tvdbId, signal), identity);
  const { releases } = await bindings.search(provider(() => { throw new Error('must not be asked'); }), query, identity, signal);
  assert.deepEqual(releases.map(r => r.tvdbId), [identity.tvdbId]);
});

test('a bound Program is never reassigned to a second identity', async () => {
  await withStore(async store => {
    const bindings = new SeriesBindings(store.database);
    await bindings.search(provider(() => [correct]), query, identity, signal);
    assert.deepEqual(await bindings.search(provider(() => [correct]), query, other, signal), { releases: [], unbound: 'program-already-bound' });
  });
});

test('an identity is never rebound when two searches bind it concurrently to different Programs', async () => {
  await withStore(async store => {
    const bindings = new SeriesBindings(store.database);
    const second = { ...correct, id: 'src-second' };
    const firstListed = Promise.withResolvers<void>();
    const firstStored = Promise.withResolvers<void>();
    const racing = bindings.search(provider(async () => { firstListed.resolve(); await firstStored.promise; return [second]; }), query, identity, signal);
    await firstListed.promise; // the second search has checked for a binding and is now listing candidates
    const first = await bindings.search(provider(() => [correct]), query, identity, signal);
    firstStored.resolve();
    assert.deepEqual(first.releases.map(r => r.id), ['src-correct-ep1']);
    assert.deepEqual(await racing, { releases: [], unbound: 'identity-already-bound' });
  });
});

test('a Release claiming another Program is not stamped with the bound identity', async () => {
  await withStore(async store => {
    const bindings = new SeriesBindings(store.database);
    const spoofing = provider(() => [correct], { catalogue: fakeCatalogue(bound => bound ? [episode('src-not-bound', { id: 'spoofed' })] : []) });
    assert.deepEqual(await bindings.search(spoofing, query, identity, signal), { releases: [] });
  });
});

test('a plain text search stamps Releases of bound Programs and leaves others alone', async () => {
  await withStore(async store => {
    const bindings = new SeriesBindings(store.database);
    await bindings.search(provider(() => [correct]), query, identity, signal);
    const { releases } = await bindings.search(provider(() => []), { ...query, q: 'Show Name' }, undefined, signal);
    assert.deepEqual(releases.map(r => [r.id, r.tvdbId, r.series]), [
      ['src-correct-ep1', 12345, 'Show Name'],
      ['src-foreign-ep1', undefined, 'Show Name (provider title)'],
    ]);
  });
});

test('a provider without metadata is searched by the identity title and never labelled with it', async () => {
  await withStore(async store => {
    const bindings = new SeriesBindings(store.database);
    const plain = provider(() => [], { seriesCandidates: undefined });
    const { releases, unbound } = await bindings.search(plain, query, identity, signal);
    assert.equal(unbound, undefined);
    assert.deepEqual(releases.map(r => [r.id, r.tvdbId]), [['src-correct-ep1', undefined], ['src-foreign-ep1', undefined]]);
  });
});

test('the identity is checked against the requested TVDB id', async () => {
  await withStore(async store => {
    const bindings = new SeriesBindings(store.database, async () => ({ ...identity, tvdbId: 999 }));
    await assert.rejects(bindings.identity(identity.tvdbId, signal), /TVDB identity mismatch/);
  });
});

test('bindings and queued jobs stored before the program-id rename keep working', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'md-binding-legacy-'));
  const path = join(dir.path, 'state.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE releases (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE series_mappings (provider TEXT NOT NULL, source_id TEXT NOT NULL, tvdb_id INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(provider, source_id), UNIQUE(provider, tvdb_id));`);
  const legacyRelease = { ...episode(correct.id), programId: undefined, sourceSeriesId: correct.id };
  legacy.prepare('INSERT INTO releases VALUES (?, ?)').run(legacyRelease.id, JSON.stringify(legacyRelease));
  legacy.prepare('INSERT INTO jobs VALUES (?, ?)').run('job', JSON.stringify({ id: 'job', release: legacyRelease }));
  legacy.prepare('INSERT INTO series_mappings VALUES (?, ?, ?, ?)')
    .run('oneplay', correct.id, identity.tvdbId, JSON.stringify({ provider: 'oneplay', source: correct, identity }));
  // The legacy DB must be closed before the Store opens the same file.
  legacy.close();

  using store = new Store(path);
  assert.equal(store.release(legacyRelease.id)?.programId, correct.id);
  assert.equal(store.job('job')?.release.programId, correct.id);
  const bindings = new SeriesBindings(store.database, failingLookup);
  const { releases } = await bindings.search(provider(() => { throw new Error('must not be asked'); }), query, identity, signal);
  assert.deepEqual(releases.map(r => r.tvdbId), [identity.tvdbId]);
});
