import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import type { Job, Release } from './types.ts';

const DATABASE_FILE = 'bohemarr.sqlite';
/** The file name used before the project was named Bohemarr. */
const LEGACY_DATABASE_FILE = 'media-downloader.sqlite';

/**
 * The SQLite database path inside `dataDir`. A database left by an installation from before the
 * rename (with its WAL/SHM companions) is moved into place once, so queue history and Series
 * bindings survive the upgrade.
 */
export async function databasePath(dataDir: string): Promise<string> {
  const path = join(dataDir, DATABASE_FILE);
  const legacy = join(dataDir, LEGACY_DATABASE_FILE);
  if (!existsSync(path) && existsSync(legacy)) {
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(legacy + suffix)) await rename(legacy + suffix, path + suffix);
    }
    await rename(legacy, path);
  }
  return path;
}

/** Ordered one-time rewrites of stored payloads; `settings.schema_version` counts those applied. */
const MIGRATIONS: readonly string[] = [
  // `sourceSeriesId` became `programId`.
  `UPDATE releases SET payload = json_remove(json_set(payload, '$.programId', payload -> '$.sourceSeriesId'), '$.sourceSeriesId')
     WHERE json_type(payload, '$.sourceSeriesId') IS NOT NULL;
   UPDATE jobs SET payload = json_remove(json_set(payload, '$.release.programId', payload -> '$.release.sourceSeriesId'), '$.release.sourceSeriesId')
     WHERE json_type(payload, '$.release.sourceSeriesId') IS NOT NULL;`,
];

export class Store {
  private readonly db: DatabaseSync;
  private readonly insertRelease: StatementSync;
  private readonly selectRelease: StatementSync;
  private readonly selectJobs: StatementSync;
  private readonly selectJob: StatementSync;
  private readonly insertJob: StatementSync;
  private readonly deleteJob: StatementSync;
  private readonly selectPaused: StatementSync;
  private readonly upsertPaused: StatementSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.migrate();
    this.insertRelease = this.db.prepare('INSERT INTO releases VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
    this.selectRelease = this.db.prepare('SELECT payload FROM releases WHERE id=?');
    this.selectJobs = this.db.prepare('SELECT payload FROM jobs');
    this.selectJob = this.db.prepare('SELECT payload FROM jobs WHERE id=?');
    this.insertJob = this.db.prepare('INSERT INTO jobs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload');
    this.deleteJob = this.db.prepare('DELETE FROM jobs WHERE id=?');
    this.selectPaused = this.db.prepare("SELECT value FROM settings WHERE key='paused'");
    this.upsertPaused = this.db.prepare("INSERT INTO settings VALUES ('paused', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  }

  /** The shared connection, for modules that own their own tables (e.g. Series bindings). */
  get database(): DatabaseSync {
    return this.db;
  }

  private migrate(): void {
    const applied = Number(this.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()?.value ?? 0);
    for (let version = applied; version < MIGRATIONS.length; version++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[version]!);
        this.db.prepare("INSERT INTO settings VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(String(version + 1));
      });
    }
  }

  private transaction(work: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      work();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveReleases(releases: Release[]): void {
    this.transaction(() => {
      for (const release of releases) this.insertRelease.run(release.id, JSON.stringify(release));
    });
  }

  release(id: string): Release | undefined {
    const row = this.selectRelease.get(id);
    return row ? JSON.parse(String(row.payload)) as Release : undefined;
  }

  jobs(): Job[] {
    return this.selectJobs.all().map(row => JSON.parse(String(row.payload)) as Job)
      .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  job(id: string): Job | undefined {
    const row = this.selectJob.get(id);
    return row ? JSON.parse(String(row.payload)) as Job : undefined;
  }

  saveJob(job: Job): void {
    this.insertJob.run(job.id, JSON.stringify(job));
  }

  updateJob(id: string, update: Partial<Job>): Job | undefined {
    const job = this.job(id);
    if (!job) return undefined;
    const updated = { ...job, ...update, id, updatedAt: Date.now() };
    this.saveJob(updated);
    return updated;
  }

  removeJob(id: string): void {
    this.deleteJob.run(id);
  }

  get paused(): boolean {
    return this.selectPaused.get()?.value === 'true';
  }

  set paused(value: boolean) {
    this.upsertPaused.run(String(value));
  }

  close(): void {
    this.db.close();
  }

  [Symbol.dispose](): void {
    if (this.db.isOpen) this.db.close();
  }
}
