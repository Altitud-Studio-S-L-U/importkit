# API reference

Everything below is exported by `@altitud-studio/importkit` and available through both `import` and `require()`.

- [Concepts](#concepts)
- [importFile](#importfileoptions)
- [validateFile](#validatefileoptions)
- [fileSource](#filesourcepath)
- [csvReader and jsonlReader](#csvreader-and-jsonlreader)
- [fileCheckpointStore](#filecheckpointstorepath)
- [Types](#types)
- [Errors](#errors)
- [Cancellation](#cancellation)
- [Versioning](#versioning)

## Concepts

| Term | Meaning |
| --- | --- |
| Source | The file to import, created with `fileSource()`. It must not change while a run reads it. |
| Reader | Decodes the source's bytes into records: `csvReader()`, `jsonlReader()` or your own. |
| Record | One decoded row or line. The schema and `mapRecord` turn it into the value your destination receives. |
| Batch | The records passed to one `commitBatch` call. |
| Destination | Where `commitBatch` writes, usually your database. |
| Checkpoint | How many records the destination has confirmed, plus the identity of the import. |
| Checkpoint store | Where checkpoints are kept between runs. |
| Import | One logical import, named by `importId`. |
| Run | One call to `importFile` for an import. |

## importFile(options)

```ts
function importFile<I = unknown, T = I>(options: ImportOptions<I, T>): Promise<ImportResult>;
```

Fingerprints the source, loads the saved checkpoint, then parses the source, validates and maps each record and commits batches one at a time, in order. Resolves once every record is committed. Any failure rejects with an [`ImportKitError`](#errors).

| Option | Type | Description |
| --- | --- | --- |
| `source` | `FileSource` | Required. The file, from `fileSource(path)`. |
| `reader` | `RecordReader` | Required. `csvReader()`, `jsonlReader()` or a custom reader. |
| `importId` | `string` | Required. Names the logical import. Not blank, at most 256 UTF-8 bytes. |
| `transformVersion` | `string` | Required. Names the schema, mapping and destination semantics. Not blank, at most 256 UTF-8 bytes. |
| `checkpointStore` | `CheckpointStore` | Required. Where progress is kept, for example `fileCheckpointStore(path)`. |
| `schema` | `StandardSchemaV1<unknown, I>` | Validates and types each record before `mapRecord`. A record it rejects stops the run with `SCHEMA_ERROR`. See [Validation](validation.md). |
| `mapRecord` | `(input: I, context: RecordContext) => T \| Promise<T>` | Converts one record, or the schema's output when there is a schema. Required without a schema. Throwing stops the run with `MAP_ERROR`. |
| `commitBatch` | `(records: readonly ImportRecord<T>[], context: CommitContext) => Promise<void>` | Required. Writes one batch. Resolve only once the write is durable. |
| `batchSize` | `number` | Records per batch, from 1 to 10,000. Default: 500. |
| `maxBatchBytes` | `number` | Measured bytes per batch. Requires `measureRecordBytes`. See [Limits](limits.md#bound-a-batch-by-measured-bytes). |
| `measureRecordBytes` | `(value: T, context: RecordContext) => number` | Synchronous size of one mapped value. Requires `maxBatchBytes`. |
| `limits` | `Partial<ImportLimits>` | Source and record limits. See [Limits](limits.md). |
| `signal` | `AbortSignal` | Cancels the run. See [Cancellation](#cancellation). |

`I` is what `mapRecord` receives: the schema's output, or `unknown` without a schema. `T` is the value your destination receives: what `mapRecord` returns, or the schema's output without `mapRecord`. TypeScript infers both from the options.

`mapRecord` and `measureRecordBytes` receive a [`RecordContext`](#importrecord-and-recordcontext), `{ id, index, line }`, for the record. `commitBatch` receives a frozen array of `{ id, index, value }` records and a frozen [`CommitContext`](#commitcontext).

### Result

| Field | Meaning |
| --- | --- |
| `status` | Always `'completed'`. Failures reject instead. |
| `resumedFrom` | Records the destination had already confirmed when the run started. |
| `processedRecords` | Records in the source, including those skipped because they were confirmed earlier. |
| `committedBatches` | Batches committed during this run. |
| `sourceHash` | SHA-256 of the source content, as a lowercase hexadecimal string. |

Running an import that has already completed parses the source again, so that the current reader and limits still apply, and commits nothing.

## validateFile(options)

```ts
function validateFile<I = unknown, T = I>(options: ValidationOptions<I, T>): Promise<ValidationResult>;
```

Runs the reader, the schema and `mapRecord` over the whole source and discards the mapped values. It opens no checkpoint store and calls no destination. [Validation](validation.md) explains how to read and return a report.

It takes `source`, `reader`, `importId`, `transformVersion`, `schema`, `mapRecord`, `limits` and `signal` with the same meaning as in `importFile`, plus:

| Option | Type | Description |
| --- | --- | --- |
| `maxIssues` | `number` | Issues kept in `issues`, from 0 to 10,000. Default: 100. Set 0 to keep only counts. |
| `includeSchemaMessages` | `boolean` | Copies the schema's own messages into issues. Default: `false`, because they can quote record values. |

### Result

| Field | Meaning |
| --- | --- |
| `status` | `'valid'`, `'invalid'` or `'incomplete'`. |
| `sourceHash` | SHA-256 of the source content. |
| `processedRecords` | Records the reader produced. |
| `validRecords` | Records that passed the schema and `mapRecord`. |
| `invalidRecords` | Records that failed either. `validRecords + invalidRecords` equals `processedRecords`. |
| `issues` | Up to `maxIssues` [`ValidationIssue`](#validationissue) entries, in source order. |
| `issuesTruncated` | `true` when more issues occurred than `issues` holds. |
| `parseError` | Only when `status` is `'incomplete'`: `{ code: 'PARSE_ERROR', message, line }`, where `line` is the line of the malformed record when the reader reports it. |

Issue and parse error messages are constant library text unless `includeSchemaMessages` is set. They never include record values, mapped values or the messages of your exceptions, so a report can be logged or returned to the person who sent the file.

`validateFile` treats every exception from the schema or `mapRecord` as an invalid record, and rejects with an `ImportKitError` for operational failures; [Keep validation and import consistent](validation.md#keep-validation-and-import-consistent) describes both cases. For the same content, reader, `importId` and `transformVersion`, `validateFile` passes `mapRecord` the same record IDs as `importFile`.

## fileSource(path)

```ts
function fileSource(path: string): FileSource;
```

Selects a local file as the source. Throws `INVALID_OPTIONS` at once for an empty path or one that contains a NUL character. The file must exist when the run starts and must not change until it ends; copy an uploaded file to a location your application owns first. Validate and authorize the path before passing it: ImportKit is not a path sandbox.

## csvReader and jsonlReader

```ts
function csvReader(options?: { readonly delimiter?: string }): RecordReader;
function jsonlReader(): RecordReader;
```

`csvReader` reads CSV with a header row and returns each row as an object keyed by header. `jsonlReader` reads one JSON value per line. [Readers](readers.md) documents the accepted input and how to write your own reader.

## fileCheckpointStore(path)

```ts
function fileCheckpointStore(path: string): CheckpointStore;
```

Keeps checkpoints in a local JSON file, replaced atomically on every save, and holds `<path>.lock` while a run is active. The directory must exist. Throws `INVALID_OPTIONS` at once for an empty path or one that contains a NUL character. [Recovery](recovery.md#the-checkpoint-file) describes its guarantees.

## Types

### CheckpointStore

```ts
interface CheckpointStore {
  load(): Promise<Checkpoint | undefined>;
  save(checkpoint: Checkpoint): Promise<void>;
  lock?(): Promise<() => Promise<void>>;
}
```

`load()` resolves to the last saved checkpoint, or to `undefined` (or `null`) when none exists. `save()` resolves once the checkpoint is durable. `lock()`, when present, gives one run exclusive use of the store and resolves to a function that releases it. See [Write your own store](recovery.md#write-your-own-store).

### Checkpoint

```ts
interface Checkpoint {
  readonly version: 1;
  readonly importId: string;
  readonly transformVersion: string;
  readonly readerId: string;
  readonly sourceHash: string;
  readonly processedRecords: number;
  readonly completed: boolean;
}
```

A checkpoint holds identity and progress, never record data. Store it as JSON and return it unchanged.

### CommitContext

```ts
interface CommitContext {
  readonly checkpoint: Checkpoint;
  readonly signal?: AbortSignal;
}
```

`checkpoint` describes progress once this batch is committed. `signal` is the run's `signal`, when one was given.

### ImportRecord and RecordContext

```ts
interface ImportRecord<T> {
  readonly id: string;
  readonly index: number;
  readonly value: T;
}

interface RecordContext {
  readonly id: string;
  readonly index: number;
  readonly line?: number;
}
```

`index` is the record's one-based position among the source's records; a CSV header is not a record. `id` is a 64-character hexadecimal string derived from `importId`, the source content, the reader, `transformVersion` and `index`. `line` is the one-based line of the source where the record starts, present when the reader reports it, as both included readers do. A CSV record with line breaks inside quoted fields spans several lines and reports the first.

### RecordReader

```ts
interface RecordReader {
  readonly id: string;
  read(chunks: AsyncIterable<Uint8Array>, limits: ReaderLimits): AsyncIterable<ParsedRecord>;
}

interface ParsedRecord {
  readonly value: unknown;
  readonly line?: number;
}

interface ReaderLimits {
  readonly maxRecordBytes: number;
}
```

See [Write your own reader](readers.md#write-your-own-reader).

### ImportLimits

```ts
interface ImportLimits extends ReaderLimits {
  readonly maxSourceBytes: number;
  readonly maxRecords: number;
}
```

### ValidationIssue

```ts
interface ValidationIssue {
  readonly code: 'SCHEMA_ERROR' | 'MAP_ERROR';
  readonly recordIndex: number;
  readonly line?: number;
  readonly path?: readonly (string | number)[];
  readonly message: string;
}
```

`line` is the line where the record starts, when the reader reports it. `path` lists the keys and array indexes from the record to the invalid value, when the schema reports them. [Read a report](validation.md#read-a-report) shows an example.

### StandardSchemaV1

`schema` accepts any object or function that implements version 1 of the [Standard Schema](https://standardschema.dev) interface: a `~standard` property with `version: 1` and a `validate` function that returns, or resolves to, `{ value }` or `{ issues }`. Zod, Valibot and ArkType schemas implement it. ImportKit reads the issues' `path` and, with `includeSchemaMessages`, their `message`.

`ImportOptions<I, T>`, `ImportResult`, `ValidationOptions<I, T>`, `ValidationResult`, `ValidationParseError`, `FileSource` and `ImportKitErrorOptions` are also exported and match the tables above.

## Errors

Every failure rejects with an `ImportKitError`. Its `code` identifies the failure, `message` is constant library text, `recordIndex` is set when one record is involved, `line` is the source line where that record starts when the reader reports it, and `cause` holds the underlying error when there is one. A `cause` can contain application data or file content: review it before logging.

| Code | Raised when | What to do |
| --- | --- | --- |
| `INVALID_OPTIONS` | An option is missing, malformed or out of range, the source is the checkpoint file or its lock, or a reader yielded something other than `{ value, line }` records. | Fix the call or the reader. |
| `SOURCE_ERROR` | The source cannot be opened, inspected, read or closed. | Check the path and permissions, then run again. |
| `SOURCE_CHANGED` | The source changed during the run. | Import an unchanging copy. |
| `LIMIT_EXCEEDED` | A source, record, batch or checkpoint value exceeds its limit. | Reject the file or raise the limit. |
| `PARSE_ERROR` | The reader found a structural error. | Reject or correct the file. |
| `SCHEMA_ERROR` | The schema rejected a record or threw. For a rejection, `cause` is the schema's result, whose `issues` can quote record values. | Correct the file or the schema. Validating first avoids partial imports. |
| `MAP_ERROR` | `mapRecord` threw. | Correct the file or the mapping. Validating first avoids partial imports. |
| `MEASURE_ERROR` | `measureRecordBytes` threw or did not return a nonnegative safe integer. | Fix the measurement. |
| `COMMIT_ERROR` | `commitBatch` threw. | Run again; the batch may be delivered again. |
| `CHECKPOINT_ERROR` | The checkpoint store failed, or returned or held an invalid checkpoint. | Fix the store, then run again. |
| `CHECKPOINT_MISMATCH` | The saved checkpoint belongs to other content, another reader or another `transformVersion`. | Start a new import with a new `importId`, or remove the old checkpoint on purpose. |
| `IMPORT_LOCKED` | Another run holds the checkpoint lock. | Wait for it, or confirm it stopped before removing the lock. |
| `ABORTED` | The `signal` was aborted. | Run again to resume. |

Custom readers can throw an `ImportKitError` with an operational code, such as `SOURCE_ERROR` or `LIMIT_EXCEEDED`, and it propagates unchanged. Any other exception from a reader is treated as a structural error in the file: `PARSE_ERROR` from `importFile`, an incomplete report from `validateFile`. A custom checkpoint store can likewise throw an `ImportKitError` such as `IMPORT_LOCKED`; its other failures become `CHECKPOINT_ERROR`.

## Cancellation

Pass an `AbortSignal` as `signal`. ImportKit checks it between records, around every callback and before each batch, and rejects with `ABORTED`. A batch whose `commitBatch` already resolved always gets its checkpoint saved before the run stops, so cancelling never discards confirmed progress. ImportKit cannot interrupt a callback that is running: use the signal from `CommitContext` inside `commitBatch` to stop long writes.

A callback or reader that fails once the signal is aborted, for example a database driver that rejects a cancelled query, also ends the run with `ABORTED` rather than `MAP_ERROR`, `COMMIT_ERROR` or `PARSE_ERROR`.

## Versioning

ImportKit follows [Semantic Versioning](https://semver.org/). From 1.0, changes to options, results, record IDs or the checkpoint format that break existing code or data happen only in a new major version, and the [changelog](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/CHANGELOG.md) describes how to migrate.
