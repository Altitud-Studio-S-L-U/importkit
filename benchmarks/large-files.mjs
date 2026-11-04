import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { availableParallelism, cpus, release, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';
import { parseArgs } from 'node:util';

const MIB = 1_048_576;
const HEADER = 'sequence,amount,payload\n';
const SCRIPT = fileURLToPath(import.meta.url);
const MEMORY_FIELDS = ['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers'];
const DEFAULTS = {
  rowBytes: 4096, batchSize: 1000, maxBatchBytes: MIB, maxRecords: 10_000_000,
  sampleMs: 50, rssBudgetMiB: 512, heapBudgetMiB: 128, slowMs: 0,
};

export function parseOptions(args) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    format: { type: 'string' }, bytes: { type: 'string' }, mode: { type: 'string' },
    'work-dir': { type: 'string', default: '.tmp' }, 'require-cgroup': { type: 'boolean', default: false },
    'row-bytes': { type: 'string' }, 'batch-size': { type: 'string' }, 'max-batch-bytes': { type: 'string' },
    'max-records': { type: 'string' }, 'sample-ms': { type: 'string' }, 'rss-budget-mib': { type: 'string' },
    'heap-budget-mib': { type: 'string' }, 'slow-ms': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) return { help: true };
  if (!['csv', 'jsonl'].includes(values.format)) throw new Error('--format must be csv or jsonl.');
  if (!['import', 'validate', 'both'].includes(values.mode)) throw new Error('--mode must be import, validate, or both.');
  const integer = (name, value, minimum = 1) => {
    if (!/^\d+$/u.test(String(value))) throw new Error(`${name} must be an integer >= ${minimum}.`);
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`${name} must be a safe integer >= ${minimum}.`);
    return result;
  };
  const options = {
    format: values.format, bytes: integer('--bytes', values.bytes), mode: values.mode,
    workDir: resolve(values['work-dir']), requireCgroup: values['require-cgroup'],
  };
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const flag = key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
    options[key] = integer(`--${flag}`, values[flag] ?? fallback, key === 'slowMs' ? 0 : 1);
  }
  if (options.batchSize > 10_000) throw new Error('--batch-size must be <= 10000 (ImportKit limit).');
  if (options.rowBytes < 256 || options.rowBytes > 16 * MIB) throw new Error('--row-bytes must be between 256 and 16777216.');
  if (options.sampleMs < 10) throw new Error('--sample-ms must be >= 10.');
  datasetLayout(options);
  return options;
}

function fields(index, payloadBytes) {
  return {
    sequence: String(index).padStart(12, '0'), amount: String(1000 + index % 900_000).padStart(6, '0'),
    payload: String.fromCharCode(65 + index % 26).repeat(payloadBytes),
  };
}

function encodeRow(format, value) {
  return format === 'csv' ? `${value.sequence},${value.amount},${value.payload}\n` : `${JSON.stringify(value)}\n`;
}

function canonical(value) { return `${value.sequence}\t${value.amount}\t${value.payload}\n`; }

export function datasetLayout({ format, bytes, rowBytes = DEFAULTS.rowBytes, maxRecords = DEFAULTS.maxRecords }) {
  const headerBytes = format === 'csv' ? Buffer.byteLength(HEADER) : 0;
  const overhead = Buffer.byteLength(encodeRow(format, fields(1, 0)));
  const contentBytes = bytes - headerBytes;
  const records = Math.ceil(contentBytes / rowBytes);
  if (contentBytes < overhead + 1 || records < 1) throw new Error('--bytes is too small for one synthetic record.');
  if (records > maxRecords) throw new Error(`Dataset needs ${records} records; increase --max-records explicitly.`);
  const tailBytes = contentBytes - Math.max(0, records - 2) * rowBytes;
  if (records > 1 && Math.floor(tailBytes / 2) < overhead + 1) throw new Error('--row-bytes is too small for this format.');
  return { format, bytes, rowBytes, headerBytes, overhead, records, tailBytes };
}

function widthAt(layout, index) {
  if (layout.records === 1) return layout.tailBytes;
  if (index <= layout.records - 2) return layout.rowBytes;
  return index === layout.records - 1 ? Math.floor(layout.tailBytes / 2) : Math.ceil(layout.tailBytes / 2);
}

function expectedValue(layout, index) { return fields(index, widthAt(layout, index) - layout.overhead); }

