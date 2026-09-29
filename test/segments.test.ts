import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadSegmentsConcat } from '../src/media/segment-download.ts';

test('aborting halfway through a segment never checkpoints that segment as complete', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-segments-'));
  let interruptFirst = true;
  await using server = createServer((request, response) => {
    const body = request.url === '/one' ? Buffer.from('abcdefgh') : Buffer.from('IJKLMNOP');
    response.writeHead(200, { 'Content-Length': body.length });
    if (request.url === '/one' && interruptFirst) {
      interruptFirst = false;
      response.write(body.subarray(0, 4));
      // The caller cancels on these first bytes. No timing-dependent completion races.
    } else response.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const segments = [{ url: base + '/one' }, { url: base + '/two' }];
  const output = join(directory.path, 'track.mp4');
  const checkpoint = join(directory.path, 'checkpoint.json');
  const controller = new AbortController();
  try {
    await assert.rejects(downloadSegmentsConcat(segments, undefined, output, controller.signal, () => controller.abort(), checkpoint));
    await downloadSegmentsConcat(segments, undefined, output, AbortSignal.timeout(5000), undefined, checkpoint);
    assert.equal((await readFile(output)).toString(), 'abcdefghIJKLMNOP');
  } finally {
    server.closeAllConnections();
  }
});

test('byte-range segments must return precisely the requested bytes', async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), 'md-range-'));
  const requests: string[] = [];
  await using server = createServer((request, response) => {
    requests.push(request.headers.range || '');
    const body = Buffer.from('abcdefgh');
    const start = Number(request.headers.range?.match(/bytes=(\d+)-/)?.[1]);
    response.writeHead(206, { 'Content-Length': 4, 'Content-Range': `bytes ${start}-${start + 3}/8` });
    response.end(body.subarray(start, start + 4));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/segments`;
  const output = join(directory.path, 'track.mp4');
  try {
    await downloadSegmentsConcat([{ url, range: { start: 4, length: 4 } }, { url, range: { start: 0, length: 4 } }], undefined, output, AbortSignal.timeout(5000));
    assert.equal((await readFile(output)).toString(), 'efghabcd');
    assert.deepEqual(requests, ['bytes=4-7', 'bytes=0-3']);
  } finally {
    server.closeAllConnections();
  }
});
