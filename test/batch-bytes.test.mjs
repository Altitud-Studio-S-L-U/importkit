import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileCheckpointStore, fileSource, importFile, jsonlReader } from '../dist/index.js';

async function fixture(t, values = ['123456', 'abc', 'de']) {
  const directory = await mkdtemp(join(tmpdir(), 'importkit-batch-bytes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'values.jsonl');
  const checkpointPath = join(directory, 'progress.json');
  await writeFile(sourcePath, values.map((value) => JSON.stringify(value)).join('\n'));
  const batches = [];
  const options = {
    source: fileSource(sourcePath),
    reader: jsonlReader(),
    importId: 'synthetic-byte-batches',
    transformVersion: 'strings-v1',
    checkpointStore: fileCheckpointStore(checkpointPath),
    batchSize: 500,
    maxBatchBytes: 10,
    measureRecordBytes: (value) => Buffer.byteLength(value, 'utf8'),
    mapRecord: (value) => value,
    commitBatch: async (records) => { batches.push([...records]); },
  };
  return { directory, sourcePath, checkpointPath, batches, options };
}

test('flushes before adding a record that exceeds the remaining byte budget', async (t) => {
  const { options, batches } = await fixture(t);
  const result = await importFile(options);
  assert.deepEqual(batches.map((batch) => batch.map((record) => record.index)), [[1, 2], [3]]);
  assert.equal(result.committedBatches, 2);
  assert.equal(result.processedRecords, 3);
  assert.ok(batches.every((batch) => batch.reduce((bytes, record) => bytes + Buffer.byteLength(record.value), 0) <= 10));
});

test('checkpoints only the flushed prefix when a mapped record is pending during cancellation', async (t) => {
  const { options } = await fixture(t);
  const controller = new AbortController();
  const delivered = [];
  const mapped = [];
  await assert.rejects(importFile({
    ...options,
    signal: controller.signal,
    mapRecord: (value, context) => { mapped.push(context); return value; },
    commitBatch: async (records) => { delivered.push(...records); controller.abort(); },
  }), { code: 'ABORTED' });
  assert.deepEqual(mapped.map((context) => context.index), [1, 2, 3]);
  assert.deepEqual(delivered.map((record) => record.index), [1, 2]);
  const resumed = [];
  const result = await importFile({ ...options, commitBatch: async (records) => resumed.push(...records) });
  assert.equal(result.resumedFrom, 2);
  assert.deepEqual(resumed.map((record) => record.index), [3]);
  assert.equal(resumed[0].id, mapped[2].id);
});

test('count and byte thresholds both constrain a batch', async (t) => {
  const first = await fixture(t, ['a', 'b', 'c', 'd', 'e']);
  await importFile({ ...first.options, batchSize: 2, maxBatchBytes: 100 });
  assert.deepEqual(first.batches.map((batch) => batch.length), [2, 2, 1]);
  const second = await fixture(t, ['123456', 'abcdef', 'uvwxyz']);
  await importFile({ ...second.options, batchSize: 2, maxBatchBytes: 10 });
  assert.deepEqual(second.batches.map((batch) => batch.length), [1, 1, 1]);
});

test('an exact byte threshold commits without mapping another record', async (t) => {
  const { options, batches } = await fixture(t, ['é', '猫', 'x']);
  const order = [];
  await importFile({
    ...options,
    maxBatchBytes: 5,
    mapRecord: (value, { index }) => { order.push(`map:${index}`); return value; },
    commitBatch: async (records) => { order.push(`commit:${records.at(-1).index}`); batches.push([...records]); },
  });
  assert.deepEqual(order, ['map:1', 'map:2', 'commit:2', 'map:3', 'commit:3']);
  assert.deepEqual(batches.map((batch) => batch.map((record) => record.value)), [['é', '猫'], ['x']]);
});

test('zero-byte values are accepted and remain bounded by batchSize', async (t) => {
  const { options, batches } = await fixture(t, ['', '', '', '', '']);
  await importFile({ ...options, batchSize: 2, maxBatchBytes: 1 });
  assert.deepEqual(batches.map((batch) => batch.length), [2, 2, 1]);
});

test('measurements occur once per new transformed value with its stable context', async (t) => {
  const { options, batches } = await fixture(t);
  const measured = [];
  await importFile({
    ...options,
    mapRecord: (value) => Buffer.from(value),
    measureRecordBytes: (value, context) => {
      assert.ok(Buffer.isBuffer(value));
      measured.push(context);
      return value.byteLength;
    },
  });
  assert.deepEqual(measured.map((context) => ({ ...context })), batches.flat().map(({ id, index }) => ({ id, index, line: index })));
  const result = await importFile({ ...options, measureRecordBytes: () => assert.fail('Confirmed records must not be measured again.') });
  assert.equal(result.resumedFrom, 3);
});

test('byte options must be paired and valid before any source or checkpoint is opened', async (t) => {
  const { options, directory } = await fixture(t);
  const before = (await readdir(directory)).sort();
  const base = { ...options, source: fileSource(join(directory, 'missing')) };
  for (const update of [
    { maxBatchBytes: undefined },
    { measureRecordBytes: undefined },
    { measureRecordBytes: null },
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((maxBatchBytes) => ({ maxBatchBytes })),
  ]) {
    await assert.rejects(importFile({ ...base, ...update }), { code: 'INVALID_OPTIONS' });
  }
  assert.deepEqual((await readdir(directory)).sort(), before);
});

test('invalid measurement results fail explicitly before a pending batch is flushed', async (t) => {
  for (const invalid of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '4', Promise.resolve(4)]) {
    const { options, batches } = await fixture(t);
    await assert.rejects(importFile({
      ...options,
      measureRecordBytes: (value, { index }) => index === 3 ? invalid : Buffer.byteLength(value),
    }), { code: 'MEASURE_ERROR', recordIndex: 3 });
    assert.deepEqual(batches, []);
  }
});

test('measurement exceptions retain their cause without copying it into the public message', async (t) => {
  const { options, batches } = await fixture(t);
  const cause = new Error('Private serializer detail.');
  await assert.rejects(importFile({ ...options, measureRecordBytes: () => { throw cause; } }), (error) => {
    assert.equal(error.code, 'MEASURE_ERROR');
    assert.equal(error.recordIndex, 1);
    assert.equal(error.cause, cause);
    assert.ok(!error.message.includes('Private serializer detail.'));
    return true;
  });
  assert.deepEqual(batches, []);
});

test('an invalid thenable measurement is rejected without invoking its then method', async (t) => {
  const { options } = await fixture(t);
  let invoked = false;
  const thenable = { then() { invoked = true; } };
  await assert.rejects(importFile({ ...options, measureRecordBytes: () => thenable }), { code: 'MEASURE_ERROR', recordIndex: 1 });
  assert.equal(invoked, false);
});

test('a rejected Promise measurement produces only the controlled error in a strict child process', async (t) => {
  const { options, sourcePath, checkpointPath } = await fixture(t);
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { fileCheckpointStore, fileSource, importFile, jsonlReader } from ${JSON.stringify(moduleUrl)};
    await assert.rejects(importFile({
      source: fileSource(${JSON.stringify(sourcePath)}),
      reader: jsonlReader(),
      importId: ${JSON.stringify(options.importId)},
      transformVersion: ${JSON.stringify(options.transformVersion)},
      checkpointStore: fileCheckpointStore(${JSON.stringify(checkpointPath)}),
      maxBatchBytes: 10,
      measureRecordBytes: () => Promise.reject(new Error('Synthetic rejected measurement.')),
      mapRecord: (value) => value,
      commitBatch: async () => assert.fail('Invalid measurement must not reach the destination.'),
    }), { code: 'MEASURE_ERROR', recordIndex: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    console.log('Controlled measurement error; no unhandled rejection.');
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /no unhandled rejection/u);
});

test('an oversized transformed value fails before flushing the previous partial batch', async (t) => {
  const { options, batches } = await fixture(t, ['123456', '12345678901']);
  await assert.rejects(importFile(options), { code: 'LIMIT_EXCEEDED', recordIndex: 2 });
  assert.deepEqual(batches, []);
  const resumed = [];
  const result = await importFile({ ...options, maxBatchBytes: 20, commitBatch: async (records) => resumed.push(...records) });
  assert.equal(result.resumedFrom, 0);
  assert.deepEqual(resumed.map((record) => record.index), [1, 2]);
});

test('remaining-budget comparison handles safe integers without overflowing a sum', async (t) => {
  const { options, batches } = await fixture(t, ['a', 'b']);
  await importFile({
    ...options,
    maxBatchBytes: Number.MAX_SAFE_INTEGER,
    measureRecordBytes: (_value, { index }) => index === 1 ? Number.MAX_SAFE_INTEGER - 1 : 2,
  });
  assert.deepEqual(batches.map((batch) => batch.map((record) => record.index)), [[1], [2]]);
});

test('a failed byte-triggered destination flush replays its prefix and the pending record with stable IDs', async (t) => {
  const { options } = await fixture(t);
  const mapped = [];
  const durable = new Map();
  await assert.rejects(importFile({
    ...options,
    mapRecord: (value, context) => { mapped.push(context); return value; },
    commitBatch: async (records) => {
      assert.deepEqual(records.map((record) => record.index), [1, 2]);
      for (const record of records) durable.set(record.id, record.value);
      throw new Error('Acknowledgement lost after the prefix persisted.');
    },
  }), { code: 'COMMIT_ERROR' });
  const replayed = [];
  const result = await importFile({
    ...options, maxBatchBytes: 7, batchSize: 1,
    commitBatch: async (records) => {
      replayed.push(...records);
      for (const record of records) durable.set(record.id, record.value);
    },
  });
  assert.equal(result.resumedFrom, 0);
  assert.deepEqual(replayed.map((record) => record.id), mapped.map((context) => context.id));
  assert.equal(durable.size, 3);
});

test('checkpoint failure after a byte-triggered durable flush cannot skip the pending record', async (t) => {
  const { options, checkpointPath } = await fixture(t);
  let initialCheckpoint;
  const persisted = [];
  await assert.rejects(importFile({
    ...options,
    commitBatch: async (records) => {
      persisted.push(...records);
      initialCheckpoint = await readFile(checkpointPath, 'utf8');
      await rm(checkpointPath);
      await mkdir(checkpointPath);
    },
  }), { code: 'CHECKPOINT_ERROR' });
  assert.deepEqual(persisted.map((record) => record.index), [1, 2]);
  await rm(checkpointPath, { recursive: true });
  await writeFile(checkpointPath, initialCheckpoint);
  const delivered = [];
  const result = await importFile({ ...options, commitBatch: async (records) => delivered.push(...records) });
  assert.equal(result.resumedFrom, 0);
  assert.deepEqual(delivered.map((record) => record.index), [1, 2, 3]);
  assert.deepEqual(delivered.slice(0, 2).map((record) => record.id), persisted.map((record) => record.id));
});

test('cancellation after mapping prevents measurement and destination callbacks', async (t) => {
  const { options } = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(importFile({
    ...options, signal: controller.signal,
    mapRecord: (value) => { controller.abort(); return value; },
    measureRecordBytes: () => assert.fail('Cancelled records must not be measured.'),
    commitBatch: async () => assert.fail('Cancelled records must not reach the destination.'),
  }), { code: 'ABORTED' });
});

test('cancellation after measurement prevents an exact-threshold destination commit', async (t) => {
  const { options } = await fixture(t, ['1234567890']);
  const controller = new AbortController();
  await assert.rejects(importFile({
    ...options, signal: controller.signal,
    measureRecordBytes: () => { controller.abort(); return 10; },
    commitBatch: async () => assert.fail('Cancellation must be checked before the exact-threshold flush.'),
  }), { code: 'ABORTED' });
});

test('byte-triggered flushing preserves sequential destination backpressure', async (t) => {
  const { options } = await fixture(t, ['123456', 'abcdef', 'uvwxyz']);
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const measured = [];
  let active = 0;
  let maximum = 0;
  const importing = importFile({
    ...options,
    measureRecordBytes: (value, { index }) => { measured.push(index); return Buffer.byteLength(value); },
    commitBatch: async (records) => {
      active++;
      maximum = Math.max(maximum, active);
      if (records[0].index === 1) { started.resolve(); await finish.promise; }
      active--;
    },
  });
  importing.catch((error) => started.reject(error));
  try {
    await started.promise;
    assert.deepEqual(measured, [1, 2], 'only one transformed record may wait beyond the current batch');
    assert.equal(active, 1);
  } finally {
    finish.resolve();
    await importing;
  }
  assert.equal(maximum, 1);
  assert.deepEqual(measured, [1, 2, 3]);
});
