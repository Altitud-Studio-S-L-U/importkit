import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileCheckpointStore, fileSource, importFile, ImportKitError, jsonlReader, validateFile } from '../dist/index.js';

const content = '{"order":1}\n{"order":2}\n{"order":3}\n';
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function memoryStore() {
  let current;
  return { load: async () => current, save: async (checkpoint) => { current = checkpoint; }, current: () => current };
}

/** An in-memory source that records how ImportKit uses it. */
function bufferSource(text = content, overrides = {}) {
  const bytes = Buffer.from(text);
  const events = [];
  const source = {
    async open(context) {
      events.push('open');
      assert.equal(Object.isFrozen(context), true);
      return {
        identity: `memory:${sha256(bytes)}`,
        size: bytes.byteLength,
        async *bytes() {
          for (let offset = 0; offset < bytes.byteLength; offset += 4) {
            events.push('chunk');
            yield bytes.subarray(offset, offset + 4);
          }
        },
        async assertUnchanged() { events.push('check'); },
        async close() { events.push('close'); },
        ...overrides,
      };
    },
  };
  return { source, events };
}

function options(source, store = memoryStore()) {
  return {
    source,
    reader: jsonlReader(),
    importId: 'memory-import',
    transformVersion: 'v1',
    checkpointStore: store,
    batchSize: 1,
    mapRecord: (input) => input,
    commitBatch: async () => {},
  };
}

function expectedId(identity, index) {
  return sha256(JSON.stringify(['memory-import', identity, 'jsonl:v1:utf8-strict', 'v1', index]));
}

test('a custom source imports and validates with IDs derived from its identity', async () => {
  const { source, events } = bufferSource();
  const store = memoryStore();
  const ids = [];
  const result = await importFile({ ...options(source, store), commitBatch: async (records) => { ids.push(...records.map(({ id }) => id)); } });
  const identity = `memory:${sha256(content)}`;
  assert.equal(result.sourceHash, sha256(content));
  assert.equal(store.current().sourceIdentity, identity);
  assert.deepEqual(ids, [1, 2, 3].map((index) => expectedId(identity, index)));
  assert.deepEqual(events.filter((event) => event !== 'chunk'), ['open', 'check', 'check', 'check', 'check', 'close']);

  const validated = [];
  const report = await validateFile({ ...options(source), mapRecord: (input, { id }) => { validated.push(id); return input; } });
  assert.equal(report.sourceHash, result.sourceHash);
  assert.deepEqual(validated, ids);
});

test('record IDs of file imports keep the derivation that 0.3 used', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'importkit-sources-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'orders.jsonl');
  await writeFile(path, content);
  const ids = [];
  const result = await importFile({
    ...options(fileSource(path)),
    checkpointStore: fileCheckpointStore(join(directory, 'progress.json')),
    commitBatch: async (records) => { ids.push(...records.map(({ id }) => id)); },
  });
  assert.equal(result.sourceHash, sha256(content));
  assert.deepEqual(ids, [1, 2, 3].map((index) => expectedId(sha256(content), index)));
});

test('more or fewer bytes than the declared size, or bytes that miss the declared SHA-256, fail with SOURCE_CHANGED', async () => {
  const size = Buffer.byteLength(content);
  for (const overrides of [{ size: size - 1 }, { size: size + 1 }, { sha256: 'f'.repeat(64) }]) {
    const { source, events } = bufferSource(content, overrides);
    await assert.rejects(importFile(options(source)), { code: 'SOURCE_CHANGED' });
    await assert.rejects(validateFile(options(source)), { code: 'SOURCE_CHANGED' });
    assert.equal(events.filter((event) => event === 'close').length, 2);
  }
});

test('a source that opens to an invalid shape is closed and rejected with INVALID_OPTIONS', async () => {
  const malformed = [
    { identity: '' }, { identity: 'x'.repeat(513) }, { identity: 7 }, { size: -1 }, { size: 1.5 },
    { sha256: 'ABC' }, { bytes: undefined }, { assertUnchanged: 'yes' },
  ];
  for (const overrides of malformed) {
    const { source, events } = bufferSource(content, overrides);
    await assert.rejects(importFile(options(source)), { code: 'INVALID_OPTIONS' });
    assert.deepEqual(events, ['open', 'close']);
  }
  await assert.rejects(importFile(options({ open: async () => null })), { code: 'INVALID_OPTIONS' });
  await assert.rejects(importFile(options({ path: 'orders.jsonl' })), { code: 'INVALID_OPTIONS', message: /ByteSource/u });
  const strings = bufferSource(content, { async *bytes() { yield 'text'; } });
  await assert.rejects(importFile(options(strings.source)), { code: 'INVALID_OPTIONS' });
});