export async function generateDataset(directory, options) {
  const layout = datasetLayout(options);
  const path = join(directory, `source.${options.format}`);
  const handle = await open(path, 'wx', 0o600);
  const sourceDigest = createHash('sha256');
  const outputDigest = createHash('sha256');
  let outputBytes = 0;
  let pending = [];
  let pendingBytes = 0;
  let writtenBytes = 0;
  let nextProgress = 256 * MIB;
  const started = performance.now();
  const flush = async () => {
    if (pendingBytes === 0) return;
    const chunk = Buffer.from(pending.join(''), 'utf8');
    // FileHandle.write may write fewer bytes than requested, even for a regular file.
    let offset = 0;
    while (offset < chunk.length) {
      const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
      if (bytesWritten === 0) throw new Error('Source write made no progress.');
      offset += bytesWritten;
    }
    sourceDigest.update(chunk);
    writtenBytes += chunk.length;
    pending = []; pendingBytes = 0;
    if (writtenBytes >= nextProgress) {
      process.stderr.write(`generate ${options.format}: ${writtenBytes}/${options.bytes} bytes\n`);
      nextProgress = writtenBytes + 256 * MIB;
    }
  };
  try {
    if (layout.headerBytes) { pending.push(HEADER); pendingBytes += layout.headerBytes; }
    for (let index = 1; index <= layout.records; index++) {
      const value = expectedValue(layout, index);
      const row = encodeRow(options.format, value);
      const logical = canonical(value);
      outputDigest.update(logical);
      outputBytes += Buffer.byteLength(logical);
      if (pendingBytes + row.length > MIB) await flush();
      pending.push(row); pendingBytes += row.length;
    }
    await flush();
    await handle.sync();
  } finally { await handle.close(); }
  const info = await stat(path);
  if (info.size !== options.bytes || writtenBytes !== options.bytes) throw new Error('Generated source size differs from requested bytes.');
  return {
    ...layout, path, actualBytes: info.size, allocatedBytes: typeof info.blocks === 'number' ? info.blocks * 512 : null,
    sourceHash: sourceDigest.digest('hex'), expectedOutputHash: outputDigest.digest('hex'), expectedOutputBytes: outputBytes,
    generation: { elapsedMs: performance.now() - started, writeMethod: 'sequential full writes followed by fsync; no sparse allocation or truncation', excludedFromPhaseTiming: true },
  };
}

export function createVerifier(manifest) {
  const digest = createHash('sha256');
  let count = 0;
  let bytes = 0;
  return {
    accept(record) {
      const index = count + 1;
      if (record.index !== index) throw new Error(`Destination sequence mismatch at record ${index}.`);
      if (typeof record.id !== 'string' || !/^[a-f0-9]{64}$/u.test(record.id)) throw new Error('Destination received an invalid stable ID.');
      const expected = canonical(expectedValue(manifest, index));
      if (record.value !== expected) throw new Error(`Destination value mismatch at record ${index}.`);
      digest.update(record.value);
      bytes += Buffer.byteLength(record.value);
      count++;
    },
    finish() {
      const outputHash = digest.digest('hex');
      if (count !== manifest.records || bytes !== manifest.expectedOutputBytes || outputHash !== manifest.expectedOutputHash) {
        throw new Error('Destination count, byte count, or digest differs from generated input.');
      }
      return { records: count, outputBytes: bytes, outputHash };
    },
    get count() { return count; },
  };
}

export async function readCgroup() {
  if (process.platform !== 'linux') return { available: false, reason: 'Linux cgroup v2 is unavailable on this platform.' };
  try {
    const membership = await readFile('/proc/self/cgroup', 'utf8');
    const match = membership.split('\n').find((line) => line.startsWith('0::'));
    if (!match) return { available: false, reason: 'No unified cgroup v2 membership.' };
    const membershipPath = match.slice(3);
    const directory = resolve('/sys/fs/cgroup', `.${membershipPath}`);
    if (directory !== '/sys/fs/cgroup' && !directory.startsWith(`/sys/fs/cgroup${sep}`)) throw new Error('Invalid cgroup membership path.');
    const names = ['memory.max', 'memory.current', 'memory.peak', 'memory.swap.max', 'memory.swap.current', 'memory.swap.peak', 'memory.events', 'memory.events.local'];
    const values = {};
    for (const name of names) {
      try {
        const raw = (await readFile(join(directory, name), 'utf8')).trim();
        values[name] = name.startsWith('memory.events')
          ? Object.fromEntries(raw.split('\n').map((line) => { const [key, value] = line.split(/\s+/u); return [key, Number(value)]; }))
          : raw === 'max' ? 'max' : Number(raw);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
        values[name] = null;
      }
    }
    return { available: true, path: membershipPath, ...values };
  } catch (error) { return { available: false, reason: error.message }; }
}

