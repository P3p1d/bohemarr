import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { Store, databasePath } from './store.ts';
import { Queue } from './queue.ts';
import { createProviders } from './providers/index.ts';
import { createMediaDownloader } from './media/download.ts';
import { createServer } from './server.ts';

const config = await loadConfig();
const store = new Store(await databasePath(config.dataDir));
const providers = createProviders(config, store.database);
const queue = new Queue(store, config, providers, createMediaDownloader(config));
const server = await createServer(config, store, queue, providers);
const cleanup = new AsyncDisposableStack();
cleanup.use(store);
cleanup.defer(async () => { await Promise.all([...providers.values()].map(provider => provider.close?.())); });
cleanup.use(queue);
cleanup.use(server);
async function shutdown(): Promise<void> {
  await cleanup.disposeAsync();
}
process.once('SIGTERM', () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1; }); });
process.once('SIGINT', () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1; }); });
try {
  await server.listen({ host: config.host, port: config.port });
  queue.wake();
  console.log(`Bohemarr listening on ${config.host}:${config.port}; ${providers.size} providers enabled`);
  console.log(`API key: configured via API_KEY/config.json or stored in ${resolve(config.dataDir, 'api-key')}`);
} catch (error) {
  await shutdown();
  throw error;
}
