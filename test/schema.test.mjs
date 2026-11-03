import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { csvReader, fileCheckpointStore, fileSource, importFile, validateFile } from '../dist/index.js';

const orders = 'sku,units\nA,1\n,0\nB,2\n';
const sanitized = 'The record does not match the schema.';

async function fixture(t, content = 'sku,units\nA,1\nB,2\n') {
  const directory = await mkdtemp(join(tmpdir(), 'importkit-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'orders.csv');
  await writeFile(path, content);
  const batches = [];
  const options = {
    source: fileSource(path),
    reader: csvReader(),
    importId: 'schema-import',
    transformVersion: 'v1',
    checkpointStore: fileCheckpointStore(join(directory, 'progress.json')),
    commitBatch: async (records) => { batches.push(records.map(({ index, value }) => ({ index, value }))); },
  };
  return { options, batches };
}

function standardSchema(validate) {
  return { '~standard': { version: 1, vendor: 'synthetic', validate } };
}

/** Requires a nonempty sku and a positive integer number of units, and quotes the rejected value in its message. */
function orderSchema({ async = false } = {}) {
  return standardSchema((value) => {
    const issues = [];
    const units = Number(value.units);
    if (!Number.isInteger(units) || units < 1) issues.push({ message: `units must be a positive integer, got ${value.units}`, path: ['units'] });
    if (value.sku === '') issues.push({ message: 'sku is required', path: [{ key: 'sku' }] });
    const result = issues.length > 0 ? { issues } : { value: { sku: value.sku, units } };
    return async ? Promise.resolve(result) : result;
  });
}

test('a schema validates and types records without mapRecord', async (t) => {
  const { options, batches } = await fixture(t);
  await importFile({ ...options, schema: orderSchema() });
  assert.deepEqual(batches.flat(), [{ index: 1, value: { sku: 'A', units: 1 } }, { index: 2, value: { sku: 'B', units: 2 } }]);
});

test('mapRecord receives the output of an asynchronous schema', async (t) => {
  const { options, batches } = await fixture(t);
  const inputs = [];
  await importFile({
    ...options,
    schema: orderSchema({ async: true }),
    mapRecord: (order, { line }) => {
      inputs.push(order);
      return { ...order, line };
    },
  });
  assert.deepEqual(inputs, [{ sku: 'A', units: 1 }, { sku: 'B', units: 2 }]);
  assert.deepEqual(batches.flat().map(({ value }) => value.line), [2, 3]);
});

test('validation reports each schema issue with its path and line, and leaves schema messages out by default', async (t) => {
  const { options } = await fixture(t, orders);
  const report = await validateFile({ ...options, schema: orderSchema() });
  assert.equal(report.status, 'invalid');
  assert.equal(report.validRecords, 2);
  assert.equal(report.invalidRecords, 1);
  assert.deepEqual(report.issues, [
    { code: 'SCHEMA_ERROR', recordIndex: 2, line: 3, path: ['units'], message: sanitized },
    { code: 'SCHEMA_ERROR', recordIndex: 2, line: 3, path: ['sku'], message: sanitized },
  ]);
  assert.doesNotMatch(JSON.stringify(report), /got 0/u);
  const detailed = await validateFile({ ...options, schema: orderSchema(), includeSchemaMessages: true });
  assert.deepEqual(detailed.issues.map(({ message }) => message), ['units must be a positive integer, got 0', 'sku is required']);
});

test('maxIssues bounds schema issues rather than records', async (t) => {
  const { options } = await fixture(t, orders);
  const report = await validateFile({ ...options, schema: orderSchema(), maxIssues: 1 });
  assert.deepEqual(report.issues.map(({ path }) => path), [['units']]);
  assert.equal(report.issuesTruncated, true);
  assert.equal(report.invalidRecords, 1);
});

test('issue paths keep string keys and array indexes, and name symbol keys', async (t) => {
  const { options } = await fixture(t, 'sku,units\nA,1\n');
  const schema = standardSchema(() => ({ issues: [{ message: 'Nested.', path: [Symbol('meta'), 0, { key: 'name' }] }, { message: 'Root.', path: [] }] }));
  const report = await validateFile({ ...options, schema });
  assert.deepEqual(report.issues.map((issue) => issue.path), [['Symbol(meta)', 0, 'name'], undefined]);
  assert.equal(Object.hasOwn(report.issues[1], 'path'), false);
});

test('an import stops at the first record that fails its schema, with the schema result as the cause', async (t) => {
  const { options, batches } = await fixture(t, orders);
  await assert.rejects(importFile({ ...options, batchSize: 1, schema: orderSchema() }), (error) => {
    assert.equal(error.code, 'SCHEMA_ERROR');
    assert.equal(error.recordIndex, 2);
    assert.equal(error.line, 3);
    assert.equal(error.message, sanitized);
    assert.deepEqual(error.cause.issues.map(({ path }) => path), [['units'], [{ key: 'sku' }]]);
    return true;
  });
  assert.deepEqual(batches.flat().map(({ index }) => index), [1]);
});

test('a schema that throws produces a SCHEMA_ERROR without a path or its message', async (t) => {
  const { options } = await fixture(t);
  const schema = standardSchema(() => { throw new Error('Private schema failure.'); });
  const report = await validateFile({ ...options, schema, includeSchemaMessages: true });
  assert.deepEqual(report.issues[0], { code: 'SCHEMA_ERROR', recordIndex: 1, line: 2, message: sanitized });
  assert.doesNotMatch(JSON.stringify(report), /Private schema failure/u);
  await assert.rejects(importFile({ ...options, schema }), (error) => error.code === 'SCHEMA_ERROR' && error.cause.message === 'Private schema failure.');
});

test('Zod schemas work as Standard Schemas', async (t) => {
  const schema = z.object({ sku: z.string().min(1), units: z.coerce.number().int().positive() });
  const invalid = await fixture(t, orders);
  const report = await validateFile({ ...invalid.options, schema });
  assert.deepEqual(report.issues.map(({ recordIndex, line, path }) => ({ recordIndex, line, path })), [
    { recordIndex: 2, line: 3, path: ['sku'] },
    { recordIndex: 2, line: 3, path: ['units'] },
  ]);
  const valid = await fixture(t);
  await importFile({ ...valid.options, schema });
  assert.deepEqual(valid.batches.flat().map(({ value }) => value), [{ sku: 'A', units: 1 }, { sku: 'B', units: 2 }]);
});

test('schemas implemented as functions are accepted', async (t) => {
  const { options, batches } = await fixture(t);
  const schema = Object.assign(() => {}, standardSchema((value) => ({ value: value.sku })));
  await importFile({ ...options, schema });
  assert.deepEqual(batches.flat().map(({ value }) => value), ['A', 'B']);
});

test('schema options are validated before the source is read', async (t) => {
  const { options } = await fixture(t);
  const malformed = [{}, 'schema', { '~standard': { version: 2, validate() {} } }, { '~standard': { version: 1 } }];
  for (const schema of malformed) {
    await assert.rejects(importFile({ ...options, schema }), { code: 'INVALID_OPTIONS', message: /Standard Schema/u });
    await assert.rejects(validateFile({ ...options, schema }), { code: 'INVALID_OPTIONS', message: /Standard Schema/u });
  }
  await assert.rejects(importFile(options), { code: 'INVALID_OPTIONS', message: /mapRecord or schema/u });
  await assert.rejects(validateFile(options), { code: 'INVALID_OPTIONS', message: /mapRecord or schema/u });
  await assert.rejects(importFile({ ...options, mapRecord: 'map' }), { code: 'INVALID_OPTIONS' });
  await assert.rejects(validateFile({ ...options, schema: orderSchema(), includeSchemaMessages: 'yes' }), { code: 'INVALID_OPTIONS' });
});

test('a schema that fails after cancellation reports ABORTED', async (t) => {
  const { options } = await fixture(t);
  for (const run of [importFile, validateFile]) {
    const controller = new AbortController();
    const schema = standardSchema(() => {
      controller.abort();
      throw new Error('Cancelled by the caller.');
    });
    await assert.rejects(run({ ...options, schema, signal: controller.signal }), { code: 'ABORTED' });
  }
});
