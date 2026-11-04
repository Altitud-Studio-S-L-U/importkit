import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileCheckpointStore, fileSource, importFile, jsonlReader } from '../dist/index.js';

async function fixture(t, records = 6) {
  const directory = await mkdtemp(join(tmpdir(), 'importkit-concurrency-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'orders.jsonl');
  await writeFile(sourcePath, Array.from({ length: records }, (_, index) => `{"order":${index + 1}}\n`).join(''));
  const options = {
    source: fileSource(sourcePath),
    reader: jsonlReader(),
    importId: 'concurrent-import',
    transformVersion: 'v1',
    batchSize: 1,
    mapRecord: (input) => input,
  };
  return { directory, sourcePath, options };
}

/** Keeps checkpoints in memory and checks that each save covers only confirmed records. */
function memoryStore(confirmed) {
  let current;
  const saves = [];
  return {
    saves,
    load: async () => current,
    save: async (checkpoint) => {
      for (let index = 1; index <= checkpoint.processedRecords; index++) {
        assert.ok(confirmed.has(index), `checkpoint ${checkpoint.processedRecords} covers unconfirmed record ${index}`);
      }
      saves.push(checkpoint.processedRecords);
      current = checkpoint;
    },
  };
}

test('batches overlap up to the concurrency limit while checkpoints cover only confirmed predecessors', async (t) => {
  const { options } = await fixture(t);
  const confirmed = new Set();
  const store = memoryStore(confirmed);
  const durations = [30, 20, 10, 30, 20, 10];
  let active = 0;
  let maxActive = 0;
  const result = await importFile({
    ...options,
    checkpointStore: store,
    concurrency: 3,
    commitBatch: async (records, { checkpoint }) => {
      const own = new Set(records.map(({ index }) => index));
      for (let index = 1; index <= checkpoint.processedRecords; index++) {
        assert.ok(own.has(index) || confirmed.has(index), `the context checkpoint covers record ${index} before it is confirmed`);
      }
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(durations[records[0].index - 1]);
      for (const index of own) confirmed.add(index);
      active--;
    },
  });
  assert.equal(maxActive, 3);
  assert.equal(result.committedBatches, 6);
  assert.deepEqual([...confirmed].sort(), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(store.saves, [...store.saves].sort((a, b) => a - b));
  assert.equal(store.saves.at(-1), 6);
  assert.ok(!store.saves.includes(1) && !store.saves.includes(2), 'progress waits for the slowest earlier batch');
});

test('a failed batch stops new batches and returns after the batches in flight save their progress', async (t) => {
  const { options } = await fixture(t, 4);
  const confirmed = new Set();
  const store = memoryStore(confirmed);
  const calls = [];
  await assert.rejects(importFile({
    ...options,
    checkpointStore: store,
    concurrency: 2,
    commitBatch: async (records) => {
      const { index } = records[0];
      calls.push(index);
      if (index === 2) {
        await delay(5);
        throw new Error('Destination unavailable.');
      }
      await delay(30);
      confirmed.add(index);
    },
  }), { code: 'COMMIT_ERROR', recordIndex: 2 });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(store.saves.at(-1), 1, 'the batch in flight was confirmed and saved before the run rejected');
  await delay(40);
  assert.deepEqual(calls, [1, 2], 'no batch starts after the run rejects');

  const resumed = await importFile({ ...options, checkpointStore: store, concurrency: 2, commitBatch: async (records) => {
    for (const { index } of records) confirmed.add(index);
  } });
  assert.equal(resumed.resumedFrom, 1);
  assert.equal(resumed.committedBatches, 3);
});

test('cancellation waits for the batches in flight and keeps the progress they confirm', async (t) => {
  const { options } = await fixture(t, 4);
  const confirmed = new Set();
  const store = memoryStore(confirmed);
  const controller = new AbortController();
  await assert.rejects(importFile({
    ...options,
    checkpointStore: store,
    concurrency: 2,
    signal: controller.signal,
    commitBatch: async (records) => {
      const { index } = records[0];
      if (index === 2) controller.abort();
      await delay(index === 1 ? 20 : 5);
      confirmed.add(index);
    },
  }), { code: 'ABORTED' });
  assert.equal(store.saves.at(-1), 2);
});

test('onProgress reports every saved checkpoint and ends at the full source size', async (t) => {
  const { options, directory, sourcePath } = await fixture(t, 3);
  const totalBytes = (await stat(sourcePath)).size;
  const reports = [];
  await importFile({
    ...options,
    batchSize: 2,
    checkpointStore: fileCheckpointStore(join(directory, 'progress.json')),
    onProgress: (progress) => { reports.push(progress); },
    commitBatch: async () => {},
  });
  assert.deepEqual(reports.map(({ processedRecords, committedBatches }) => ({ processedRecords, committedBatches })), [
    { processedRecords: 2, committedBatches: 1 },
    { processedRecords: 3, committedBatches: 2 },
  ]);
  assert.ok(reports.every((report) => report.totalBytes === totalBytes && report.bytesRead <= totalBytes && Object.isFrozen(report)));
  assert.equal(reports.at(-1).bytesRead, totalBytes);
});

test('a failing progress callback stops the run with PROGRESS_ERROR after its checkpoint is saved', async (t) => {
  const { options, directory } = await fixture(t, 3);
  const settings = { ...options, checkpointStore: fileCheckpointStore(join(directory, 'progress.json')), commitBatch: async () => {} };
  await assert.rejects(importFile({ ...settings, onProgress: () => { throw new Error('Dashboard unavailable.'); } }), (error) => {
    assert.equal(error.code, 'PROGRESS_ERROR');
    assert.equal(error.cause.message, 'Dashboard unavailable.');
    return true;
  });
  assert.equal((await importFile(settings)).resumedFrom, 1);
});

test('concurrency and onProgress are validated before the source is read', async (t) => {
  const { options, directory } = await fixture(t);
  const settings = { ...options, checkpointStore: fileCheckpointStore(join(directory, 'progress.json')), commitBatch: async () => {} };
  for (const concurrency of [0, 17, 1.5, '2', Number.NaN]) {
    await assert.rejects(importFile({ ...settings, concurrency }), { code: 'INVALID_OPTIONS', message: /concurrency/u });
  }
  await assert.rejects(importFile({ ...settings, onProgress: 'log' }), { code: 'INVALID_OPTIONS', message: /onProgress/u });
});
