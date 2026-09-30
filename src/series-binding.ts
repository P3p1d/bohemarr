import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { searchCatalogue } from './catalogue.ts';
import { loadSeriesIdentity, selectProgram, type SelectionFailure } from './series-identity.ts';
import type { Provider, Release, SearchQuery, SeriesBinding, SeriesIdentity } from './types.ts';

/** Why a provider returns no Releases for a Series identity. */
export type UnboundReason = SelectionFailure | 'program-already-bound' | 'identity-already-bound';

export interface BindingSearch {
  releases: Release[];
  /** Set when the provider is metadata-backed but no Program of it is bound to the identity. */
  unbound?: UnboundReason;
}

export type IdentityLookup = (tvdbId: number, signal: AbortSignal) => Promise<SeriesIdentity>;

/**
 * Series bindings: which Program of each metadata-backed provider is the series a TVDB identity
 * names. A binding is stored only when exactly one Program's own year/country metadata agrees,
 * and once stored it is never reassigned in either direction. Every Release this module returns
 * for a bound Program carries the canonical title and `tvdbId`; nothing else ever does.
 */
export class SeriesBindings {
  private readonly lookupIdentity: IdentityLookup;
  private readonly selectIdentityByTvdbId: StatementSync;
  private readonly insertBinding: StatementSync;
  private readonly selectBindingByIdentity: StatementSync;
  private readonly selectBindingByProgram: StatementSync;

  constructor(db: DatabaseSync, lookupIdentity: IdentityLookup = loadSeriesIdentity) {
    this.lookupIdentity = lookupIdentity;
    // Table and column names predate the Series binding vocabulary; existing databases keep them.
    // The UPDATE converts payloads stored before `source` became `program` (a no-op afterwards).
    db.exec(`CREATE TABLE IF NOT EXISTS series_mappings (
        provider TEXT NOT NULL, source_id TEXT NOT NULL, tvdb_id INTEGER NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(provider, source_id), UNIQUE(provider, tvdb_id)
      );
      UPDATE series_mappings SET payload = json_remove(json_set(payload, '$.program', payload -> '$.source'), '$.source')
        WHERE json_type(payload, '$.source') IS NOT NULL;`);
    if (!db.prepare('PRAGMA table_info(series_mappings)').all().some(column => column.name === 'tmdb_id')) {
      db.exec('ALTER TABLE series_mappings ADD COLUMN tmdb_id INTEGER');
    }
    db.exec(`CREATE INDEX IF NOT EXISTS series_mappings_tmdb ON series_mappings(tmdb_id);
      UPDATE series_mappings SET tmdb_id = json_extract(payload, '$.identity.tmdbId')
        WHERE tmdb_id IS NULL AND json_type(payload, '$.identity.tmdbId') = 'integer';`);
    this.selectIdentityByTvdbId = db.prepare('SELECT payload FROM series_mappings WHERE tvdb_id=? LIMIT 1');
    this.insertBinding = db.prepare('INSERT INTO series_mappings (provider, source_id, tvdb_id, payload, tmdb_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');
    this.selectBindingByIdentity = db.prepare('SELECT payload FROM series_mappings WHERE provider=? AND tvdb_id=?');
    this.selectBindingByProgram = db.prepare('SELECT payload FROM series_mappings WHERE provider=? AND source_id=?');
  }

  /** The Series identity for `tvdbId`: from any stored binding, else from TVDB metadata. */
  async identity(tvdbId: number, signal: AbortSignal): Promise<SeriesIdentity> {
    const row = this.selectIdentityByTvdbId.get(tvdbId);
    const identity = row ? parse(row.payload).identity : await this.lookupIdentity(tvdbId, signal);
    if (identity.tvdbId !== tvdbId) throw new Error('TVDB identity mismatch');
    return identity;
  }

  /**
   * One page of `provider`'s Releases for `query`.
   *
   * With an `identity` and a metadata-backed provider: binds a Program if none is bound yet, then
   * expands only the bound Program; unbound means no Releases. Otherwise: a plain catalogue
   * search (by the identity's title when given), where Releases of already-bound Programs are
   * stamped, and Releases stamped with a different identity are dropped.
   */
  async search(provider: Provider, query: SearchQuery, identity: SeriesIdentity | undefined, signal: AbortSignal): Promise<BindingSearch> {
    if (identity && provider.seriesCandidates) {
      const binding = this.byIdentity(provider.id, identity.tvdbId) ?? await this.bind(provider, identity, signal);
      if (typeof binding === 'string') return { releases: [], unbound: binding };
      const programId = binding.program.id;
      const releases = await searchCatalogue(provider, { ...query, q: '', programId }, signal);
      return {
        releases: releases.filter(release => release.kind === 'tv' && release.programId === programId
          && (release.tvdbId === undefined || release.tvdbId === identity.tvdbId)).map(release => stamp(release, binding.identity)),
      };
    }

    const releases = (await searchCatalogue(provider, identity ? { ...query, q: identity.title } : query, signal)).map(release => {
      const binding = release.kind === 'tv' && release.programId ? this.byProgram(provider.id, release.programId) : undefined;
      return binding ? stamp(release, binding.identity) : release;
    });
    return { releases: identity ? releases.filter(release => release.tvdbId === undefined || release.tvdbId === identity.tvdbId) : releases };
  }

  private async bind(provider: Provider, identity: SeriesIdentity, signal: AbortSignal): Promise<SeriesBinding | UnboundReason> {
    const selection = selectProgram(identity, await provider.seriesCandidates!(identity, signal));
    if ('reason' in selection) return selection.reason;
    const binding: SeriesBinding = { provider: provider.id, program: selection.program, identity };
    this.insertBinding.run(provider.id, binding.program.id, identity.tvdbId, JSON.stringify(binding), identity.tmdbId ?? null);
    // The constraints refuse either reassignment; the stored row tells which one happened.
    const stored = this.byIdentity(provider.id, identity.tvdbId);
    if (stored?.program.id === binding.program.id) return stored;
    return stored ? 'identity-already-bound' : 'program-already-bound';
  }

  private byIdentity(provider: string, tvdbId: number): SeriesBinding | undefined {
    const row = this.selectBindingByIdentity.get(provider, tvdbId);
    return row ? parse(row.payload) : undefined;
  }

  private byProgram(provider: string, programId: string): SeriesBinding | undefined {
    const row = this.selectBindingByProgram.get(provider, programId);
    return row ? parse(row.payload) : undefined;
  }
}

function parse(payload: unknown): SeriesBinding {
  return JSON.parse(String(payload)) as SeriesBinding;
}

function stamp(release: Release, identity: SeriesIdentity): Release {
  return { ...release, series: identity.title, tvdbId: identity.tvdbId };
}
