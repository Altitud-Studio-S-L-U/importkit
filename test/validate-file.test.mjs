import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { csvReader, fileCheckpointStore, fileSource, importFile, ImportKitError, jsonlReader, validateFile } from '../dist/index.js';

async function fixture(t, content = '{"id":1}\n{"id":2}\n') {
  const directory = await mkdtemp(join(tmpdir(), 'importkit-validation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'input.txt');
  await writeFile(path, content);
  return {
    directory,
    path,
    options: {
      source: fileSource(path),
      reader: jsonlReader(),
      importId: 'synthetic-validation',
      transformVersion: 'v1',
      mapRecord: (input) => input,
    },
  };
}

test('valid JSONL and CSV return complete bounded summaries', async (t) => {
  for (const [content, reader] of [['{"id":1}\n{"id":2}\n', jsonlReader()], ['id\n1\n2\n', csvReader()]]) {
    const { options } = await fixture(t, content);
    const result = await validateFile({ ...options, reader });
    assert.deepEqual(result, {
      status: 'valid', sourceHash: createHash('sha256').update(content).digest('hex'),
      processedRecords: 2, validRecords: 2, invalidRecords: 0, issues: [], issuesTruncated: false,
    });
  }
});

test('mapping failures are counted after the retained issue limit and do not expose application data', async (t) => {
  const { options } = await fixture(t, Array.from({ length: 5 }, (_, index) => JSON.stringify({ id: index + 1 })).join('\n'));
  const seen = [];
  const result = await validateFile({
    ...options,
    maxIssues: 2,
    mapRecord: async (input, { index }) => {
      seen.push(index);
      if (input.id % 2 === 1) throw new Error(`Confidential record: ${JSON.stringify(input)}`);
      return { largeValue: 'not retained in the validation result' };
    },
  });
  assert.equal(result.status, 'invalid');
  assert.equal(result.processedRecords, 5);
  assert.equal(result.validRecords, 2);
  assert.equal(result.invalidRecords, 3);
  assert.equal(result.issuesTruncated, true);
  assert.deepEqual(result.issues.map((issue) => issue.recordIndex), [1, 3]);
  assert.ok(result.issues.every((issue) => issue.code === 'MAP_ERROR' && !Object.hasOwn(issue, 'cause')));
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.doesNotMatch(JSON.stringify(result), /Confidential|not retained|"value"/u);
});

test('count-only validation retains no mapping issues when maxIssues is zero', async (t) => {
  const { options } = await fixture(t);
  const result = await validateFile({ ...options, maxIssues: 0, mapRecord: () => { throw new Error('Invalid.'); } });
  assert.equal(result.invalidRecords, 2);
  assert.deepEqual(result.issues, []);
  assert.equal(result.issuesTruncated, true);
});

test('CSV issue ordinals count parsed records rather than physical lines', async (t) => {
  const { options } = await fixture(t, 'id,note\n1,"first\nsecond"\n2,invalid\n');
  const result = await validateFile({
    ...options,
    reader: csvReader(),
    mapRecord: (input) => {
      if (input.id === '2') throw new Error('Invalid synthetic record.');
      return input;
    },
  });
  assert.equal(result.status, 'invalid');
  assert.equal(result.processedRecords, 2);
  assert.equal(result.issues[0].recordIndex, 2);
});

test('fatal parsing reports an incomplete traversal and does not invent a recovery ordinal', async (t) => {
  const { options } = await fixture(t, '{"id":1}\n{"private":"malformed-secret"\n{"id":3}\n');
  const result = await validateFile(options);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.processedRecords, 1);
  assert.equal(result.validRecords, 1);
  assert.equal(result.invalidRecords, 0);
  assert.equal(result.parseError.code, 'PARSE_ERROR');
  assert.equal(Object.hasOwn(result.parseError, 'recordIndex'), false);
  assert.equal(Object.hasOwn(result.parseError, 'cause'), false);
  assert.doesNotMatch(JSON.stringify(result), /malformed-secret/u);
});

test('a fatal CSV error and custom decoder exception both return incomplete results', async (t) => {
  const { options } = await fixture(t, 'id,note\n1,"unterminated');
  assert.equal((await validateFile({ ...options, reader: csvReader() })).status, 'incomplete');
  const reader = {
    id: 'synthetic-decoder:v1',
    async *read(chunks) {
      for await (const _chunk of chunks) { /* Consume source before demonstrating a structural failure. */ }
      throw new Error('Private decoder context.');
    },
  };
  const result = await validateFile({ ...options, reader });
  assert.equal(result.status, 'incomplete');
  assert.doesNotMatch(JSON.stringify(result), /Private decoder context/u);
});

test('parse errors remain visible even when the mapping issue budget is exhausted', async (t) => {
  const { options } = await fixture(t, '{}\ninvalid\n');
  const result = await validateFile({ ...options, maxIssues: 0, mapRecord: () => { throw new Error('Bad row.'); } });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.invalidRecords, 1);
  assert.equal(result.issuesTruncated, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.parseError.code, 'PARSE_ERROR');
});