function cgroupIsEnforced(cgroup, options) {
  return cgroup.available && Number.isFinite(cgroup['memory.max']) && cgroup['memory.max'] > 0
    && cgroup['memory.max'] <= options.rssBudgetMiB * MIB && cgroup['memory.swap.max'] === 0;
}

function sampler(totalRecords, sampleMs) {
  const peaks = Object.fromEntries(MEMORY_FIELDS.map((key) => [key, 0]));
  const buckets = new Map();
  const reasons = { timer: 0, batch: 0, mapping: 0, boundary: 0 };
  let records = 0;
  const started = performance.now();
  let baseline;
  function sample(reason) {
    const usage = process.memoryUsage();
    const value = { elapsedMs: performance.now() - started, records, ...usage };
    baseline ??= value;
    for (const key of MEMORY_FIELDS) peaks[key] = Math.max(peaks[key], usage[key]);
    reasons[reason]++;
    const bucket = Math.min(19, Math.floor(records / Math.max(1, totalRecords) * 20));
    const previous = buckets.get(bucket);
    if (!previous) buckets.set(bucket, { bucket, samples: 1, first: value, last: value, peaks: { ...usage } });
    else {
      previous.samples++; previous.last = value;
      for (const key of MEMORY_FIELDS) previous.peaks[key] = Math.max(previous.peaks[key], usage[key]);
    }
  }
  sample('boundary');
  const timer = setInterval(() => sample('timer'), sampleMs);
  timer.unref();
  return {
    progress(value) { records = value; }, sample,
    finish() {
      clearInterval(timer); sample('boundary');
      return { baseline, peaks, processMaxRssBytes: process.resourceUsage().maxRSS * 1024, sampleCounts: reasons,
        progressBuckets: [...buckets.values()], bucketLimit: 20, sampleIntervalMs: sampleMs };
    },
  };
}

function safeError(error) { return { name: error?.name ?? 'Error', code: error?.code ?? null, message: error?.message ?? String(error) }; }

