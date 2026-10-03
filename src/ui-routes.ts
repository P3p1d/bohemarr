import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, basename } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config, Job, MediaKind, Provider, Release, SearchQuery } from './types.ts';
import type { Store } from './store.ts';
import type { Queue } from './queue.ts';
import type { Indexer } from './indexer.ts';
import { releaseTitle, sanitizeFilename } from './providers/common.ts';
import { searchCatalogue } from './catalogue.ts';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.ts': 'video/mp2t',
  '.avi': 'video/x-msvideo',
};

function getUiDir(): string {
  const candidate1 = resolve(import.meta.dirname, 'ui');
  if (existsSync(candidate1)) return candidate1;
  const candidate2 = resolve(import.meta.dirname, '../src/ui');
  if (existsSync(candidate2)) return candidate2;
  return candidate1;
}

export async function findJobFile(storagePath: string): Promise<string | undefined> {
  try {
    const s = await stat(storagePath);
    if (s.isFile()) return storagePath;
    const entries = await readdir(storagePath, { withFileTypes: true, recursive: true });
    const files = entries.filter(e => e.isFile());
    if (!files.length) return undefined;
    const video = files.find(f => /\.(mp4|mkv|webm|ts|avi)$/i.test(f.name));
    const target = video || files[0]!;
    return join(target.parentPath || storagePath, target.name);
  } catch {
    return undefined;
  }
}

