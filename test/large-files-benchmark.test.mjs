import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { csvReader, jsonlReader } from '../dist/index.js';
import { createVerifier, generateDataset, parseOptions } from '../benchmarks/large-files.mjs';

const SCRIPT = fileURLToPath(new URL('../benchmarks/large-files.mjs', import.meta.url));

async function fixture(t) {
  const base = resolve(tmpdir());
  const directory = await mkdtemp(join(base, 'importkit-large-benchmark-test-'));
  t.after(async () => {
    const owned = relative(base, resolve(directory));
    assert.ok(owned.startsWith('importkit-large-benchmark-test-') && !owned.includes(sep) && !isAbsolute(owned));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function rows(manifest) {
  const source = await readFile(manifest.path);
  const reader = manifest.format === 'csv' ? csvReader() : jsonlReader();
  async function* chunks() {
    // Split inside fields rather than testing only complete in-memory lines.
    for (let index = 0; index < source.length; index += 137) yield source.subarray(index, index + 137);
  }
  const result = [];
  for await (const { value } of reader.read(chunks(), { maxRecordBytes: manifest.rowBytes })) result.push(value);
  return result;
}

function delivered(value, index) {
  return { id: 'a'.repeat(64), index, value: `${value.sequence}\t${value.amount}\t${value.payload}\n` };
}

function cli(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      try { resolveResult({ code, signal, stderr, report: JSON.parse(stdout) }); }
      catch (error) { reject(new Error(`CLI did not return JSON: ${stdout}; ${stderr}`, { cause: error })); }
    });
  });
}

for (const format of ['csv', 'jsonl']) {
  test(`large-file generator writes exact ${format} bytes and independently verifiable rows`, async (t) => {
    const directory = await fixture(t);
    const options = parseOptions(['--format', format, '--bytes', '33333', '--mode', 'import']);
    const manifest = await generateDataset(directory, options);
    const bytes = await readFile(manifest.path);
    assert.equal(bytes.length, 33_333);
    assert.equal((await stat(manifest.path)).size, 33_333);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sourceHash);
    assert.equal(bytes.includes(0), false);
    const parsed = await rows(manifest);
    assert.equal(parsed.length, manifest.records);
    const digest = createHash('sha256');
    let outputBytes = 0;
    for (const [offset, value] of parsed.entries()) {
      assert.equal(Number(value.sequence), offset + 1);
      assert.equal(Number(value.amount), 1000 + (offset + 1) % 900_000);
      assert.ok(value.payload.length > 0);
      assert.equal(new Set(value.payload).size, 1);
      const record = delivered(value, offset + 1);
      digest.update(record.value);
      outputBytes += Buffer.byteLength(record.value);
    }
    assert.equal(digest.digest('hex'), manifest.expectedOutputHash);
    assert.equal(outputBytes, manifest.expectedOutputBytes);
    const verifier = createVerifier(manifest);
    parsed.forEach((value, offset) => verifier.accept(delivered(value, offset + 1)));
    assert.deepEqual(verifier.finish(), { records: parsed.length, outputBytes, outputHash: manifest.expectedOutputHash });
  });

  test(`large-file CLI runs ${format} validation/import in fresh processes with byte-bounded batches`, async (t) => {
    const directory = await fixture(t);
    await writeFile(join(directory, 'keep.txt'), 'preexisting user file');
    const { code, signal, report } = await cli([
      '--format', format, '--bytes', '33333', '--mode', 'both', '--work-dir', directory,
      '--max-batch-bytes', '8192', '--batch-size', '1000',
    ]);
    assert.equal(code, 0, JSON.stringify(report));
    assert.equal(signal, null);
    assert.equal(report.status, 'passed');
    assert.equal(report.source.actualBytes, 33_333);
    assert.equal(report.cleanup.completed, true);
    assert.deepEqual(await readdir(directory), ['keep.txt']);
    assert.deepEqual(report.phases.map((phase) => phase.phase), ['validate', 'import']);
    assert.notEqual(report.phases[0].pid, report.phases[1].pid);
    for (const phase of report.phases) {
      assert.notEqual(phase.pid, process.pid);
      assert.equal(phase.status, 'completed');
      assert.equal(phase.verification.records, report.source.records);
      assert.equal(phase.verification.outputHash, report.source.expectedOutputHash);
      assert.equal(phase.runtime.execArgv.includes('--max-old-space-size=128'), true);
      assert.ok(phase.runtime.v8HeapSizeLimitBytes > 0);
      assert.ok(phase.memory.processMaxRssBytes > 0);
      assert.ok(phase.memory.progressBuckets.length <= 20);
      for (const field of ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']) assert.ok(phase.memory.peaks[field] > 0);
    }
    const imported = report.phases[1];
    assert.ok(imported.destination.batches > 1);
    assert.ok(imported.destination.maxBatchBytes <= 8192);
    assert.ok(imported.destination.maxBatchRecords < 1000);
    assert.equal(imported.memory.sampleCounts.batch, imported.destination.batches * 2);
    assert.match(imported.destination.persistence, /simulated/u);
  });
}