test('an empty source is valid and produces no mapping callbacks', async (t) => {
  const { options } = await fixture(t, '');
  const result = await validateFile({ ...options, mapRecord: () => assert.fail('No records exist.') });
  assert.equal(result.status, 'valid');
  assert.equal(result.processedRecords, 0);
  assert.equal(result.validRecords, 0);
});

test('validation does not read destination options, write source data, or touch existing checkpoints and locks', async (t) => {
  const { options, directory, path } = await fixture(t);
  const checkpointPath = join(directory, 'existing.checkpoint.json');
  await writeFile(checkpointPath, 'not a checkpoint');
  await writeFile(`${checkpointPath}.lock`, 'another importer owns this lock');
  const before = (await readdir(directory)).sort();
  const bytes = await readFile(path);
  Object.defineProperty(options, 'checkpointStore', { get: () => assert.fail('Validation must not inspect a checkpoint option.') });
  Object.defineProperty(options, 'commitBatch', { get: () => assert.fail('Validation must not inspect a destination option.') });
  assert.equal((await validateFile(options)).status, 'valid');
  assert.deepEqual((await readdir(directory)).sort(), before);
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(await readFile(checkpointPath, 'utf8'), 'not a checkpoint');
  assert.equal(await readFile(`${checkpointPath}.lock`, 'utf8'), 'another importer owns this lock');
});

test('validation and import share the exact stable record IDs and source hash', async (t) => {
  const { options, directory } = await fixture(t);
  const validationIds = [];
  const validation = await validateFile({ ...options, mapRecord: (input, context) => { validationIds.push(context.id); return input; } });
  const importedIds = [];
  const imported = await importFile({
    ...options,
    checkpointStore: fileCheckpointStore(join(directory, 'new.checkpoint.json')),
    batchSize: 1,
    commitBatch: async (records) => { importedIds.push(...records.map((record) => record.id)); },
  });
  assert.equal(validation.sourceHash, imported.sourceHash);
  assert.deepEqual(validationIds, importedIds);
});

test('mapping is awaited sequentially and transformed values are discarded', async (t) => {
  const { options } = await fixture(t);
  let active = 0;
  let maximum = 0;
  const result = await validateFile({
    ...options,
    mapRecord: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return { toJSON: () => assert.fail('Mapping values must not be serialized or returned.') };
    },
  });
  assert.equal(result.status, 'valid');
  assert.equal(maximum, 1);
  assert.equal(result.validRecords, 2);
});

test('source, record, and record-count limits throw rather than masquerading as completed validation', async (t) => {
  const { options } = await fixture(t);
  for (const limits of [{ maxSourceBytes: 1 }, { maxRecordBytes: 4 }, { maxRecords: 1 }]) {
    await assert.rejects(validateFile({ ...options, limits }), { code: 'LIMIT_EXCEEDED' });
  }
});