async function runWorker(config) {
  const { options, manifest, phase, checkpointPath } = config;
  const cgroupBefore = await readCgroup();
  if (options.requireCgroup && !cgroupIsEnforced(cgroupBefore, options)) throw new Error('Required finite cgroup memory.max <= RSS budget and memory.swap.max=0 are not verified.');
  const { importFile, validateFile, csvReader, fileSource, jsonlReader } = await import('../dist/index.js');
  const reader = options.format === 'csv' ? csvReader() : jsonlReader();
  const verified = createVerifier(manifest);
  const memory = sampler(manifest.records, options.sampleMs);
  let mapped = 0;
  let batches = 0;
  let maxBatchBytes = 0;
  let maxBatchRecords = 0;
  let nextProgress = 256 * MIB;
  const mapRecord = (input, context) => {
    const expected = expectedValue(manifest, context.index);
    if (input === null || typeof input !== 'object' || input.sequence !== expected.sequence || input.amount !== expected.amount || input.payload !== expected.payload) {
      throw new Error('Synthetic input differs from deterministic generated values.');
    }
    const value = canonical(input);
    mapped++;
    memory.progress(mapped);
    if (mapped % 1000 === 0) memory.sample('mapping');
    if (phase === 'validate') verified.accept({ ...context, value });
    const approximateSourceBytes = Math.min(manifest.actualBytes, mapped * manifest.rowBytes + manifest.headerBytes);
    if (approximateSourceBytes >= nextProgress) {
      process.stderr.write(`${phase} ${options.format}: ${mapped}/${manifest.records} records (~${approximateSourceBytes} source bytes)\n`);
      nextProgress = approximateSourceBytes + 256 * MIB;
    }
    return value;
  };
  const common = {
    source: fileSource(manifest.path), reader, importId: 'large-files-benchmark-v1', transformVersion: 'canonical-tsv-v1',
    mapRecord, limits: { maxSourceBytes: manifest.actualBytes, maxRecordBytes: Math.max(manifest.rowBytes, manifest.headerBytes), maxRecords: options.maxRecords },
  };
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  let result;
  let verification;
  let failure;
  try {
    if (phase === 'validate') result = await validateFile(common);
    else result = await importFile({
      ...common, checkpointPath, batchSize: options.batchSize, maxBatchBytes: options.maxBatchBytes,
      measureRecordBytes: (value) => Buffer.byteLength(value, 'utf8'),
      async commitBatch(records) {
        memory.sample('batch');
        const bytes = records.reduce((sum, record) => sum + Buffer.byteLength(record.value, 'utf8'), 0);
        if (records.length > options.batchSize || bytes > options.maxBatchBytes) throw new Error('Destination observed a batch exceeding the configured limits.');
        maxBatchBytes = Math.max(maxBatchBytes, bytes); maxBatchRecords = Math.max(maxBatchRecords, records.length);
        for (const record of records) verified.accept(record);
        if (options.slowMs) await delay(options.slowMs);
        batches++;
        memory.sample('batch');
      },
    });
    if (result.status !== (phase === 'validate' ? 'valid' : 'completed') || result.sourceHash !== manifest.sourceHash || result.processedRecords !== manifest.records) {
      throw new Error('Library result differs from the generated source manifest.');
    }
    verification = verified.finish();
  } catch (error) { failure = safeError(error); }
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const measuredMemory = memory.finish();
  const cgroupAfter = await readCgroup();
  const eventsBefore = cgroupBefore['memory.events'];
  const eventsAfter = cgroupAfter['memory.events'];
  const eventDelta = eventsBefore && eventsAfter
    ? Object.fromEntries(Object.entries(eventsAfter).map(([key, value]) => [key, value - (eventsBefore[key] ?? 0)])) : null;
  const budget = {
    rssTargetBytes: options.rssBudgetMiB * MIB, heapUsedTargetBytes: options.heapBudgetMiB * MIB,
    rssWithinTarget: measuredMemory.processMaxRssBytes < options.rssBudgetMiB * MIB,
    sampledHeapUsedWithinTarget: measuredMemory.peaks.heapUsed <= options.heapBudgetMiB * MIB,
    cgroupEnforced: cgroupIsEnforced(cgroupBefore, options),
    oomEventsZero: eventDelta && Number.isFinite(eventDelta.oom) && Number.isFinite(eventDelta.oom_kill)
      ? eventDelta.oom === 0 && eventDelta.oom_kill === 0 && (eventDelta.oom_group_kill ?? 0) === 0 : null,
  };
  return {
    phase, status: failure ? 'failed' : 'completed', ...(failure ? { error: failure } : { result, verification }),
    pid: process.pid, elapsedMs, logicalSourceMegabytesPerSecond: manifest.actualBytes / 1_000_000 / (elapsedMs / 1000), cpuMicroseconds: cpu,
    mappedRecords: mapped, destination: phase === 'import' ? { batches, maxBatchBytes, maxBatchRecords,
      persistence: 'simulated acknowledgment only; bounded order/value/count/SHA-256 verifier; no database or destination fsync', slowMillisecondsPerBatch: options.slowMs } : null,
    memory: measuredMemory, budget, cgroup: { before: cgroupBefore, after: cgroupAfter, eventDelta },
    runtime: { node: process.version, execArgv: process.execArgv, v8HeapSizeLimitBytes: getHeapStatistics().heap_size_limit },
  };
}

async function launchWorker(config) {
  const configPath = join(dirname(config.checkpointPath), `${config.phase}-worker.json`);
  const handle = await open(configPath, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(config)); } finally { await handle.close(); }
  return await new Promise((resolveResult) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, [`--max-old-space-size=${config.options.heapBudgetMiB}`, SCRIPT, '--worker', configPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let tail = '';
    let spawnError;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.length > MIB) { spawnError = new Error('Worker JSON exceeded the 1 MiB report limit.'); child.kill(); }
    });
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); tail = (tail + chunk).slice(-8192); });
    child.on('error', (error) => { spawnError = error; });
    child.on('close', (code, signal) => {
      try {
        if (spawnError) throw spawnError;
        if (code !== 0 || signal) {
          try {
            const report = JSON.parse(output);
            if (report.status === 'failed') { resolveResult({ phase: config.phase, ...report, exitCode: code, signal }); return; }
          } catch { /* An OOM or native crash may not produce a JSON result. */ }
          throw new Error(`Worker exited with code ${code}, signal ${signal}; stderr tail: ${tail}`);
        }
        resolveResult({ phase: config.phase, ...JSON.parse(output) });
      } catch (error) { resolveResult({ phase: config.phase, status: 'failed', error: safeError(error), exitCode: code, signal }); }
    });
  });
}

