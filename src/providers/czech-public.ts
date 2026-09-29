import type { Provider, ProviderConfig } from '../types.ts';
import { createCeskaTelevizeProvider } from './czech-public-ceskatelevize.ts';
import { createStreamCzProvider } from './czech-public-streamcz.ts';

/**
 * Both Česká televize and Stream.cz are public catalogs with no login required for standard-
 * definition VOD playback, so each provider is enabled unless explicitly disabled via
 * `config[id].enabled === false`.
 */
export function createCzechPublicProviders(configs: Record<string, ProviderConfig>): Provider[] {
  const providers: Provider[] = [];
  const ceskatelevize = createCeskaTelevizeProvider(configs.ceskatelevize);
  if (ceskatelevize) providers.push(ceskatelevize);
  const streamcz = createStreamCzProvider(configs.streamcz);
  if (streamcz) providers.push(streamcz);
  return providers;
}
