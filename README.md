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

Built by [Altitud Studio](https://altitudstudio.ad/en/). MIT licensed. Version `0.2.0`; the API may change before `1.0`.

## What is included

| Capability | Scope |
| --- | --- |
| File readers | CSV with a header row; JSON Lines / NDJSON |
| Processing | Async mapping and one destination batch at a time |
| Prevalidation | Read-only traversal, bounded mapping issues, explicit incomplete parsing reports |
| Recovery | SHA-256 source identity, validated checkpoints, stable record IDs |
| Resource controls | Source size, record size, record count, and batch size |
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
npm install /absolute/path/to/altitud-studio-importkit-0.2.0.tgz
```

## Use in your backend

```ts
import { csvReader, importFile } from '@altitud-studio/importkit';

const result = await importFile({
  source: { path: './orders.csv', reader: csvReader() },
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

`validateFile` accepts `source`, `importId`, `transformVersion`, `mapRecord`, optional `limits` and `signal`, and optional `maxIssues`. It has no destination or checkpoint option. It awaits each mapping callback and discards the transformed value.

```ts
import { csvReader, importFile, validateFile } from '@altitud-studio/importkit';

const file = {
  source: { path: './orders.csv', reader: csvReader() },
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

Limits must be positive safe integers. The byte limit also applies to the CSV header; delimiters, quotes, an initial BOM, and line terminators count toward serialized size. The built-in readers enforce record limits while decoding; ImportKit waits for each destination batch before requesting more mapped records. Mapped values can be larger than their input, so choose batch sizes and validation rules that fit your application's memory budget. `mapRecord` and `commitBatch` must also bound their own work.

## Readers

### CSV

```ts
source: { path: './orders.csv', reader: csvReader({ delimiter: ';' }) }
```

CSV uses the maintained [`csv-parse`](https://csv.js.org/parse/) parser. The first row supplies headers. Values remain strings; the application handles conversion and validation. Quoted fields, multiline fields, UTF-8, BOM, and CRLF are supported. Empty, duplicate, or unsafe headers and inconsistent column counts are rejected. Returned records use a null prototype.

### JSON Lines

```ts
import { jsonlReader } from '@altitud-studio/importkit';

source: { path: './events.jsonl', reader: jsonlReader() }
```

Each line is one JSON value. UTF-8, an initial BOM, CRLF, and a final line without a newline are supported. Blank lines, malformed JSON, and invalid UTF-8 are rejected. This is JSON Lines, not a reader for a single large JSON array.

### Other formats

The exported `RecordReader` interface accepts an async stream of bytes and yields records. Its `id` must identify the decoding rules and configuration. The same bytes and reader ID must produce the same record sequence. A custom reader must enforce `ReaderLimits` before buffering unbounded input and close its resources when iteration stops.

## Errors and cancellation

Catch `ImportKitError` and inspect its `code`. Categories include invalid options, source changes, limits, parsing, mapping, destination commits, checkpoints, import locks, and cancellation. `recordIndex` is available when relevant. Underlying failures may be attached as `cause`; treat causes as potentially containing application data when logging.

Pass an `AbortSignal` through `signal` for cooperative cancellation. Cancellation does not roll back an already committed destination batch. ImportKit records that batch's checkpoint before stopping. A running application callback must finish or implement its own cancellation and timeout policy.

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

There are no GitHub Actions workflows or deployment pipelines in this repository. Maintainers run the checks locally and review pull requests before merging. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and [SECURITY.md](SECURITY.md) for reporting concerns.

## License

[MIT](LICENSE) · Copyright © 2026 Altitud Studio SLU.
