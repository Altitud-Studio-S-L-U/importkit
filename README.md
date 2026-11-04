```text
  ___ __  __ ____   ___  ____ _____ _  _____ _____
 |_ _|  \/  |  _ \ / _ \|  _ \_   _| |/ /_ _|_   _|
  | || |\/| | |_) | | | | |_) || | | ' / | |  | |
  | || |  | |  __/| |_| |  _ < | | | . \ | |  | |
 |___|_|  |_|_|    \___/|_| \_\|_| |_|\_\___| |_|

  files --> records --> batches --> checkpoint
                           |              |
                           +-- persist ---+
```

# ImportKit

**Validate and resume file imports for Node.js backends.** Stream records, inspect bounded validation reports, commit batches, and recover with stable record IDs.

[Import API](#use-in-your-backend) · [Validation API](#validate-before-importing) · [Recovery contract](#the-recovery-contract) · [Run the demos](#try-it) · [Contributing](CONTRIBUTING.md)

ImportKit handles the part between reading a file and writing validated records to your application. It coordinates parsing, mapping, sequential batches, and local checkpoints. You supply the validation rules and destination writes.

Built by [Altitud Studio](https://altitudstudio.ad/en/). MIT licensed. Source version `0.3.0`; the API may change before `1.0`.

## What is included

| Capability | Scope |
| --- | --- |
| File readers | CSV with a header row; JSON Lines / NDJSON |
| Processing | Async mapping and one destination batch at a time |
| Prevalidation | Read-only traversal, bounded mapping issues, explicit incomplete parsing reports |
| Recovery | SHA-256 source identity, validated checkpoints, stable record IDs |
| Resource controls | Source bytes, record bytes/count, records per batch, and optional measured batch bytes |
| Failure handling | Fail-fast imports, validation issue counts, operational errors, cooperative cancellation |
| Integration | A TypeScript library with a format-independent `RecordReader` contract |

XLSX, ZIP archives, XML, PDF extraction, remote downloads, and automatic retries are outside this version. Additional formats can implement `RecordReader`; their decoding and resource limits remain the reader's responsibility.

## Try it

Requirements: **Node.js 24 or newer** and npm.

```sh
git clone https://github.com/Altitud-Studio-S-L-U/importkit.git
cd importkit
npm ci
npm run check
npm run demo
```

The first demo validates synthetic CSV records: it counts two invalid records while retaining one issue, reports an incomplete traversal for malformed CSV, and validates corrected input. It opens no destination or checkpoint.

The recovery demo imports five fictional orders into a local SQLite database. It deliberately throws **after** the first database commit, before ImportKit can save that batch's checkpoint. A second run replays those records and the destination deduplicates them by record ID.

Expected recovery result: **seven delivery attempts, five stored records, two deduplicated replays**. This is a fault simulation, not a benchmark or a claim of exactly-once delivery. The example uses Node's built-in `node:sqlite`; Node versions that label it experimental may print a warning. The demos remove their own temporary files after running. Run either separately with `npm run demo:validation` or `npm run demo:recovery`.

Install the published package from [npm](https://www.npmjs.com/package/@altitud-studio/importkit):

```sh
npm install @altitud-studio/importkit
```

Versioned tarballs are also available through [GitHub Releases](https://github.com/Altitud-Studio-S-L-U/importkit/releases).

To build a tarball from a source checkout:

```sh
npm run build
npm pack
# In your application, install the generated tarball:
npm install /absolute/path/to/altitud-studio-importkit-0.3.0.tgz
```

## Use in your backend

```ts
import { csvReader, fileSource, importFile } from '@altitud-studio/importkit';

const result = await importFile({
  source: fileSource('./orders.csv'),
  reader: csvReader(),
  importId: 'orders-2026-11',
  transformVersion: 'orders-v1',
  checkpointPath: './orders.checkpoint.json',
  batchSize: 500,

  mapRecord(input, context) {
    // Validate input at this boundary. Throw to stop the import.
    const order = parseOrder(input);
    return { ...order, sourceRecordId: context.id };
  },

  async commitBatch(records) {
    // Application code: use an atomic batch or idempotent per-record writes.
    // Resolve only after durable persistence. Repeated IDs must be harmless.
    await saveOrdersIdempotently(records);
  },
});

console.log(result.status); // 'completed'
```

`parseOrder` and `saveOrdersIdempotently` are application functions, not ImportKit exports. See the [complete SQLite example](examples/recovery.mjs) for an executable integration.

Each destination record contains `{ id, index, value }`. `index` is the one-based parsed record ordinal; the CSV header is excluded. IDs are derived from the import ID, source content hash, reader ID, transform version, and record ordinal. Changing `batchSize` does not change them.

Use a stable `importId` for a logical import. Change `transformVersion` when validation, mapping, or destination semantics change. Existing checkpoints reject incompatible identities rather than silently starting over.

The result contains `processedRecords` (the total source record count, including records skipped during resume), `resumedFrom` (the starting checkpoint's record count), `committedBatches` (destination batches committed during this run), and `sourceHash` (the SHA-256 content hash).

## Validate before importing

`validateFile` accepts `source`, `reader`, `importId`, `transformVersion`, `mapRecord`, optional `limits` and `signal`, and optional `maxIssues`. It has no destination or checkpoint option. It awaits each mapping callback and discards the transformed value.

```ts
import { csvReader, fileSource, importFile, validateFile } from '@altitud-studio/importkit';

const file = {
  source: fileSource('./orders.csv'),
  reader: csvReader(),
  importId: 'orders-2026-11',
  transformVersion: 'orders-v1',
  mapRecord(input: unknown) {
    return parseOrder(input);
  },
};

const report = await validateFile({ ...file, maxIssues: 100 });
if (report.status === 'valid') {
  await importFile({
    ...file,
    checkpointPath: './orders.checkpoint.json',
    async commitBatch(records) {
      await saveOrdersIdempotently(records);
    },
  });
} else if (report.status === 'incomplete') {
  console.log(report.parseError.code, report.processedRecords);
} else {
  console.log(report.invalidRecords, report.issues, report.issuesTruncated);
}
```

`parseOrder` and `saveOrdersIdempotently` are application functions. The [validation demo](examples/validation.mjs) is executable without application services.

| Status | Meaning |
| --- | --- |
| `valid` | Structural parsing completed and every mapping callback succeeded |
| `invalid` | Structural parsing completed, but one or more mapping callbacks failed |
| `incomplete` | Structural parsing stopped; the unread remainder has not been validated |

Every result includes `sourceHash`, `processedRecords`, `validRecords`, `invalidRecords`, `issues`, and `issuesTruncated`. The counts cover records yielded by the reader: `validRecords + invalidRecords === processedRecords`. `invalidRecords` counts failed mapping callbacks; it does not invent a record for a structural parsing failure.

Each retained mapping issue has `{ code: 'MAP_ERROR', recordIndex, message }`. `recordIndex` is a one-based parsed record ordinal, including when CSV fields contain embedded newlines. `maxIssues` defaults to `100` and accepts integers from `0` through `10,000`. Further failures are still counted after the issue budget is reached; `issuesTruncated` indicates that mapping issues were omitted. Set `maxIssues: 0` for counts only.

An `incomplete` result additionally has `parseError: { code: 'PARSE_ERROR', message }`, even when the mapping issue budget is exhausted. Structural errors stop traversal; ImportKit does not guess a recovery position for a generic reader. Reader buffering can also mean that valid-looking records before the error were never yielded.

Messages in validation reports are constant library messages. Raw records, transformed values, application exception messages, and causes are excluded. Every exception thrown by `mapRecord` is treated as a failed record validation; keep this callback focused on input validation and free of side effects. Handle external service outages separately, or cancel the run rather than treating an outage as invalid file content.

Configuration, source access, source changes, cancellation, and resource-limit failures throw `ImportKitError`; they do not return a completed content report. Errors thrown by custom readers that use an operational `ImportKitError` code also propagate. Other reader exceptions are treated as structural parsing failures.

For unchanged content, reader, import ID, and transformation version, validation passes the same stable IDs to `mapRecord` as `importFile`. Validation itself creates, locks, or advances no checkpoint and calls no destination. Application callbacks remain responsible for their own behavior.

A complete validation normally reads the file three times: the initial fingerprint, parsing and mapping, and a final fingerprint after callbacks finish. The final pass detects same-size edits even where file timestamps lag. An incomplete parse still performs both full fingerprint passes. Keep the source immutable throughout; this is not a snapshot or a transaction spanning validation and a later import. `importFile` validates source identity again when it starts.

## The recovery contract

```text
parse -> map -> commitBatch -> save checkpoint -> next batch
                    |
                    +-- failure before checkpoint: replay on next run
```

1. ImportKit fingerprints the source before destination writes and validates any existing checkpoint.
2. It parses and maps records into sequential batches. A parsing or mapping failure stops the run; no rows are silently skipped.
3. After `commitBatch` resolves, ImportKit saves the checkpoint. A partial final batch follows the same contract.
4. On resume, the reader starts from the beginning and skips confirmed record ordinals. This handles CSV records containing embedded newlines without guessing byte offsets. Completed imports are also reparsed to revalidate the source and current reader limits; their confirmed records are not mapped or delivered again.

**Delivery is at least once.** The destination and local checkpoint do not share a transaction. A process can fail after destination writes succeed and before the checkpoint is saved. A destination callback can also persist data and then reject. Those records may be delivered again with the same IDs.

The destination must deduplicate IDs or provide equivalent idempotency. If it partially writes a batch, already-written records must tolerate replay. ImportKit cannot make external emails, payments, or other side effects transactional.

Keep the source file **immutable for the entire run**. A preflight hash identifies its content for resume; it does not turn a concurrently edited file into a stable snapshot. If necessary, copy an incoming upload into an application-owned, immutable staging location first.

### Checkpoints and concurrent runs

Checkpoints contain progress and identity metadata, not raw records. ImportKit writes a temporary checkpoint, flushes it, then renames it into place. The implementation also attempts directory synchronization where the platform supports it. Filesystem and operating-system durability guarantees still apply.

An exclusive `<checkpointPath>.lock` file prevents concurrent runs using that checkpoint. A hard process termination can leave the lock behind. Verify that the original process has stopped before manually removing that specific lock. Lock age alone is not evidence that a process is dead.

The checkpoint's parent directory must already exist; ImportKit does not create it. Use a local filesystem and one checkpoint per logical import. Shared filesystems, distributed locking, automatic stale-lock recovery, and multiple writers to the same destination are outside this version's coordination contract. Two different checkpoint paths do not coordinate with each other.

### Limits and backpressure

| Option | Default | Meaning |
| --- | --- | --- |
| `batchSize` | `500` | Maximum mapped records per destination call; integer from `1` through `10,000` |
| `maxBatchBytes` | Unset | Optional positive safe integer limiting the sum of measured record bytes in one batch |
| `measureRecordBytes` | Unset | Synchronous `(value, context) => number`; required together with `maxBatchBytes` |
| `limits.maxSourceBytes` | `1,073,741,824` (1 GiB) | Maximum source file size |
| `limits.maxRecordBytes` | `1,048,576` (1 MiB) | Maximum serialized UTF-8 bytes per record, including its terminator |
| `limits.maxRecords` | `10,000,000` | Maximum parsed records, including records visited during resume |

```ts
limits: {
  maxSourceBytes: 100_000_000,
  maxRecordBytes: 100_000,
  maxRecords: 1_000_000,
}
```

Source and record limits must be positive safe integers. `maxRecordBytes` also applies to the CSV header; delimiters, quotes, an initial BOM, and line terminators count toward serialized size. The built-in readers enforce record limits while decoding. Mapped values can be larger than their input, so source limits do not bound transformed values. Mapping, measurement and destination callbacks must bound their own allocations and work.

### Bound a batch by measured bytes

Without the two byte-budget options, imports retain their existing count-only behavior: `batchSize` controls when a pending batch is committed. To enable byte accounting, supply **both** `maxBatchBytes` and `measureRecordBytes`. The count limit continues to apply.

```ts
await importFile({
  source: fileSource('./orders.csv'),
  reader: csvReader(),
  importId: 'orders-2026-11',
  transformVersion: 'encoded-orders-v1',
  checkpointPath: './orders.checkpoint.json',
  batchSize: 500,
  maxBatchBytes: 4 * 1024 * 1024, // 4 MiB of measured record payloads
  mapRecord(input) {
    return `${JSON.stringify(parseOrder(input))}\n`;
  },
  measureRecordBytes(value) {
    return Buffer.byteLength(value, 'utf8');
  },
  async commitBatch(records) {
    await saveEncodedOrdersIdempotently(records);
  },
});
```

The application functions validate and encode orders, then persist them idempotently using each record's stable ID. Here the measurement covers each UTF-8 JSON line, including its newline. It does not include additional database, request or batch-envelope overhead. ImportKit does not stringify arbitrary mapped values on your behalf.

The measurement callback receives the mapped `value` and `{ id, index }`. It runs once for each successfully mapped, unconfirmed record reached during an attempt and must return a **nonnegative safe integer** synchronously; zero is allowed. Thrown errors, negative or fractional sizes, `NaN`, infinity and Promise results fail with `MEASURE_ERROR` and the record ordinal. Missing one of the two options is invalid configuration. Measurement should be deterministic and free of side effects; a retry can map and measure uncheckpointed records again.

Keep mapped values and their measured representation unchanged until their destination call resolves. Reusing a mutable object or buffer across records can change already measured values; ImportKit retains the supplied values rather than deep-cloning them.

If the next record would exceed the remaining byte budget, ImportKit commits the previous batch before adding that record. Equality with either limit commits immediately. A single record measured above `maxBatchBytes` fails with `LIMIT_EXCEEDED` **before** flushing a pending previous batch. Earlier committed batches remain committed. Checkpoints always advance to the last record in the committed batch, including when a later record has already been mapped for the size decision.

Byte accounting changes batch grouping, not record IDs or the checkpoint schema. Batch limits can change on resume without changing stable IDs. Delivery remains at least once, and the destination retains its idempotency responsibility. `maxBatchBytes` limits reported payload sizes, not V8 heap or process RSS; mapping and measurement happen before an oversized result can be rejected.

## Readers

### CSV

```ts
reader: csvReader({ delimiter: ';' })
```

CSV uses the maintained [`csv-parse`](https://csv.js.org/parse/) parser. The first row supplies headers. Values remain strings; the application handles conversion and validation. Quoted fields, multiline fields, UTF-8, BOM, and CRLF are supported. Empty, duplicate, or unsafe headers and inconsistent column counts are rejected. Returned records use a null prototype.

### JSON Lines

```ts
import { jsonlReader } from '@altitud-studio/importkit';

reader: jsonlReader()
```

Each line is one JSON value. UTF-8, an initial BOM, CRLF, and a final line without a newline are supported. Blank lines, malformed JSON, and invalid UTF-8 are rejected. This is JSON Lines, not a reader for a single large JSON array.

### Other formats

The exported `RecordReader` interface accepts an async stream of bytes and yields records. Its `id` must identify the decoding rules and configuration. The same bytes and reader ID must produce the same record sequence. A custom reader must enforce `ReaderLimits` before buffering unbounded input and close its resources when iteration stops.

## Errors and cancellation

Catch `ImportKitError` and inspect its `code`. Categories include invalid options, source changes, limits, parsing, mapping, byte measurement, destination commits, checkpoints, import locks, and cancellation. `recordIndex` is available when relevant. Underlying failures may be attached as `cause`; treat causes as potentially containing application data when logging.

Pass an `AbortSignal` through `signal` for cooperative cancellation. Cancellation does not roll back an already committed destination batch. ImportKit records that batch's checkpoint before stopping. A running application callback must finish or implement its own cancellation and timeout policy.

## Time and space

These bounds describe the built-in readers under a conventional linear decoding model. Custom readers and application callbacks can have different costs.

| Symbol | Meaning |
| --- | --- |
| `N`, `R` | Source bytes and parsed records |
| `B`, `b` | Nonempty destination batches in this attempt, and the `batchSize` record cap |
| `K`, `S` | Optional measured batch-byte cap and maximum serialized source-record bytes |
| `H`, `I` | CSV column count and retained validation issues; header bytes are also bounded by `S` |

| Operation | Traversal and additional costs |
| --- | --- |
| Import | `O(N + R + H + B) + Σ map_i + Σ measure_i + Σ destination_j + Σ durability_j` |
| Validation | `O(N + R + H + I) + Σ map_i` |

The sums are the actual callback and persistence costs; measurement is absent in count-only mode. Callback execution, database work and filesystem synchronization are not constant-time guarantees.

A successful import reads approximately `2N` source bytes: fingerprinting, then parsing with another hash. A complete validation reads `3N`: fingerprinting, parsing with hashing, then a final fingerprint after callbacks. A structural parsing failure still requires both full fingerprint passes plus the parsed prefix. Validation followed by import therefore normally reads `5N`; filesystem caching does not remove these logical passes.

Recovery reparses from the start. It skips mapping and delivery for confirmed ordinals, but still fingerprints and decodes the whole source. A nearly complete checkpoint does not make traversal proportional to the remaining suffix. Checkpoints hold fixed metadata, bounded to 16 KiB, rather than an index or a list of every imported record; persistence performs `B + O(1)` checkpoint writes on a successful attempt.

Library bookkeeping retains batch references and record metadata, reader state and at most `I` validation issues; it does not accumulate all `R` records. Under a bounded decoded-representation model, auxiliary state scales with `O(S + H + b + I)`, excluding mapped values and callback-owned memory. CSV can amplify memory: many short or empty fields still allocate arrays, strings and object entries for `H` columns. Parser prefetch and headers also occupy memory; a source-byte limit is not a heap-byte limit.

For records that pass the individual size check, a pending batch reports at most `K` bytes. Deciding whether the next mapped record fits can temporarily retain that batch **and** one further record of up to `K` measured bytes. Thus retained measured payload can approach `2K`, in addition to wrappers, decoding and application work. Only when actual retained representations are bounded by their measurements can payload space be modelled as `O(K)`; arbitrary objects, shared backing stores and inaccurate measurements do not imply a heap bound. An oversized value can already have been allocated before rejection. In count-only mode, mapped batch space depends on the values produced by the application.

None of these bounds asserts constant process RSS. V8 allocation and garbage collection, native buffers, allocator fragmentation, runtime overhead and callback retention affect observed memory. Benchmark samples and operating-system high-water marks are measurements for their stated workload and environment, not a proof of a universal memory ceiling.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run demo
```

### Measure a synthetic workload

```sh
npm run benchmark -- 100000 1000
```

The arguments select the number of records (`100,000` through `10,000,000`) and import batch size (`1` through `10,000`). The [benchmark script](benchmarks/import.mjs) generates deterministic JSON Lines in groups of at most 1,000 records, validates them, then imports them to a local JSONL destination with `fsync` per batch and real checkpoints. It measures a fresh run; its append-only sink does not implement replay deduplication. Use the SQLite recovery demo to study idempotent destination writes. Temporary input, destination, and checkpoints are removed afterward.

The JSON report records the Node version, operating system, input and output bytes, source hash, record and batch counts, elapsed phase times, sampled RSS and heap usage, and process high-water RSS. Input generation is excluded from phase timings. Validation runs before import in the same process without clearing filesystem caches. Memory samples are observations, not a proof of the absolute peak; process high-water RSS includes both phases and data generation. Results describe that machine and workload, not universal throughput or memory guarantees.

### Exercise 1 GB and 10 GB files

The separate [large-file runner](benchmarks/large-files.mjs) generates exact-size synthetic CSV or JSON Lines files and runs each selected phase in a fresh Node process. File sizes use **decimal bytes**: `1 GB = 1,000,000,000` bytes. Memory-budget options use MiB (`1 MiB = 1,048,576` bytes).

```sh
npm run build
node benchmarks/large-files.mjs --format jsonl --bytes 1000000000 --mode both --work-dir /var/tmp/importkit-bench --require-cgroup
node benchmarks/large-files.mjs --format jsonl --bytes 10000000000 --mode import --work-dir /var/tmp/importkit-bench --require-cgroup
```

The first command validates and imports 1 GB; the second imports 10 GB. An import run does not also exercise `validateFile` unless the selected mode includes validation. Use `--format csv` for CSV. The runner sets `maxSourceBytes` explicitly for the generated file; it does not change the library's default source limit. Optional controls include `--row-bytes`, `--batch-size`, `--max-batch-bytes`, `--max-records`, `--sample-ms`, `--rss-budget-mib`, `--heap-budget-mib` and `--slow-ms`.

`--require-cgroup` requires a verified Linux cgroup memory profile; an unconstrained run must not be described as memory-capped. The child Node old-space setting is distinct from total heap or RSS, and a fresh process does not clear filesystem caches. The JSON output records environment, workload, phase timings, observed memory, operating-system high-water RSS and confinement evidence. Progress goes to stderr so stdout can be saved as an external evidence artifact.

For example, with a running Linux systemd user manager, the following creates a fresh 512 MiB cgroup with swap disabled for the generator and its workers. Run it from the checkout after building:

```sh
systemd-run --user --wait --pipe --collect --quiet \
  -p MemoryMax=536870912 -p MemorySwapMax=0 \
  "$(command -v node)" --max-old-space-size=64 \
  "$PWD/benchmarks/large-files.mjs" --format jsonl --bytes 1000000000 \
  --mode both --work-dir "$PWD/.tmp" --require-cgroup > report.json
```

The large-file destination verifies record count, order and a digest in memory while imports persist real checkpoints. It does not persist records to a database or measure database throughput. Slower destinations and larger rows can be exercised separately on smaller files. Replay and idempotency remain the subject of the recovery demo, rather than a claim made by this runner.

Observed on Node.js 24.11.1, Linux x64 under WSL2, using nominal 4 KiB synthetic records, 1 MiB measured batches and a 512 MiB cgroup with swap disabled:

| Format | Source bytes | Imported records | Importer peak RSS reported by the OS |
| --- | ---: | ---: | ---: |
| CSV | 1,000,000,000 | 244,141 | 81.91 MiB |
| CSV | 10,000,000,000 | 2,441,407 | 85.39 MiB |
| JSON Lines | 1,000,000,000 | 244,141 | 88.18 MiB |
| JSON Lines | 10,000,000,000 | 2,441,407 | 81.86 MiB |

Both 1 GB cases also completed a separate validation phase. The 10 GB cases exercised import only. All source sizes, order, values, record counts, digests and batch limits were verified; no OOM events occurred. The preset acceptance criterion allowed at most 64 MiB additional importer peak RSS from 1 GB to 10 GB for the same format, which both cases met.

These are single observations per case, with up to two cases overlapping and filesystem caches left intact. They do not establish universal RSS or throughput guarantees; the cgroup peak also includes the coordinator and file cache. [The 0.3.0 release](https://github.com/Altitud-Studio-S-L-U/importkit/releases/tag/v0.3.0) includes the raw reports, fixed criteria, analysis and memory figure.

There are no GitHub Actions workflows or deployment pipelines in this repository. Maintainers run the checks locally and review pull requests before merging. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and [SECURITY.md](SECURITY.md) for reporting concerns.

## License

[MIT](LICENSE) · Copyright © 2026 Altitud Studio SLU.
