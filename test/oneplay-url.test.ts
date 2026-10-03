import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneplayProviders } from '../src/providers/oneplay.ts';

test('Oneplay: provider is created when credentials configured and exposes resolveUrl and releaseForUrl', async () => {
  const providers = createOneplayProviders({
    oneplay: {
      enabled: true,
      username: 'user@example.com',
      password: 'password123',
    },
  });

  assert.equal(providers.length, 1);
  const oneplay = providers[0]!;
  assert.equal(oneplay.id, 'oneplay');
  assert.equal(oneplay.name, 'Oneplay');
  assert.equal(typeof oneplay.resolveUrl, 'function');
  assert.equal(typeof oneplay.catalogue.releaseForUrl, 'function');

  // Should ignore URLs that do not belong to Oneplay
  const foreignUrl = new URL('https://www.ceskatelevize.cz/porady/123-film/');
  const foreignResolved = await oneplay.resolveUrl!(foreignUrl, new AbortController().signal);
  assert.equal(foreignResolved, undefined);

  const foreignRelease = await oneplay.catalogue.releaseForUrl!(foreignUrl, { q: '' }, new AbortController().signal);
  assert.equal(foreignRelease, undefined);

  await oneplay.close?.();
});
