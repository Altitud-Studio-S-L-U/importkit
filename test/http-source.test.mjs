import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { inspect } from 'node:util';
import { httpSource, importFile, jsonlReader, validateFile } from '../dist/index.js';

const content = '{"order":1}\n{"order":2}\n{"order":3}\n';
const secret = 'Bearer synthetic-secret-token';

/** A local server whose handler can change between requests. */
async function server(t, initial) {
  const requests = [];
  let handler = initial;
  const instance = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    handler(request, response);
  });
  instance.listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => {
    instance.closeAllConnections();
    instance.close();
  });
  const { port } = instance.address();
  return {
    requests,
    url: (path = '/exports/orders.jsonl?signature=private-signature') => `http://127.0.0.1:${port}${path}`,
    use: (next) => { handler = next; },
  };
}

function serve({ body = content, etag = '"v1"', headers = {} } = {}) {
  return (_request, response) => {
    const sent = { 'content-length': Buffer.byteLength(body), ...headers };
    if (etag !== null) sent.etag = etag;
    response.writeHead(200, sent);
    response.end(body);
  };
}

function memoryStore() {
  let current;
  return { load: async () => current, save: async (checkpoint) => { current = checkpoint; }, current: () => current };
}

function options(source, overrides = {}) {
  return {
    source,
    reader: jsonlReader(),
    importId: 'http-import',
    transformVersion: 'v1',
    checkpointStore: memoryStore(),
    batchSize: 1,
    mapRecord: (input) => input,
    commitBatch: async () => {},
    ...overrides,
  };
}

test('a file served over HTTP is imported, resumed against the same ETag and validated', async (t) => {
  const { url, requests } = await server(t, serve());
  const source = httpSource(url(), { headers: { authorization: secret } });
  const store = memoryStore();
  const delivered = [];
  let fail = true;
  const settings = options(source, {
    checkpointStore: store,
    commitBatch: async (records) => {
      if (fail && records[0].index === 2) throw new Error('Destination unavailable.');
      delivered.push(...records.map(({ id, index }) => ({ id, index })));
    },
  });
  await assert.rejects(importFile(settings), { code: 'COMMIT_ERROR' });
  assert.equal(store.current().sourceIdentity, 'etag:"v1"');
  fail = false;
  const result = await importFile(settings);
  assert.equal(result.resumedFrom, 1);
  assert.equal(result.sourceHash, createHash('sha256').update(content).digest('hex'));
  assert.deepEqual(delivered.map(({ index }) => index), [1, 2, 3]);

  const validated = [];
  const report = await validateFile(options(source, { mapRecord: (input, { id }) => { validated.push(id); return input; } }));
  assert.equal(report.status, 'valid');
  assert.equal(report.sourceHash, result.sourceHash);
  assert.deepEqual(validated, delivered.map(({ id }) => id));
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.headers.authorization, secret);
    assert.equal(request.headers['accept-encoding'], 'identity');
    assert.equal(request.url, '/exports/orders.jsonl?signature=private-signature');
  }
});

test('a changed ETag stops a resumed run with CHECKPOINT_MISMATCH', async (t) => {
  const { url, use } = await server(t, serve());
  const settings = options(httpSource(url()), { commitBatch: async (records) => { if (records[0].index === 2) throw new Error('Destination unavailable.'); } });
  await assert.rejects(importFile(settings), { code: 'COMMIT_ERROR' });
  use(serve({ etag: '"v2"' }));
  await assert.rejects(importFile({ ...settings, commitBatch: async () => {} }), { code: 'CHECKPOINT_MISMATCH' });
});

test('responses that cannot prove their identity and size are rejected before any record is read', async (t) => {
  const { url, use, requests } = await server(t, serve());
  const cases = [
    [serve({ etag: null }), 'SOURCE_ERROR', /ETag/u],
    [serve({ etag: 'W/"v1"' }), 'SOURCE_ERROR', /strong ETag/u],
    [serve({ headers: { 'content-encoding': 'gzip' } }), 'SOURCE_ERROR', /Content-Encoding/u],
    [(_request, response) => { response.writeHead(200, { etag: '"v1"' }); response.end(content); }, 'SOURCE_ERROR', /Content-Length/u],
    [(_request, response) => { response.writeHead(404); response.end(); }, 'SOURCE_ERROR', /HTTP status 404/u],
    [(_request, response) => { response.writeHead(302, { location: url('/elsewhere') }); response.end(); }, 'SOURCE_ERROR', /redirect/u],
  ];
  for (const [handler, code, message] of cases) {
    use(handler);
    await assert.rejects(importFile(options(httpSource(url()), { mapRecord: () => assert.fail('No record may be read.') })), { code, message });
  }
  assert.equal(requests.some((request) => request.url === '/elsewhere'), false, 'redirects are never followed');
  use(serve());
  await assert.rejects(importFile(options(httpSource(url()), { limits: { maxSourceBytes: 8 } })), { code: 'LIMIT_EXCEEDED' });
});

test('a body cut short fails the run without exposing the URL or the request headers', async (t) => {
  const { url } = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-length': 1_000, etag: '"v1"' });
    response.write('{"order":1}\n');
    setTimeout(() => response.destroy(), 20);
  });
  const error = await importFile(options(httpSource(url(), { headers: { authorization: secret } }))).catch((failure) => failure);
  assert.ok(['SOURCE_ERROR', 'SOURCE_CHANGED'].includes(error.code), error.code);
  const shown = inspect(error, { depth: 10 });
  assert.doesNotMatch(shown, /synthetic-secret-token|private-signature/u);
});

