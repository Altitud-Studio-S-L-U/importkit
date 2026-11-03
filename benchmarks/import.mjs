import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { fileSource, importFile, jsonlReader, validateFile } from '../dist/index.js';

const rows = Number(process.argv[2] ?? 100_000);
const batchSize = Number(process.argv[3] ?? 1_000);
if (!Number.isSafeInteger(rows) || rows < 100_000 || rows > 10_000_000) {
  throw new RangeError('rows must be an integer from 100,000 through 10,000,000.');
}
if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
  throw new RangeError('batchSize must be an integer from 1 through 10,000.');
}

const scratchRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp');
await mkdir(scratchRoot, { recursive: true });
const directory = await mkdtemp(join(scratchRoot, 'benchmark-'));
const sourcePath = join(directory, 'synthetic-orders.jsonl');
let sourceHandle;
let sinkHandle;
let observe = () => {};

async function measure(run) {
  let peakRssBytes = 0;
  let peakHeapUsedBytes = 0;
  const sample = () => {
    const memory = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, memory.rss);
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
  };
  observe = sample;
  sample();
  const timer = setInterval(sample, 10);
  const start = performance.now();
  try {
    const result = await run();
    sample();
    return {
      result,
      measurement: { wallMilliseconds: Number((performance.now() - start).toFixed(2)), observedPeakRssBytes: peakRssBytes, observedPeakHeapUsedBytes: peakHeapUsedBytes },
    };
  } finally {
    clearInterval(timer);
    observe = () => {};
  }
}

try {
  sourceHandle = await open(sourcePath, 'wx', 0o600);
  for (let offset = 0; offset < rows; offset += 1_000) {
    const lines = Array.from({ length: Math.min(1_000, rows - offset) }, (_, position) => {
      const id = offset + position + 1;
      return `${JSON.stringify({ orderId: `DEMO-${id}`, sku: `SKU-${id % 97}`, units: id % 20 + 1 })}\n`;
    });
    await sourceHandle.writeFile(lines.join(''));
  }
  await sourceHandle.close();
  sourceHandle = undefined;
  const sourceBytes = (await stat(sourcePath)).size;
  const options = {
    source: fileSource(sourcePath),
    reader: jsonlReader(),
    importId: 'synthetic-benchmark',
    transformVersion: 'orders-v1',
    mapRecord(input, { index }) {
      if (index % 1_000 === 0) observe();
      if (input === null || typeof input !== 'object' || !Number.isSafeInteger(input.units) || input.units < 1) {
        throw new Error('Invalid synthetic order.');
      }
      return input;
    },
  };
  const validation = await measure(() => validateFile(options));
  assert.equal(validation.result.status, 'valid');
  assert.equal(validation.result.processedRecords, rows);

  sinkHandle = await open(join(directory, 'destination.jsonl'), 'wx', 0o600);
  let writtenRecords = 0;
  const imported = await measure(() => importFile({
    ...options,
    checkpointPath: join(directory, 'progress.checkpoint.json'),
    batchSize,
    async commitBatch(records) {
      observe();
      await sinkHandle.writeFile(records.map((record) => `${JSON.stringify(record)}\n`).join(''));
      await sinkHandle.sync();
      writtenRecords += records.length;
    },
  }));
  assert.equal(imported.result.processedRecords, rows);
  assert.equal(writtenRecords, rows);
  const destinationBytes = (await sinkHandle.stat()).size;

  console.log(JSON.stringify({
    data: { synthetic: true, format: 'JSON Lines', records: rows, sourceBytes, destinationBytes, batchSize, sourceHash: imported.result.sourceHash },
    environment: { node: process.version, platform: process.platform, architecture: process.arch, osRelease: release() },
    validation: validation.measurement,
    import: { ...imported.measurement, committedBatches: imported.result.committedBatches },
    processHighWaterRssBytes: process.resourceUsage().maxRSS * 1_024,
    methodology: {
      inputGeneration: 'Deterministic records generated in groups of at most 1,000; excluded from phase timings.',
      execution: 'Validation then import in one process; filesystem caches are not cleared between phases.',
      validation: 'Source fingerprint, parsing and mapping, final source fingerprint; no destination or checkpoint.',
      import: 'Fresh import: source fingerprint, parsing and mapping, append-only JSONL destination plus fsync per batch, and local checkpoint persistence. This benchmark sink does not deduplicate replays.',
      memory: 'Observed samples every 10 ms and 1,000 mapped records, and at destination commits. Process high-water RSS includes input generation and both phases.',
      scope: 'One local synthetic workload; timings and memory are observations, not universal throughput or memory guarantees.',
    },
  }, null, 2));
} finally {
  try { await sourceHandle?.close(); } finally {
    try { await sinkHandle?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