export async function runBenchmark(options) {
  const startedAt = new Date().toISOString();
  const phases = [];
  let directory;
  let manifest;
  let failure;
  const cgroupBefore = await readCgroup();
  const cleanup = { attempted: false, completed: false };
  try {
    if (options.requireCgroup && !cgroupIsEnforced(cgroupBefore, options)) throw new Error('Required finite cgroup memory.max <= RSS budget and memory.swap.max=0 are not verified.');
    await mkdir(options.workDir, { recursive: true });
    directory = await mkdtemp(join(options.workDir, 'large-files-'));
    manifest = await generateDataset(directory, options);
    for (const phase of options.mode === 'both' ? ['validate', 'import'] : [options.mode]) {
      const result = await launchWorker({ options, manifest, phase, checkpointPath: join(directory, 'checkpoint.json') });
      phases.push(result);
      if (result.status !== 'completed') break;
    }
  } catch (error) { failure = safeError(error); }
  finally {
    if (directory) {
      cleanup.attempted = true;
      try {
        const owned = relative(resolve(options.workDir), resolve(directory));
        if (!owned || owned.startsWith(`..${sep}`) || owned === '..' || isAbsolute(owned) || !owned.startsWith('large-files-') || owned.includes(sep)) {
          throw new Error('Refusing cleanup outside the unique benchmark run directory.');
        }
        await rm(directory, { recursive: true, force: false });
        cleanup.completed = true;
      } catch (error) { cleanup.error = safeError(error); }
    }
  }
  const cgroupAfter = await readCgroup();
  const successful = !failure && !cleanup.error && phases.length > 0 && phases.every((phase) => phase.status === 'completed'
    && phase.budget.rssWithinTarget && phase.budget.sampledHeapUsedWithinTarget
    && (options.requireCgroup ? phase.budget.oomEventsZero === true : phase.budget.oomEventsZero !== false));
  return {
    schemaVersion: 1, benchmark: 'importkit-large-files', status: successful ? 'passed' : 'failed', startedAt, finishedAt: new Date().toISOString(),
    ...(failure ? { error: failure } : {}), options, source: manifest, phases, cleanup, cgroup: { before: cgroupBefore, after: cgroupAfter },
    machine: { platform: process.platform, architecture: process.arch, kernel: release(), logicalCpuCount: cpus().length,
      availableParallelism: availableParallelism(), cpuModel: cpus()[0]?.model ?? null, systemTotalMemoryBytes: totalmem(), node: process.version },
    methodology: {
      units: 'Source bytes and GB are decimal; MiB=1048576 bytes; all memory values are bytes. maxRSS from Node KiB is converted to bytes.',
      processIsolation: 'One fresh Node process per phase; no record or destination state is reused between validate and import.',
      timing: 'performance.now wall clock around the library call, including verifier/sampling/checkpoint overhead; excludes generation, module loading, and process launch.',
      throughput: 'Logical source bytes divided by library-call time, not physical disk throughput. Fingerprint/parse reads may scan the source multiple times.',
      cache: 'No cache eviction; generation and earlier phases warm filesystem caches. Results describe this workload and environment, not a performance guarantee.',
      memory: 'Timer, mapping and batch samples with at most 20 progress buckets. Observed heapUsed is sampled, not an absolute peak. external includes arrayBuffers; do not sum them.',
      enforcement: 'Child --max-old-space-size sets V8 old-generation size only, not total heap or RSS. --require-cgroup verifies memory.max and zero swap. cgroup peak includes parent, page cache, and earlier phases; it is never reset.',
      workload: 'Deterministic ASCII synthetic records. Last two records split the remainder for an exact byte size. Does not represent every CSV shape, storage system, or transformation.',
      destination: 'Simulated commit acknowledgment with bounded strict order/value/count/digest checks. No real database or durable destination; ImportKit checkpoints still use the real filesystem.',
      cleanup: 'Only the newly created large-files-* run directory is removed after all requested phases; generated source is retained until then.',
    },
  };
}

async function main() {
  if (process.argv[2] === '--worker') {
    try {
      const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
      const report = await runWorker(config);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      if (report.status !== 'completed') process.exitCode = 1;
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ status: 'failed', error: safeError(error) })}\n`);
      process.exitCode = 1;
    }
    return;
  }
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('node benchmarks/large-files.mjs --format csv|jsonl --bytes 1000000000 --mode import|validate|both [--work-dir .tmp] [--require-cgroup]\nOptional: --row-bytes 4096 --batch-size 1000 --max-batch-bytes 1048576 --max-records 10000000 --sample-ms 50 --rss-budget-mib 512 --heap-budget-mib 128 --slow-ms 0\n');
      return;
    }
    const report = await runBenchmark(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, benchmark: 'importkit-large-files', status: 'failed', error: safeError(error) }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
