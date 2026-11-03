import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileCheckpointStore, fileSource, importFile, ImportKitError, jsonlReader } from '../dist/index.js';

async function fixture(t, count = 5) {
  const directory = await mkdtemp(join(tmpdir(), 'importkit-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'orders.jsonl');
  const content = Array.from({ length: count }, (_, index) => JSON.stringify({ id: index + 1 })).join('\n');
  await writeFile(sourcePath, content);
  const options = {
    source: fileSource(sourcePath),
    reader: jsonlReader(),
    importId: 'store-contract',
    transformVersion: 'v1',
    batchSize: 2,
    mapRecord: (input) => input,
  };
  return { directory, sourcePath, content, options };
}

function memoryStore(saved) {
  const events = [];
  const store = {
    async lock() {
      events.push('lock');
      return async () => { events.push('release'); };
    },
    async load() {
      events.push('load');
      return saved;
    },
    async save(checkpoint) {
      events.push(`save:${checkpoint.processedRecords}${checkpoint.completed ? ':completed' : ''}`);
      saved = checkpoint;
    },
  };
  return { events, store, saved: () => saved };
}

test('a run locks, loads and saves the store around every committed batch', async (t) => {
  const { options } = await fixture(t);
  const memory = memoryStore();
  const contexts = [];
  await importFile({
    ...options,
    checkpointStore: memory.store,
    commitBatch: async (records, context) => {
      memory.events.push(`commit:${records.length}`);
      contexts.push(context);
    },
  });
  assert.deepEqual(memory.events, ['lock', 'load', 'save:0', 'commit:2', 'save:2', 'commit:2', 'save:4', 'commit:1', 'save:5:completed', 'release']);
  assert.deepEqual(contexts.map(({ checkpoint }) => [checkpoint.processedRecords, checkpoint.completed]), [[2, false], [4, false], [5, true]]);
  assert.ok(contexts.every((context) => Object.isFrozen(context) && Object.isFrozen(context.checkpoint)));
  assert.equal(memory.saved(), contexts.at(-1).checkpoint);
});

test('the commit context carries the caller signal when one is given', async (t) => {
  const { options } = await fixture(t, 1);
  const controller = new AbortController();
  const signals = [];
  await importFile({ ...options, signal: controller.signal, checkpointStore: memoryStore().store, commitBatch: async (_, context) => { signals.push(context.signal); } });
  assert.deepEqual(signals, [controller.signal]);
  const keys = [];
  await importFile({ ...options, checkpointStore: memoryStore().store, commitBatch: async (_, context) => { keys.push(Object.keys(context)); } });
  assert.deepEqual(keys, [['checkpoint']]);
});

test('a store without lock() is used without coordination', async (t) => {
  const { options } = await fixture(t);
  const { load, save } = memoryStore().store;
  const result = await importFile({ ...options, checkpointStore: { load, save }, commitBatch: async () => {} });
  assert.equal(result.processedRecords, 5);
});

test('the lock is released when a run fails', async (t) => {
  const { options } = await fixture(t);
  const memory = memoryStore();
  await assert.rejects(importFile({
    ...options,
    checkpointStore: memory.store,
    commitBatch: async () => { throw new Error('Synthetic destination outage.'); },
  }), { code: 'COMMIT_ERROR' });
  assert.equal(memory.events.at(-1), 'release');
});

test('a checkpoint committed with its records prevents a replay when the save fails', async (t) => {
  const { options } = await fixture(t);
  const database = { records: new Map(), checkpoint: undefined };
  let saveFailures = 1;
  const checkpointStore = {
    async load() { return database.checkpoint; },
    async save(checkpoint) {
      if (checkpoint.processedRecords === 2 && saveFailures-- > 0) throw new Error('Synthetic checkpoint outage.');
      database.checkpoint = checkpoint;
    },
  };
  const deliveries = [];
  const commitBatch = async (records, { checkpoint }) => {
    for (const record of records) {
      deliveries.push(record.index);
      database.records.set(record.id, record.value);
    }
    database.checkpoint = checkpoint;
  };
  await assert.rejects(importFile({ ...options, checkpointStore, commitBatch }), (error) => {
    assert.ok(error instanceof ImportKitError);
    assert.equal(error.code, 'CHECKPOINT_ERROR');
    assert.equal(error.cause.message, 'Synthetic checkpoint outage.');
    return true;
  });
  const result = await importFile({ ...options, checkpointStore, commitBatch });
  assert.equal(result.resumedFrom, 2);
  assert.deepEqual(deliveries, [1, 2, 3, 4, 5]);
  assert.equal(database.records.size, 5);
});

test('loaded checkpoints are validated before any delivery', async (t) => {
  const { options } = await fixture(t);
  const commitBatch = async () => assert.fail('No batch may be delivered.');
  const load = (value) => ({ async load() { return value; }, async save() {} });
  await assert.rejects(importFile({ ...options, checkpointStore: load({ processedRecords: 2 }), commitBatch }), { code: 'CHECKPOINT_ERROR' });
  await assert.rejects(importFile({ ...options, checkpointStore: load('{"version":1}'), commitBatch }), { code: 'CHECKPOINT_ERROR' });
  const foreign = {
    version: 1, importId: 'another-import', transformVersion: 'v1', readerId: 'jsonl:v1:utf8-strict',
    sourceHash: 'a'.repeat(64), processedRecords: 2, completed: false,
  };
  await assert.rejects(importFile({ ...options, checkpointStore: load(foreign), commitBatch }), { code: 'CHECKPOINT_MISMATCH' });
  const polluted = JSON.parse('{"__proto__":{"completed":true},"version":1}');
  await assert.rejects(importFile({ ...options, checkpointStore: load(polluted), commitBatch }), { code: 'CHECKPOINT_ERROR' });
});

test('a store that loads null starts a new import', async (t) => {
  const { options } = await fixture(t, 1);
  const result = await importFile({ ...options, checkpointStore: { async load() { return null; }, async save() {} }, commitBatch: async () => {} });
  assert.equal(result.resumedFrom, 0);
  assert.equal(result.processedRecords, 1);
});

test('store failures become CHECKPOINT_ERROR with their cause, and library errors pass through', async (t) => {
  const { options } = await fixture(t, 1);
  const commitBatch = async () => {};
  const cause = new Error('Synthetic store outage.');
  await assert.rejects(importFile({ ...options, checkpointStore: { async load() { throw cause; }, async save() {} }, commitBatch }), (error) => {
    assert.equal(error.code, 'CHECKPOINT_ERROR');
    assert.equal(error.cause, cause);
    assert.doesNotMatch(error.message, /Synthetic/u);
    return true;
  });
  await assert.rejects(importFile({ ...options, checkpointStore: { async load() {}, save() { throw cause; } }, commitBatch }), { code: 'CHECKPOINT_ERROR' });
  const locked = new ImportKitError('IMPORT_LOCKED', 'Another run owns this import.');
  await assert.rejects(importFile({ ...options, checkpointStore: { async lock() { throw locked; }, async load() {}, async save() {} }, commitBatch }), (error) => error === locked);
  await assert.rejects(importFile({ ...options, checkpointStore: { async lock() { return 'not a function'; }, async load() {}, async save() {} }, commitBatch }), { code: 'CHECKPOINT_ERROR' });
});

test('a checkpoint file written by 0.3 resumes with fileCheckpointStore', async (t) => {
  const { directory, content, options } = await fixture(t);
  const checkpointPath = join(directory, 'progress.json');
  const sourceHash = createHash('sha256').update(content).digest('hex');
  await writeFile(checkpointPath, `${JSON.stringify({
    version: 1, importId: options.importId, transformVersion: options.transformVersion, readerId: options.reader.id,
    sourceHash, processedRecords: 2, completed: false,
  })}\n`);
  const delivered = [];
  const result = await importFile({
    ...options,
    checkpointStore: fileCheckpointStore(checkpointPath),
    commitBatch: async (records) => { delivered.push(...records.map((record) => record.index)); },
  });
  assert.equal(result.resumedFrom, 2);
  assert.deepEqual(delivered, [3, 4, 5]);
  assert.deepEqual(JSON.parse(await readFile(checkpointPath, 'utf8')), {
    version: 1, importId: options.importId, transformVersion: options.transformVersion, readerId: options.reader.id,
    sourceHash, processedRecords: 5, completed: true,
  });
});

test('checkpointPath from 0.3 and malformed stores are rejected with guidance', async (t) => {
  const { directory, options } = await fixture(t, 1);
  const commitBatch = async () => {};
  await assert.rejects(importFile({ ...options, checkpointPath: join(directory, 'progress.json'), checkpointStore: memoryStore().store, commitBatch }), {
    code: 'INVALID_OPTIONS',
    message: /\{ checkpointStore: fileCheckpointStore\(path\) \}/u,
  });
  for (const checkpointStore of [undefined, null, {}, { load() {} }, { async load() {}, async save() {}, lock: 'yes' }]) {
    await assert.rejects(importFile({ ...options, checkpointStore, commitBatch }), { code: 'INVALID_OPTIONS' });
  }
  for (const path of ['', 'progress\0.json', 42]) {
    assert.throws(() => fileCheckpointStore(path), { code: 'INVALID_OPTIONS' });
  }
});
