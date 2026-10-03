import { timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { Indexer, xml } from './indexer.ts';
import { Sabnzbd } from './sabnzbd.ts';
import { SeriesBindings } from './series-binding.ts';
import { registerUiRoutes } from './ui-routes.ts';
import type { Queue } from './queue.ts';
import type { Store } from './store.ts';
import type { Config, Provider } from './types.ts';

export async function createServer(config: Config, store: Store, queue: Queue, providers: Map<string, Provider>) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: 1024 * 1024, files: 1, fields: 20 } });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });
  const indexer = new Indexer(config, store, providers, new SeriesBindings(store.database));
  const sabnzbd = new Sabnzbd(config, queue, indexer);
  registerUiRoutes(app, config, store, queue, providers, indexer);
  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0]!;
    if (pathname === '/health' || pathname === '/' || pathname.startsWith('/ui/') || pathname.startsWith('/assets/')) return;
    const query = request.query as Record<string, unknown>;
    const provided = query.apikey ?? request.headers['x-api-key'];
    const actual = Buffer.from(typeof provided === 'string' ? provided : '');
    const expected = Buffer.from(config.apiKey);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      await reply.code(401).send({ status: false, error: 'Invalid API key' });
    }
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/v1/providers', async () => [...providers.values()].map(provider => ({ id: provider.id, name: provider.name })));
  app.get('/newznab/api', async (request, reply) => {
    const params = stringParams(request.query);
    reply.type('application/xml; charset=utf-8');
    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);
    try {
      if (params.t === 'caps') return indexer.capabilities();
      if (params.t === 'get') {
        const descriptor = indexer.taskDescriptor(params.id || '');
        reply.type('application/x-nzb').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(descriptor.name)}`);
        return descriptor.content;
      }
      if (!['search', 'tvsearch', 'movie'].includes(params.t || '')) throw new Error('Unsupported Newznab function');
      return await indexer.search(params, AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `<error code="900" description="${xml(message)}"/>`;
    } finally {
      reply.raw.removeListener('close', onClose);
    }
  });
  app.route({
    method: ['GET', 'POST'], url: '/api',
    handler: async (request, reply) => {
      const params = { ...stringParams(request.body), ...stringParams(request.query) };
      let upload: string | undefined;
      try {
        if (request.isMultipart()) {
          for await (const part of request.parts()) {
            if (part.type === 'file') {
              if (part.fieldname !== 'name') throw new Error('Expected upload field name');
              try {
                upload = (await part.toBuffer()).toString('utf8');
              } catch (error) {
                if (error instanceof app.multipartErrors.RequestFileTooLargeError) throw new Error('Task descriptor too large');
                throw error;
              }
            } else if (typeof part.value === 'string') params[part.fieldname] = part.value;
          }
        }
        return await sabnzbd.handle(params, upload);
      } catch (error) {
        reply.type('application/json');
        return { status: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  return app;
}

function stringParams(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
