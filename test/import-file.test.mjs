import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, link, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { importFile, csvReader, jsonlReader } from '../dist/index.js';

async function fixture(t, content = '{"id":1}\n{"id":2}\n{"id":3}\n') {
  const directory = await mkdtemp(join(tmpdir(), 'importkit-engine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, 'input.txt');
  const checkpointPath = join(directory, 'progress.json');
  await writeFile(sourcePath, content);
  const batches = [];
  const options = {
    source: { path: sourcePath, reader: jsonlReader() },
    importId: 'test-import',
    transformVersion: 'v1',
    checkpointPath,
    batchSize: 2,
    mapRecord: (input) => input,
    commitBatch: async (records) => { batches.push([...records]); },
  };
  return { directory, sourcePath, checkpointPath, batches, options };
}

test('imports sequential batches, the final partial batch, and resumes without destination writes', async (t) => {
  const { options, batches } = await fixture(t);
  const result = await importFile(options);
  assert.equal(result.status, 'completed');
  assert.equal(result.processedRecords, 3);
  assert.equal(result.resumedFrom, 0);
  assert.equal(result.committedBatches, 2);
  assert.match(result.sourceHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(batches.map((batch) => batch.map(({ index, value }) => ({ index, value }))), [
    [{ index: 1, value: { id: 1 } }, { index: 2, value: { id: 2 } }],
    [{ index: 3, value: { id: 3 } }],
  ]);
  assert.equal(new Set(batches.flat().map((record) => record.id)).size, 3);
  const resumed = await importFile({ ...options, batchSize: 1, mapRecord: () => { throw new Error('Committed records must not be mapped again.'); } });
  assert.equal(resumed.resumedFrom, 3);
  assert.equal(resumed.committedBatches, 0);
  assert.equal(batches.length, 2);
});

test('empty files complete without mapping or destination calls', async (t) => {
  const { options, batches } = await fixture(t, '');
  const result = await importFile({ ...options, mapRecord: () => assert.fail('No empty record should be mapped.') });
  assert.equal(result.processedRecords, 0);
  assert.equal(result.committedBatches, 0);
  assert.deepEqual(batches, []);
  assert.equal((await importFile(options)).resumedFrom, 0);
});

test('CSV checkpoint ordinals count parsed records rather than physical lines', async (t) => {
  const { options } = await fixture(t, 'id,note\n1,"first\nsecond"\n2,last\n3,end\n');
  const committed = [];
  let shouldFail = true;
  const settings = {
    ...options,
    source: { ...options.source, reader: csvReader() },
    batchSize: 1,
    commitBatch: async (records) => {
      if (records[0].index === 2 && shouldFail) throw new Error('Destination unavailable.');
      committed.push(...records.map((record) => ({ ...record, value: { ...record.value } })));
    },
  };
  await assert.rejects(importFile(settings), { code: 'COMMIT_ERROR', recordIndex: 2 });
  shouldFail = false;
  const resumed = await importFile(settings);
  assert.equal(resumed.resumedFrom, 1);
  assert.deepEqual(committed.map(({ index, value }) => ({ index, value })), [
    { index: 1, value: { id: '1', note: 'first\nsecond' } },
    { index: 2, value: { id: '2', note: 'last' } },
    { index: 3, value: { id: '3', note: 'end' } },
  ]);
});

test('mapping failure never commits an incomplete batch and preserves earlier batches', async (t) => {
  const { options, batches } = await fixture(t, '{"id":1}\n{"id":2}\n{"id":3}\n{"id":4}\n');
  await assert.rejects(importFile({
    ...options,
    mapRecord: (input, { index }) => {
      if (index === 4) throw new Error('Invalid record.');
      return input;
    },
  }), { code: 'MAP_ERROR', recordIndex: 4 });
  assert.deepEqual(batches.flat().map((record) => record.index), [1, 2]);
  const resumed = await importFile(options);
  assert.equal(resumed.resumedFrom, 2);
  assert.deepEqual(batches.flat().map((record) => record.index), [1, 2, 3, 4]);
});

test('destination persistence followed by rejection replays stable IDs even when batch size changes', async (t) => {
  const { options } = await fixture(t);
  const durable = new Map();
  let initialIds;
  await assert.rejects(importFile({
    ...options,
    commitBatch: async (records) => {
      initialIds = records.map((record) => record.id);
      for (const record of records) durable.set(record.id, record.value);
      throw new Error('Acknowledgement lost after persistence.');
    },
  }), { code: 'COMMIT_ERROR' });
  const replayedIds = [];
  const result = await importFile({
    ...options,
    batchSize: 1,
    commitBatch: async (records) => {
      replayedIds.push(...records.map((record) => record.id));
      for (const record of records) durable.set(record.id, record.value);
    },
  });
  assert.equal(result.resumedFrom, 0);
  assert.deepEqual(replayedIds.slice(0, 2), initialIds);
  assert.equal(durable.size, 3);
});

test('a checkpoint write failure after persistence replays the uncheckpointed IDs', async (t) => {
  const { options, checkpointPath } = await fixture(t, '{"id":1}\n{"id":2}\n');
  const durable = new Map();
  let previousCheckpoint;
  let persistedIds;
  await assert.rejects(importFile({
    ...options,
    commitBatch: async (records) => {
      persistedIds = records.map((record) => record.id);
      for (const record of records) durable.set(record.id, record.value);
      previousCheckpoint = await readFile(checkpointPath, 'utf8');
      await rm(checkpointPath);
      await mkdir(checkpointPath);
    },
  }), { code: 'CHECKPOINT_ERROR' });
  await rm(checkpointPath, { recursive: true });
  await writeFile(checkpointPath, previousCheckpoint);
  const replayedIds = [];
  const result = await importFile({
    ...options,
    commitBatch: async (records) => {
      replayedIds.push(...records.map((record) => record.id));
      for (const record of records) durable.set(record.id, record.value);
    },
  });
  assert.equal(result.resumedFrom, 0);
  assert.deepEqual(replayedIds, persistedIds);
  assert.equal(durable.size, 2);
});

test('a killed importer leaves a lock and replays durable uncheckpointed records after explicit recovery', async (t) => {
  const { options, directory, sourcePath, checkpointPath } = await fixture(t, Array.from({ length: 5 }, (_, index) => JSON.stringify({ id: index + 1 })).join('\n'));
  const destinationPath = join(directory, 'destination.json');
  const childPath = join(directory, 'crash-import.mjs');
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  await writeFile(childPath, `
    import { open } from 'node:fs/promises';
    import { importFile, jsonlReader } from ${JSON.stringify(moduleUrl)};
    await importFile({
      source: { path: ${JSON.stringify(sourcePath)}, reader: jsonlReader() },
      importId: ${JSON.stringify(options.importId)},
      transformVersion: ${JSON.stringify(options.transformVersion)},
      checkpointPath: ${JSON.stringify(checkpointPath)},
      batchSize: 2,
      mapRecord: (record) => record,
      commitBatch: async (records) => {
        const handle = await open(${JSON.stringify(destinationPath)}, 'w', 0o600);
        await handle.writeFile(JSON.stringify(records));
        await handle.sync();
        await handle.close();
        process.exit(23);
      },
    });
    process.exit(99);
  `);
  const child = spawnSync(process.execPath, [childPath], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 23, child.stderr);
  const persisted = JSON.parse(await readFile(destinationPath, 'utf8'));
  assert.equal(persisted.length, 2);
  await assert.rejects(importFile(options), { code: 'IMPORT_LOCKED' });

  // The child has exited; this simulates an operator confirming the old writer
  // is gone before removing only its known checkpoint lock.
  await rm(`${checkpointPath}.lock`);
  const durable = new Map(persisted.map((record) => [record.id, record.value]));
  const replayedIds = [];
  const recovered = await importFile({
    ...options,
    commitBatch: async (records) => {
      replayedIds.push(...records.map((record) => record.id));
      for (const record of records) durable.set(record.id, record.value);
      const handle = await open(destinationPath, 'w', 0o600);
      await handle.writeFile(JSON.stringify([...durable].map(([id, value]) => ({ id, value }))));
      await handle.sync();
      await handle.close();
    },
  });
  assert.equal(recovered.resumedFrom, 0);
  assert.deepEqual(replayedIds.slice(0, 2), persisted.map((record) => record.id));
  assert.equal(replayedIds.length + persisted.length, 7);
  assert.equal(durable.size, 5);
  assert.equal(JSON.parse(await readFile(destinationPath, 'utf8')).length, 5);
});

test('changed file content of the same byte length invalidates the checkpoint before callbacks', async (t) => {
  const { options, sourcePath } = await fixture(t, '{"id":1}\n');
  await importFile(options);
  await writeFile(sourcePath, '{"id":2}\n');
  await assert.rejects(importFile({
    ...options,
    mapRecord: () => assert.fail('A mismatching checkpoint must be rejected before mapping.'),
    commitBatch: async () => assert.fail('A mismatching checkpoint must be rejected before committing.'),
  }), { code: 'CHECKPOINT_MISMATCH' });
});

test('import, transformation, and reader identities are part of the checkpoint contract', async (t) => {
  const { options } = await fixture(t);
  await importFile(options);
  const changed = [
    { importId: 'other-import' },
    { transformVersion: 'v2' },
    { source: { ...options.source, reader: { ...options.source.reader, id: 'other-reader:v1' } } },
  ];
  for (const update of changed) {
    await assert.rejects(importFile({
      ...options,
      ...update,
      mapRecord: () => assert.fail('Mismatching state must not invoke mapping.'),
      commitBatch: async () => assert.fail('Mismatching state must not invoke the destination.'),
    }), { code: 'CHECKPOINT_MISMATCH' });
  }
});

test('corrupt checkpoint errors are explicit and do not silently start over', async (t) => {
  const { options, checkpointPath } = await fixture(t);
  await writeFile(checkpointPath, '{broken-json');
  await assert.rejects(importFile({
    ...options,
    mapRecord: () => assert.fail('Corrupt state must not invoke mapping.'),
    commitBatch: async () => assert.fail('Corrupt state must not invoke the destination.'),
  }), { code: 'CHECKPOINT_ERROR' });
  assert.equal(await readFile(checkpointPath, 'utf8'), '{broken-json');
});

test('source byte limits reject the file before mapping or committing', async (t) => {
  const { options } = await fixture(t);
  await assert.rejects(importFile({
    ...options,
    limits: { maxSourceBytes: 1 },
    mapRecord: () => assert.fail('Oversized files must not invoke mapping.'),
    commitBatch: async () => assert.fail('Oversized files must not invoke the destination.'),
  }), { code: 'LIMIT_EXCEEDED' });
});

test('record count limits include records skipped during resume', async (t) => {
  const { options, batches } = await fixture(t);
  await assert.rejects(importFile({ ...options, batchSize: 1, limits: { maxRecords: 2 } }), { code: 'LIMIT_EXCEEDED' });
  assert.deepEqual(batches.flat().map((record) => record.index), [1, 2]);
  await assert.rejects(importFile({ ...options, limits: { maxRecords: 1 } }), { code: 'LIMIT_EXCEEDED' });
  const result = await importFile(options);
  assert.equal(result.resumedFrom, 2);
  assert.deepEqual(batches.flat().map((record) => record.index), [1, 2, 3]);
});

test('completed imports are reparsed to enforce smaller record byte limits', async (t) => {
  const { options } = await fixture(t, '{"name":"longer-value"}\n');
  await importFile(options);
  await assert.rejects(importFile({
    ...options,
    limits: { maxRecordBytes: 8 },
    mapRecord: () => assert.fail('Completed records must not be mapped.'),
    commitBatch: async () => assert.fail('Completed imports must not write.'),
  }), { code: 'LIMIT_EXCEEDED' });
});

test('abort before starting invokes no reader, mapping, or destination callbacks', async (t) => {
  const { options, directory } = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(importFile({
    ...options,
    signal: controller.signal,
    source: { path: join(directory, 'missing'), reader: { id: 'never:v1', read: () => assert.fail('An aborted import must not open a reader.') } },
    mapRecord: () => assert.fail('An aborted import must not map.'),
    commitBatch: async () => assert.fail('An aborted import must not write.'),
  }), { code: 'ABORTED' });
});

test('abort during a durable commit saves its checkpoint before returning cancellation', async (t) => {
  const { options } = await fixture(t, '{"id":1}\n');
  const controller = new AbortController();
  let destinationWrites = 0;
  await assert.rejects(importFile({
    ...options,
    batchSize: 1,
    signal: controller.signal,
    commitBatch: async () => {
      destinationWrites++;
      controller.abort();
    },
  }), { code: 'ABORTED' });
  const resumed = await importFile({ ...options, commitBatch: async () => { destinationWrites++; } });
  assert.equal(resumed.resumedFrom, 1);
  assert.equal(destinationWrites, 1);
});

test('two runs cannot write the same checkpoint concurrently', async (t) => {
  const { options } = await fixture(t, '{"id":1}\n');
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const first = importFile({ ...options, commitBatch: async () => { started.resolve(); await finish.promise; } });
  first.catch((error) => started.reject(error));
  try {
    await started.promise;
    await assert.rejects(importFile(options), { code: 'IMPORT_LOCKED' });
  } finally {
    finish.resolve();
    await first;
  }
  assert.equal((await importFile(options)).resumedFrom, 1);
});

test('missing and nonregular input return source errors', async (t) => {
  const { options, directory } = await fixture(t);
  const folder = join(directory, 'folder');
  await mkdir(folder);
  for (const path of [join(directory, 'missing'), folder]) {
    await assert.rejects(importFile({ ...options, source: { ...options.source, path } }), { code: 'SOURCE_ERROR' });
  }
});

test('source and checkpoint cannot be the same path', async (t) => {
  const { options, sourcePath } = await fixture(t);
  const original = await readFile(sourcePath, 'utf8');
  await assert.rejects(importFile({ ...options, checkpointPath: sourcePath }), { code: 'INVALID_OPTIONS' });
  assert.equal(await readFile(sourcePath, 'utf8'), original);
});

test('a checkpoint hardlink to the source is rejected without overwriting either path', async (t) => {
  const { options, sourcePath, checkpointPath } = await fixture(t);
  const original = await readFile(sourcePath, 'utf8');
  await link(sourcePath, checkpointPath);
  await assert.rejects(importFile(options), { code: 'INVALID_OPTIONS' });
  assert.equal(await readFile(sourcePath, 'utf8'), original);
  assert.equal(await readFile(checkpointPath, 'utf8'), original);
});

test('custom readers integrate with the same batching contract and backpressure', async (t) => {
  const { options } = await fixture(t, 'abc');
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let yielded = 0;
  let activeWrites = 0;
  let maxWrites = 0;
  const output = [];
  const reader = {
    id: 'ascii-byte-example:v1',
    async *read(chunks, limits) {
      assert.equal(limits.maxRecordBytes, 64);
      for await (const chunk of chunks) {
        for (const byte of chunk) {
          yielded++;
          yield String.fromCharCode(byte);
        }
      }
    },
  };
  const importing = importFile({
    ...options,
    source: { ...options.source, reader },
    limits: { maxRecordBytes: 64 },
    batchSize: 1,
    commitBatch: async (records) => {
      activeWrites++;
      maxWrites = Math.max(maxWrites, activeWrites);
      if (records[0].index === 1) { started.resolve(); await finish.promise; }
      output.push(...records.map((record) => record.value));
      activeWrites--;
    },
  });
  importing.catch((error) => started.reject(error));
  try {
    await started.promise;
    assert.equal(yielded, 1, 'the coordinator waits for the destination before requesting another record');
  } finally {
    finish.resolve();
    await importing;
  }
  assert.equal(maxWrites, 1);
  assert.deepEqual(output, ['a', 'b', 'c']);
});

test('changing the source during mapping is detected before the batch reaches the destination', async (t) => {
  const { options, sourcePath } = await fixture(t, '{"id":1}\n');
  await assert.rejects(importFile({
    ...options,
    batchSize: 1,
    mapRecord: async (input) => { await writeFile(sourcePath, '{"id":2}\n'); return input; },
    commitBatch: async () => assert.fail('A source change must be caught before committing.'),
  }), { code: 'SOURCE_CHANGED' });
});

test('invalid configuration is rejected before reading input', async (t) => {
  const { options } = await fixture(t);
  for (const update of [{ batchSize: 0 }, { batchSize: 10_001 }, { importId: '' }, { transformVersion: '' }, { limits: { maxRecords: 0 } }, { signal: {} }]) {
    await assert.rejects(importFile({ ...options, ...update }), { code: 'INVALID_OPTIONS' });
  }
});