test('a run that fails before the end cancels the download', async (t) => {
  let closed;
  const { url } = await server(t, (_request, response) => {
    closed = once(response, 'close');
    response.writeHead(200, { 'content-length': 1_000_000, etag: '"v1"' });
    response.write('{"order":1}\n');
  });
  await assert.rejects(importFile(options(httpSource(url()), { mapRecord: () => { throw new Error('Rejected.'); } })), { code: 'MAP_ERROR' });
  await Promise.race([closed, delay(2_000).then(() => assert.fail('The response was not cancelled.'))]);
});

test('cancellation during a download reports ABORTED', async (t) => {
  const { url } = await server(t, (_request, response) => {
    response.writeHead(200, { 'content-length': 1_000_000, etag: '"v1"' });
    response.write('{"order":1}\n');
  });
  const controller = new AbortController();
  await assert.rejects(importFile(options(httpSource(url()), {
    signal: controller.signal,
    commitBatch: async () => { controller.abort(); },
  })), { code: 'ABORTED' });
});

test('invalid URLs and headers are rejected when the source is created, and the source keeps them private', () => {
  for (const url of ['ftp://example.com/orders.csv', 'not a url', 'https://user:password@example.com/orders.csv']) {
    assert.throws(() => httpSource(url), { code: 'INVALID_OPTIONS' });
  }
  for (const headers of [{ 'bad header': 'x' }, { authorization: 'line\nbreak' }]) {
    assert.throws(() => httpSource('https://example.com/orders.csv', { headers }), (error) => error.code === 'INVALID_OPTIONS' && !error.message.includes('line'));
  }
  const source = httpSource('https://example.com/orders.csv?signature=private-signature', { headers: { authorization: secret } });
  assert.deepEqual(Object.keys(source), ['open']);
  assert.doesNotMatch(inspect(source, { depth: 10, showHidden: true }), /private-signature|synthetic-secret-token/u);
});


// RFC 9110 section 8.8.3: DQUOTE surrounds etagc; backslash does not escape quotes.
test('malformed ETags fail before record processing and cancel the pending body', async (t) => {
  const invalid = ['"a\tb"', '"a\u007fb"',"unquoted", "\"a b\"", "\"a\",\"b\"", "\"a\"b\"", "\"a\\\"b\"", "W/\"weak\"", "\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\""];
  for (const etag of invalid) {
    await t.test(JSON.stringify(etag), async (t) => {
      let cancelled = false;
      const calls = [];
      let endBody;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content));
          endBody = setTimeout(() => controller.close(), 250);
        },
        cancel() { clearTimeout(endBody); cancelled = true; },
      });
      t.after(() => clearTimeout(endBody));
      t.mock.method(globalThis, 'fetch', async () => new Response(body, {
        status: 200, headers: { etag, 'content-length': String(Buffer.byteLength(content)) },
      }));
      const target = 'https://example.test/orders?signature=private-signature';
      await assert.rejects(importFile(options(httpSource(target, { headers: { authorization: secret } }), {
        mapRecord: (input) => { calls.push('mapRecord'); return input; },
        commitBatch: async () => { calls.push('commitBatch'); },
        checkpointStore: { load: async () => undefined, save: async () => { calls.push('save'); } },
      })), (error) => {
        assert.equal(error.code, 'SOURCE_ERROR');
        const shown = inspect(error, { depth: 10 });
        assert.equal(shown.includes(etag), false);
        assert.equal(shown.includes(target), false);
        assert.doesNotMatch(shown, /private-signature|synthetic-secret-token|authorization/iu);
        return true;
      });
      assert.deepEqual(calls, []);
      assert.equal(cancelled, true);
    });
  }
});

test('strong ETags preserve their literal identity including obs-text and the length boundary', async (t) => {
  const valid = ['"\u0080"', '"\u00e9"', '"\u00fe"', '"\u00ff"',"\"v1\"", "\"\"", "\"a,b\"", "\"a\\b\"", "\"ÿ\"", "\"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\""];
  for (const etag of valid) {
    await t.test(JSON.stringify(etag), async (t) => {
      t.mock.method(globalThis, 'fetch', async () => new Response(content, {
        status: 200, headers: { etag, 'content-length': String(Buffer.byteLength(content)) },
      }));
      const store = memoryStore();
      const source = httpSource('https://example.test/orders');
      const delivered = [];
      const settings = options(source, {
        checkpointStore: store,
        commitBatch: async (records) => {
          if (records[0].index === 2) throw new Error('Destination unavailable.');
          delivered.push(...records.map(({ id }) => id));
        },
      });
      await assert.rejects(importFile(settings), { code: 'COMMIT_ERROR' });
      assert.equal(store.current().sourceIdentity, 'etag:' + etag);
      const result = await importFile({ ...settings, commitBatch: async (records) => { delivered.push(...records.map(({ id }) => id)); } });
      assert.equal(result.resumedFrom, 1);
      const validated = [];
      const report = await validateFile(options(source, { mapRecord: (input, { id }) => { validated.push(id); return input; } }));
      assert.equal(report.status, 'valid');
      assert.deepEqual(validated, delivered);
    });
  }
});