test('cancellation before opening the source and during mapping throws ABORTED', async (t) => {
  const { options, directory } = await fixture(t);
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(validateFile({
    ...options, signal: stopped.signal,
    source: fileSource(join(directory, 'missing')),
    mapRecord: () => assert.fail('Aborted validation must not map.'),
  }), { code: 'ABORTED' });
  for (const rejectMapping of [false, true]) {
    const controller = new AbortController();
    await assert.rejects(validateFile({
      ...options, signal: controller.signal,
      mapRecord: () => {
        controller.abort();
        if (rejectMapping) throw new Error('A callback also failed.');
        return null;
      },
    }), { code: 'ABORTED' });
  }
});

test('missing, nonregular, and changed sources remain operational errors', async (t) => {
  const { options, directory, path } = await fixture(t);
  const folder = join(directory, 'folder');
  await mkdir(folder);
  for (const sourcePath of [folder, join(directory, 'missing')]) {
    await assert.rejects(validateFile({ ...options, source: fileSource(sourcePath) }), { code: 'SOURCE_ERROR' });
  }
  let changed = false;
  await assert.rejects(validateFile({
    ...options,
    mapRecord: async (input) => {
      if (!changed) { changed = true; await writeFile(path, '{"id":9}\n{"id":8}\n'); }
      return input;
    },
  }), { code: 'SOURCE_CHANGED' });
});

test('operational errors from a reader are propagated without becoming incomplete reports', async (t) => {
  const { options } = await fixture(t);
  const reader = {
    id: 'operational-failure:v1',
    async *read() { throw new ImportKitError('SOURCE_ERROR', 'Synthetic source failure.'); },
  };
  await assert.rejects(validateFile({ ...options, reader }), { code: 'SOURCE_ERROR' });
});

test('invalid validation options are rejected explicitly', async (t) => {
  const { options } = await fixture(t);
  for (const maxIssues of [-1, 1.5, NaN, Infinity, 10_001]) {
    await assert.rejects(validateFile({ ...options, maxIssues }), { code: 'INVALID_OPTIONS' });
  }
  await assert.rejects(validateFile({ ...options, mapRecord: null }), { code: 'INVALID_OPTIONS' });
  await assert.rejects(validateFile(null), { code: 'INVALID_OPTIONS' });
});

test('validation rejects the 0.3 source shape with guidance', async (t) => {
  const { options, path } = await fixture(t);
  const { reader, ...withoutReader } = options;
  await assert.rejects(validateFile({ ...withoutReader, source: { path, reader } }), {
    code: 'INVALID_OPTIONS',
    message: /\{ source: fileSource\(path\), reader: csvReader\(\) \}/u,
  });
});

test('issues and parse errors report the line where the record starts', async (t) => {
  const { options } = await fixture(t, 'id,note\n1,"multi\nline"\n2,bad\n3,ok\n');
  const reject = (input) => {
    if (input.note === 'bad') throw new Error('Rejected.');
    return input;
  };
  const report = await validateFile({ ...options, reader: csvReader(), mapRecord: reject });
  assert.deepEqual(report.issues, [{ code: 'MAP_ERROR', recordIndex: 2, line: 4, message: 'Record mapping or validation failed.' }]);
  const malformed = await fixture(t, '{"id":1}\n{"id":2}\n{"id":\n');
  const incomplete = await validateFile(malformed.options);
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(incomplete.parseError.line, 3);
});

test('a reader without line numbers produces issues without a line', async (t) => {
  const { options } = await fixture(t);
  const reader = {
    id: 'lineless:v1',
    async *read(chunks) {
      for await (const _chunk of chunks) { /* Consume the source. */ }
      yield { value: 'only' };
    },
  };
  const report = await validateFile({ ...options, reader, mapRecord: () => { throw new Error('Rejected.'); } });
  assert.deepEqual(report.issues, [{ code: 'MAP_ERROR', recordIndex: 1, message: 'Record mapping or validation failed.' }]);
});
