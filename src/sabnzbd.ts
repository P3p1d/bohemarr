import { basename } from 'node:path';
import { Queue } from './queue.ts';
import { Indexer } from './indexer.ts';
import { releaseTitle } from './providers/common.ts';
import type { Config, Job } from './types.ts';

export class Sabnzbd {
  private readonly config: Config;
  private readonly queue: Queue;
  private readonly indexer: Indexer;

  constructor(config: Config, queue: Queue, indexer: Indexer) {
    this.config = config;
    this.queue = queue;
    this.indexer = indexer;
  }

  async handle(params: Record<string, string>, upload?: string): Promise<unknown> {
    const mode = params.mode;
    const name = params.name;
    const store = this.queue.store;
    if (mode === 'version') return { version: '4.5.0-bohemarr' };
    if (mode === 'get_config') return { config: {
      misc: {
        complete_dir: this.config.downloadsDir, download_dir: this.config.downloadsDir,
        pre_check: false, history_retention: '', history_retention_option: 'all', history_retention_number: 0,
        enable_tv_sorting: false, enable_movie_sorting: false, enable_date_sorting: false,
      },
      categories: this.config.categories.map(category => ({ name: category, dir: category, pp: '0', script: 'None', priority: 0 })),
      sorters: [], servers: [],
    } };
    if (mode === 'fullstatus') return { status: {
      version: '4.5.0-bohemarr', complete_dir: this.config.downloadsDir, download_dir: this.config.downloadsDir,
      paused: store.paused, warnings: [],
    } };
    if (mode === 'get_cats') return { categories: this.config.categories };
    if (mode === 'addfile' || mode === 'addurl') {
      let content = upload;
      if (mode === 'addurl') {
        const url = new URL(params.name || '');
        const expected = new URL(this.config.publicUrl);
        if (url.origin !== expected.origin || url.pathname !== '/newznab/api' || url.searchParams.get('t') !== 'get') {
          throw new Error('Only this instance\'s task URLs can be submitted');
        }
        content = this.indexer.taskDescriptor(url.searchParams.get('id') || '').content;
      }
      if (!content) throw new Error('Missing task descriptor upload');
      const release = this.indexer.parseTaskDescriptor(content);
      const category = params.cat || (release.kind === 'movie' ? 'movies' : 'tv');
      const requestedPriority = Number(params.priority || 0);
      const priority = requestedPriority === -100 ? 0 : requestedPriority;
      if (!Number.isInteger(priority) || priority < -2 || priority > 2) throw new Error('Invalid priority');
      const job = this.queue.add(release, category, priority);
      return { status: true, nzo_ids: [job.id] };
    }
    if (mode === 'pause' || mode === 'resume') {
      if (mode === 'pause') await this.queue.pause(); else this.queue.resume();
      return { status: true };
    }
    if (mode === 'retry') return { status: true, nzo_ids: [this.queue.retry(params.value || '').id], id: params.value };
    if ((mode === 'queue' || mode === 'history') && name) {
      const ids = (params.value || '').split(',').filter(Boolean);
      if (!ids.length) throw new Error('Missing download ID');
      if (name === 'delete') {
        for (const id of ids) await this.queue.remove(id, params.del_files === '1');
        return { status: true, nzo_ids: ids };
      }
      if (mode === 'queue' && (name === 'pause' || name === 'resume')) {
        for (const id of ids) {
          if (name === 'pause') await this.queue.pause(id); else this.queue.resume(id);
        }
        return { status: true };
      }
      throw new Error(`Unsupported ${mode} action: ${name}`);
    }
    if (mode === 'queue' || mode === 'history') {
      const history = mode === 'history';
      const jobs = store.jobs().filter(job => ['Completed', 'Failed'].includes(job.status) === history)
        .filter(job => !params.category || job.category === params.category);
      if (history) jobs.sort((a, b) => (b.finishedAt || b.updatedAt) - (a.finishedAt || a.updatedAt));
      const start = Number(params.start || 0);
      const limit = Number(params.limit || 0);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(limit) || start < 0 || limit < 0) throw new Error('Invalid pagination');
      const page = jobs.slice(start, limit ? start + limit : undefined);
      if (history) return { history: {
        slots: page.map(job => ({
          nzo_id: job.id, name: releaseTitle(job.release), nzb_name: `${releaseTitle(job.release)}.nzb`,
          category: job.category, status: job.status, bytes: job.bytes, storage: job.storage,
          path: job.storage, fail_message: job.error, completed: Math.floor((job.finishedAt || job.updatedAt) / 1000),
          download_time: Math.max(0, Math.floor(((job.finishedAt || job.updatedAt) - job.createdAt) / 1000)),
          downloaded: job.bytes,
        })), noofslots: jobs.length,
      } };
      return { queue: {
        status: store.paused ? 'Paused' : jobs.some(job => job.status === 'Downloading') ? 'Downloading' : 'Idle',
        paused: store.paused, slots: page.map((job, index) => this.slot(job, start + index)),
        noofslots: jobs.length, noofslots_total: jobs.length,
        mb: String(jobs.reduce((total, job) => total + job.totalBytes, 0) / 1048576),
        mbleft: String(jobs.reduce((total, job) => total + Math.max(0, job.totalBytes - job.bytes), 0) / 1048576),
        kbpersec: '0', timeleft: '0:00:00', diskspace1: '0', diskspace2: '0',
        diskspace1_norm: 'unknown', diskspace2_norm: 'unknown',
        diskspacetotal1: '0', diskspacetotal2: '0',
        have_warnings: '0', version: '4.5.0-bohemarr', default_root: this.config.downloadsDir,
        categories: this.config.categories,
      } };
    }
    throw new Error(`Unsupported SABnzbd mode: ${mode || '(missing)'}`);
  }

  private slot(job: Job, index: number): object {
    return {
      nzo_id: job.id, filename: releaseTitle(job.release), status: job.status, cat: job.category,
      index, priority: String(job.priority), percentage: String(Math.floor(job.progress)),
      mb: String(job.totalBytes / 1048576), mbleft: String(Math.max(0, job.totalBytes - job.bytes) / 1048576),
      timeleft: '0:00:00', size: String(job.totalBytes), sizeleft: String(Math.max(0, job.totalBytes - job.bytes)),
      storage: basename(job.storage),
    };
  }
}