export function registerUiRoutes(
  app: FastifyInstance,
  config: Config,
  store: Store,
  queue: Queue,
  providers: Map<string, Provider>,
  indexer: Indexer,
): void {
  const uiDir = getUiDir();

  // 1. Static WebUI files
  const serveStaticFile = async (filePath: string, reply: FastifyReply) => {
    try {
      if (!existsSync(filePath)) {
        return await reply.code(404).type('text/plain').send('Not Found');
      }
      const ext = extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const content = await readFile(filePath);
      return await reply.type(mime).send(content);
    } catch (err) {
      return await reply.code(500).type('text/plain').send('Error reading file');
    }
  };

  app.get('/', async (_request, reply) => {
    return serveStaticFile(join(uiDir, 'index.html'), reply);
  });

  app.get('/ui/:file', async (request: FastifyRequest<{ Params: { file: string } }>, reply) => {
    const fileName = basename(request.params.file);
    return serveStaticFile(join(uiDir, fileName), reply);
  });

  app.get('/assets/:file', async (request: FastifyRequest<{ Params: { file: string } }>, reply) => {
    const fileName = basename(request.params.file);
    return serveStaticFile(join(uiDir, fileName), reply);
  });

  // 2. Auth check endpoint
  app.get('/api/ui/auth', async () => {
    return { status: true, version: '1.0.0' };
  });

  // 3. UI config & providers
  app.get('/api/ui/config', async () => {
    return {
      categories: config.categories,
      downloadsDir: config.downloadsDir,
    };
  });

  app.get('/api/ui/providers', async () => {
    return [...providers.values()].map(p => ({
      id: p.id,
      name: p.name,
      hasUrlResolve: typeof p.resolveUrl === 'function' || typeof p.catalogue.releaseForUrl === 'function',
    }));
  });

  // 4. Search across providers
  app.get('/api/ui/search', async (request: FastifyRequest<{ Querystring: { q?: string; category?: string; provider?: string } }>, reply) => {
    const q = (request.query.q || '').trim();
    if (!q) return { results: [] };

    const cat = request.query.category?.toLowerCase();
    const kind: MediaKind | undefined = cat === 'tv' ? 'tv' : cat === 'movie' || cat === 'movies' ? 'movie' : undefined;
    const providerFilter = request.query.provider;

    const enabled = [...providers.values()].filter(p => !providerFilter || p.id === providerFilter);
    if (!enabled.length) return { results: [] };

    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);

    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
      const query: SearchQuery = { q, kind, limit: 30, offset: 0 };

      const searches = await Promise.allSettled(
        enabled.map(async p => {
          const releases = await searchCatalogue(p, query, signal);
          for (const release of releases.slice(0, 10)) {
            await indexer.enrich(release, signal);
          }
          return releases;
        }),
      );

      const allReleases: Release[] = [];
      for (const res of searches) {
        if (res.status === 'fulfilled') {
          allReleases.push(...res.value);
        }
      }

      store.saveReleases(allReleases);

      // Check current queue status for each release
      const currentJobs = store.jobs();
      const annotated = allReleases.map(rel => {
        const matchingJob = currentJobs.find(j => j.release.id === rel.id);
        return {
          ...rel,
          inQueue: Boolean(matchingJob && matchingJob.status !== 'Completed' && matchingJob.status !== 'Failed'),
          status: matchingJob?.status ?? null,
          jobId: matchingJob?.id ?? null,
        };
      });

      return { query: q, results: annotated };
    } finally {
      reply.raw.removeListener('close', onClose);
    }
  });

  // 5. Direct URL resolver
  const handleResolveUrl = async (rawUrl: string, reply: FastifyReply) => {
    if (!rawUrl || !rawUrl.trim()) {
      return reply.code(400).send({ success: false, error: 'Chybí URL adresa' });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl.trim());
    } catch {
      return reply.code(400).send({ success: false, error: 'Neplatný formát URL adresy' });
    }

    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);

    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);

      // Check all active providers
      for (const provider of providers.values()) {
        try {
          if (typeof provider.resolveUrl === 'function') {
            const resolved = await provider.resolveUrl(parsedUrl, signal);
            if (resolved && resolved.releases.length) {
              store.saveReleases(resolved.releases);
              const currentJobs = store.jobs();
              const releasesWithStatus = resolved.releases.map(rel => {
                const job = currentJobs.find(j => j.release.id === rel.id);
                return {
                  ...rel,
                  inQueue: Boolean(job && job.status !== 'Completed' && job.status !== 'Failed'),
                  isCompleted: Boolean(job && job.status === 'Completed'),
                  status: job?.status ?? null,
                  jobId: job?.id ?? null,
                };
              });

              return {
                success: true,
                provider: provider.id,
                providerName: provider.name,
                title: resolved.title,
                kind: resolved.kind,
                releases: releasesWithStatus,
              };
            }
          }

          if (typeof provider.catalogue.releaseForUrl === 'function') {
            const release = await provider.catalogue.releaseForUrl(parsedUrl, { q: '' }, signal);
            if (release) {
              await indexer.enrich(release, signal);
              store.saveReleases([release]);
              const currentJobs = store.jobs();
              const job = currentJobs.find(j => j.release.id === release.id);
              return {
                success: true,
                provider: provider.id,
                providerName: provider.name,
                title: releaseTitle(release),
                kind: release.kind,
                releases: [
                  {
                    ...release,
                    inQueue: Boolean(job && job.status !== 'Completed' && job.status !== 'Failed'),
                    isCompleted: Boolean(job && job.status === 'Completed'),
                    status: job?.status ?? null,
                    jobId: job?.id ?? null,
                  },
                ],
              };
            }
          }
        } catch (err) {
          // Provider rejected this URL or couldn't resolve; try next provider
        }
      }

      return reply.code(404).send({
        success: false,
        error: 'Žádný aktivní provider nedokázal zadanou URL adresu zpracovat.',
      });
    } finally {
      reply.raw.removeListener('close', onClose);
    }
  };

  app.get('/api/ui/resolve-url', async (request: FastifyRequest<{ Querystring: { url?: string } }>, reply) => {
    return handleResolveUrl(request.query.url || '', reply);
  });

  app.post('/api/ui/resolve-url', async (request: FastifyRequest<{ Body: { url?: string } }>, reply) => {
    return handleResolveUrl(request.body?.url || '', reply);
  });

  // 6. Queue management
  app.get('/api/ui/queue', async () => {
    const jobs = store.jobs()
      .filter(j => j.status === 'Queued' || j.status === 'Downloading' || j.status === 'Paused');

    return {
      paused: store.paused,
      jobs: jobs.map(job => ({
        id: job.id,
        releaseId: job.release.id,
        title: releaseTitle(job.release),
        series: job.release.series,
        season: job.release.season,
        episode: job.release.episode,
        provider: job.release.provider,
        category: job.category,
        status: job.status,
        progress: Math.floor(job.progress),
        bytes: job.bytes,
        totalBytes: job.totalBytes,
        speed: queue.getSpeed(job.id),
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })),
    };
  });

  app.post('/api/ui/queue', async (request: FastifyRequest<{ Body: { releaseId?: string; release?: Release; category?: string; priority?: number } }>, reply) => {
    const body = request.body || {};
    let release: Release | undefined;

    if (body.releaseId) {
      release = store.release(body.releaseId);
    } else if (body.release) {
      release = body.release;
      store.saveReleases([release]);
    }

    if (!release) {
      return reply.code(404).send({ success: false, error: 'Položka k přidání do fronty nebyla nalezena' });
    }

    let category = body.category;
    if (!category || !config.categories.includes(category)) {
      category = release.kind === 'movie' ? 'movies' : 'tv';
      if (!config.categories.includes(category)) {
        category = config.categories[0] || 'tv';
      }
    }

    const priority = typeof body.priority === 'number' ? body.priority : 0;
    try {
      const job = queue.add(release, category, priority);
      return { success: true, jobId: job.id, job };
    } catch (err) {
      return reply.code(400).send({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/ui/queue/pause', async (request: FastifyRequest<{ Body: { id?: string } }>) => {
    const id = request.body?.id;
    await queue.pause(id);
    return { success: true };
  });

  app.post('/api/ui/queue/resume', async (request: FastifyRequest<{ Body: { id?: string } }>) => {
    const id = request.body?.id;
    queue.resume(id);
    return { success: true };
  });

  app.post('/api/ui/queue/:id/retry', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      const job = queue.retry(request.params.id);
      return { success: true, job };
    } catch (err) {
      return reply.code(400).send({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/ui/queue/:id', async (request: FastifyRequest<{ Params: { id: string }; Querystring: { deleteFiles?: string }; Body?: { deleteFiles?: boolean } }>, reply) => {
    const id = request.params.id;
    const deleteFiles = request.body?.deleteFiles ?? (request.query.deleteFiles !== '0' && request.query.deleteFiles !== 'false');
    try {
      await queue.remove(id, Boolean(deleteFiles));
      return { success: true };
    } catch (err) {
      return reply.code(400).send({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 7. Completed / History downloads
  app.get('/api/ui/downloads', async (request: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>) => {
    const all = store.jobs()
      .filter(j => j.status === 'Completed' || j.status === 'Failed')
      .sort((a, b) => (b.finishedAt || b.updatedAt) - (a.finishedAt || a.updatedAt));

    const offset = Math.max(0, parseInt(request.query.offset || '0', 10) || 0);
    const limit = Math.max(1, parseInt(request.query.limit || '100', 10) || 100);
    const paged = all.slice(offset, offset + limit);

    const downloads = await Promise.all(
      paged.map(async job => {
        let filePath = job.file;
        if (!filePath || !existsSync(filePath)) {
          filePath = await findJobFile(job.storage);
        }

        return {
          id: job.id,
          releaseId: job.release.id,
          title: releaseTitle(job.release),
          series: job.release.series,
          season: job.release.season,
          episode: job.release.episode,
          provider: job.release.provider,
          category: job.category,
          status: job.status,
          bytes: job.bytes,
          storage: job.storage,
          filePath: filePath || null,
          hasFile: Boolean(filePath && existsSync(filePath)),
          error: job.error,
          createdAt: job.createdAt,
          finishedAt: job.finishedAt || job.updatedAt,
          downloadUrl: `/api/ui/files/${job.id}`,
        };
      }),
    );

    return { total: all.length, downloads };
  });

  app.delete('/api/ui/downloads/:id', async (request: FastifyRequest<{ Params: { id: string }; Querystring: { deleteFiles?: string }; Body?: { deleteFiles?: boolean } }>, reply) => {
    const id = request.params.id;
    const deleteFiles = request.body?.deleteFiles ?? (request.query.deleteFiles === '1' || request.query.deleteFiles === 'true');
    try {
      await queue.remove(id, Boolean(deleteFiles));
      return { success: true };
    } catch (err) {
      return reply.code(400).send({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // 8. Stream / Download file directly to browser with HTTP Range support
  app.get('/api/ui/files/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const id = request.params.id;
    const job = store.job(id);
    if (!job) {
      return reply.code(404).type('text/plain').send('Úloha nenalezena');
    }
    if (job.status !== 'Completed') {
      return reply.code(400).type('text/plain').send('Stahování ještě není dokončeno');
    }

    let filePath = job.file;
    if (!filePath || !existsSync(filePath)) {
      filePath = await findJobFile(job.storage);
    }
    if (!filePath || !existsSync(filePath)) {
      return reply.code(404).type('text/plain').send('Soubor na disku nebyl nalezen');
    }

    const fileStat = await stat(filePath);
    const fileSize = fileStat.size;
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const fileName = basename(filePath);

    const range = request.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0]!, 10);
      const end = parts[1] ? parseInt(parts[1]!, 10) : fileSize - 1;

      if (start >= fileSize || end >= fileSize || start > end) {
        return reply
          .code(416)
          .header('Content-Range', `bytes */${fileSize}`)
          .send('Requested range not satisfiable');
      }

      const chunkLength = end - start + 1;
      reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', chunkLength)
        .header('Content-Type', contentType);

      return reply.send(createReadStream(filePath, { start, end }));
    }

    reply
      .code(200)
      .header('Content-Length', fileSize)
      .header('Content-Type', contentType)
      .header('Accept-Ranges', 'bytes')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);

    return reply.send(createReadStream(filePath));
  });
}