test('source failures become SOURCE_ERROR with their cause, and library errors pass through', async () => {
  const failing = { open: async () => { throw new Error('Storage unavailable.'); } };
  await assert.rejects(importFile(options(failing)), (error) => error.code === 'SOURCE_ERROR' && error.cause.message === 'Storage unavailable.');
  const limited = { open: async () => { throw new ImportKitError('LIMIT_EXCEEDED', 'Too large.'); } };
  await assert.rejects(importFile(options(limited)), { code: 'LIMIT_EXCEEDED', message: 'Too large.' });
  const broken = bufferSource(content, { async *bytes() { yield Buffer.from('{"or'); throw new Error('Connection reset.'); } });
  await assert.rejects(importFile(options(broken.source)), (error) => error.code === 'SOURCE_ERROR' && error.cause.message === 'Connection reset.');
  const unclosable = bufferSource(content, { close: async () => { throw new Error('Close failed.'); } });
  await assert.rejects(importFile(options(unclosable.source)), { code: 'SOURCE_ERROR', message: 'Unable to close the source.' });
});

test('a source larger than maxSourceBytes is rejected before any byte is read', async () => {
  const { source, events } = bufferSource();
  await assert.rejects(importFile({ ...options(source), limits: { maxSourceBytes: 8 } }), { code: 'LIMIT_EXCEEDED' });
  assert.deepEqual(events, ['open', 'close']);
});

test('a source that reports a change stops the run before the next batch', async () => {
  let checks = 0;
  const committed = [];
  const { source } = bufferSource(content, {
    async assertUnchanged() {
      checks++;
      if (checks === 2) throw new ImportKitError('SOURCE_CHANGED', 'Changed.');
    },
  });
  await assert.rejects(importFile({ ...options(source), commitBatch: async (records) => { committed.push(records[0].index); } }), { code: 'SOURCE_CHANGED' });
  assert.deepEqual(committed, [1]);
});

test('validation reads the rest of the source after a parse error, so its hash covers every byte', async () => {
  const malformed = '{"order":1}\n{"order":\n{"order":3}\n{"order":4}\n';
  const { source, events } = bufferSource(malformed);
  const report = await validateFile(options(source));
  assert.equal(report.status, 'incomplete');
  assert.equal(report.sourceHash, sha256(malformed));
  assert.equal(events.filter((event) => event === 'chunk').length, Math.ceil(Buffer.byteLength(malformed) / 4));
});

test('a resumed run with a different source identity is rejected', async () => {
  const store = memoryStore();
  const first = bufferSource();
  await assert.rejects(importFile({
    ...options(first.source, store),
    commitBatch: async (records) => { if (records[0].index === 2) throw new Error('Destination unavailable.'); },
  }), { code: 'COMMIT_ERROR' });
  const changed = bufferSource(content, { identity: 'memory:another-version' });
  await assert.rejects(importFile(options(changed.source, store)), { code: 'CHECKPOINT_MISMATCH' });
});

test('a failing close or lock release does not hide the error that ended the run', async () => {
  const unclosable = bufferSource(content, { close: async () => { throw new Error('Close failed.'); } });
  const failing = { ...options(unclosable.source), commitBatch: async () => { throw new Error('Destination unavailable.'); } };
  await assert.rejects(importFile(failing), { code: 'COMMIT_ERROR' });
  await assert.rejects(validateFile({ ...options(unclosable.source), limits: { maxRecords: 1 } }), { code: 'LIMIT_EXCEEDED' });
  await assert.rejects(validateFile(options(unclosable.source)), { code: 'SOURCE_ERROR', message: 'Unable to close the source.' });
  const store = { ...memoryStore(), lock: async () => async () => { throw new Error('Release failed.'); } };
  await assert.rejects(importFile({ ...failing, source: bufferSource().source, checkpointStore: store }), { code: 'COMMIT_ERROR' });
  await assert.rejects(importFile({ ...options(bufferSource().source), checkpointStore: store }), { code: 'CHECKPOINT_ERROR', message: 'Unable to release the checkpoint store lock.' });
});
