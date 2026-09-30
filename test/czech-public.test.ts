import test from 'node:test';
import assert from 'node:assert/strict';
import { createCeskaTelevizeProvider } from '../src/providers/czech-public-ceskatelevize.ts';
import { searchCatalogue } from '../src/catalogue.ts';

test('ČT movie searches use the production year, not the IDEC year or a sequel', async t => {
  const films = [
    { id: '1099641378', code: 'andel-pane', title: 'Anděl Páně', year: '2005', idec: '20455211500' },
    { id: '10792423524', code: 'andel-pane-2', title: 'Anděl Páně 2', year: '2016', idec: '21551313003' },
  ];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://api.ceskatelevize.cz/graphql/') {
      const request = JSON.parse(String(init?.body));
      if (request.operationName === 'SearchShows') {
        const items = films.filter(film => film.title.includes(request.variables.search));
        return Response.json({ data: { searchShows: { items, totalCount: items.length } } });
      }
      if (request.operationName === 'GetEpisodes') {
        const film = films.find(film => film.idec === request.variables.idec)!;
        return Response.json({ data: { episodesPreviewFind: { totalCount: 1, items: [{ id: film.idec, title: film.title, playable: true }] } } });
      }
    }
    const film = films.find(film => url === `https://www.ceskatelevize.cz/porady/${film.id}-${film.code}/`);
    if (film) return new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { data: { show: { idec: film.idec, year: film.year, seasons: [] } } } } })}</script>`);
    throw new Error(`Unexpected request: ${url}`);
  });
  const provider = createCeskaTelevizeProvider({ enabled: true })!;
  const releases = await searchCatalogue(provider, { q: 'Anděl Páně 2005', kind: 'movie', limit: 10, offset: 0 }, new AbortController().signal);
  assert.deepEqual(releases.map(release => ({ title: release.title, year: release.year, url: release.url })), [{
    title: 'Anděl Páně', year: 2005,
    url: 'https://www.ceskatelevize.cz/porady/1099641378-andel-pane/20455211500/',
  }]);
});