test('destination verifier rejects dropped, duplicated, reordered and changed records', async (t) => {
  const directory = await fixture(t);
  const manifest = await generateDataset(directory, parseOptions(['--format', 'jsonl', '--bytes', '15000', '--mode', 'import']));
  const parsed = await rows(manifest);
  const first = delivered(parsed[0], 1);
  const second = delivered(parsed[1], 2);
  const dropped = createVerifier(manifest);
  dropped.accept(first);
  assert.throws(() => dropped.finish(), /count, byte count, or digest/u);
  const duplicated = createVerifier(manifest);
  duplicated.accept(first);
  assert.throws(() => duplicated.accept(first), /sequence mismatch/u);
  assert.throws(() => createVerifier(manifest).accept(second), /sequence mismatch/u);
  assert.throws(() => createVerifier(manifest).accept({ ...first, value: first.value.replace(/A|B/u, '!') }), /value mismatch/u);
  const badDigest = createVerifier({ ...manifest, expectedOutputHash: '0'.repeat(64) });
  parsed.forEach((value, offset) => badDigest.accept(delivered(value, offset + 1)));
  assert.throws(() => badDigest.finish(), /digest/u);
});

test('CLI separately exercises larger records and a slow simulated destination', async (t) => {
  const directory = await fixture(t);
  const { code, report } = await cli([
    '--format', 'jsonl', '--bytes', '500000', '--mode', 'import', '--work-dir', directory,
    '--row-bytes', '65536', '--max-batch-bytes', '131072', '--slow-ms', '15', '--sample-ms', '10',
  ]);
  assert.equal(code, 0, JSON.stringify(report));
  assert.equal(report.phases[0].verification.records, report.source.records);
  assert.equal(report.phases[0].destination.slowMillisecondsPerBatch, 15);
  assert.ok(report.phases[0].memory.sampleCounts.timer > 0);
  assert.ok(report.phases[0].destination.maxBatchBytes <= 131072);
  assert.deepEqual(await readdir(directory), []);
});

test('CLI returns a failed report and cleans only its own run when a record exceeds the byte cap', async (t) => {
  const directory = await fixture(t);
  await writeFile(join(directory, 'keep.txt'), 'untouched');
  const { code, report } = await cli([
    '--format', 'jsonl', '--bytes', '10000', '--mode', 'import', '--work-dir', directory, '--max-batch-bytes', '10',
  ]);
  assert.equal(code, 1);
  assert.equal(report.status, 'failed');
  assert.equal(report.phases[0].status, 'failed');
  assert.equal(report.phases[0].error.code, 'LIMIT_EXCEEDED');
  assert.equal(report.cleanup.completed, true);
  assert.deepEqual(await readdir(directory), ['keep.txt']);
});

test('CLI rejects unsafe sizes and implicit record-limit overrides before creating data', async (t) => {
  const directory = await fixture(t);
  for (const extra of [
    ['--bytes', '9007199254740992'], ['--bytes', '0'], ['--bytes', '1'],
    ['--bytes', '10000', '--max-records', '1'], ['--bytes', '10000', '--unknown', 'x'],
  ]) {
    const { code, report } = await cli(['--format', 'csv', '--mode', 'import', '--work-dir', directory, ...extra]);
    assert.equal(code, 1);
    assert.equal(report.status, 'failed');
    assert.ok(report.error.message.length > 0);
  }
  assert.deepEqual(await readdir(directory), []);
  assert.throws(() => parseOptions(['--format', 'csv', '--bytes', '10000']), /--mode/u);
  assert.throws(() => parseOptions(['--format', 'csv', '--bytes', '10000', '--mode', 'import', '--batch-size', '10001']), /10000/u);
});
