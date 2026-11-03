import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { fileSource, importFile, jsonlReader } from '../dist/index.js';

const records = 20_000;
const batchSize = 100;
const destinationLatencyMs = Number(process.argv[2] ?? 20);
const levels = [1, 2, 4, 8];
// Set before measuring: with a destination that waits on every batch, four batches in
// flight must import at least three times as many records per second as one.
const criterion = { concurrency: 4, minimumSpeedup: 3 };
if (!Number.isSafeInteger(destinationLatencyMs) || destinationLatencyMs < 1 || destinationLatencyMs > 1_000) {
  throw new RangeError('The destination latency must be an integer from 1 through 1,000 milliseconds.');
}

/** Checkpoints in memory, so the measurement isolates the destination's latency from file system flushes. */
function memoryCheckpointStore() {
  let checkpoint;
  return {
    load: async () => checkpoint,
    save: async (next) => { checkpoint = next; },
  };
}

const scratchRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp');
await mkdir(scratchRoot, { recursive: true });
const directory = await mkdtemp(join(scratchRoot, 'throughput-'));
try {
  const sourcePath = join(directory, 'synthetic-orders.jsonl');
  const lines = Array.from({ length: records }, (_, index) => JSON.stringify({ orderId: `order-${index + 1}`, units: (index % 9) + 1 }));
  await writeFile(sourcePath, `${lines.join('\n')}\n`);

  const results = [];
  for (const concurrency of levels) {
    let delivered = 0;
    const started = performance.now();
    const result = await importFile({
      source: fileSource(sourcePath),
      reader: jsonlReader(),
      importId: `throughput-${concurrency}`,
      transformVersion: 'v1',
      checkpointStore: memoryCheckpointStore(),
      batchSize,
      concurrency,
      mapRecord: (input) => input,
      async commitBatch(batch) {
        await delay(destinationLatencyMs);
        delivered += batch.length;
      },
    });
    const seconds = (performance.now() - started) / 1_000;
    assert.equal(result.processedRecords, records);
    assert.equal(delivered, records);
    results.push({ concurrency, seconds: Number(seconds.toFixed(3)), recordsPerSecond: Math.round(records / seconds) });
  }

  const baseline = results.find((result) => result.concurrency === 1).recordsPerSecond;
  const measured = results.find((result) => result.concurrency === criterion.concurrency).recordsPerSecond;
  const speedup = Number((measured / baseline).toFixed(2));
  console.log(JSON.stringify({
    data: { synthetic: true, format: 'JSON Lines', records, batchSize, batches: records / batchSize, destinationLatencyMs },
    environment: { node: process.version, platform: process.platform, architecture: process.arch, availableParallelism: availableParallelism() },
    results: results.map((result) => ({ ...result, speedup: Number((result.recordsPerSecond / baseline).toFixed(2)) })),
    criterion: { ...criterion, speedup, met: speedup >= criterion.minimumSpeedup },
    methodology: {
      destination: 'Each commitBatch call waits a fixed time and then resolves, like a remote database or API whose latency dominates.',
      checkpoints: 'Kept in memory, so file system flushes do not mask the effect of concurrency.',
      execution: 'One fresh import per concurrency level, in increasing order, in one process; input generation is excluded.',
      scope: 'One local synthetic workload; the figures are observations, not throughput guarantees.',
    },
  }, null, 2));
  if (speedup < criterion.minimumSpeedup) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
