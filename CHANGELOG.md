# Changelog

All notable changes to ImportKit are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.1] - 2026-11-10

### Changed

- Record IDs are hashed from a precomputed prefix with `crypto.hash`, without serializing the constant identity for every record. The IDs are byte-for-byte the same. A 200 MB CSV import of 2,583,975 records with a no-op destination took 16.5–17.2 s instead of 18.4–18.6 s (three runs each, Node.js 24.11.1, Windows x64).

### Fixed

- `httpSource` rejects an ETag that is not a syntactically valid strong entity tag (RFC 9110, section 8.8.3) before any record is processed.
- Checkpoint files are inspected through the open file handle, so a path replaced by a link between the check and the read is rejected on platforms without `O_NOFOLLOW`.

## [1.0.0] - 2026-11-04

### Breaking changes

- `importFile` and `validateFile` take `source: fileSource(path)` and a separate `reader` option instead of `source: { path, reader }`.
- `importFile` takes `checkpointStore` instead of `checkpointPath`. `fileCheckpointStore(path)` keeps the previous behavior, and checkpoint files written by 0.3 still resume.
- Custom readers yield `{ value, line }` records instead of bare values. A reader that yields anything else fails with `INVALID_OPTIONS`.
- Checkpoints are saved as version 2, which names the source with `sourceIdentity` instead of `sourceHash`. Checkpoints written by 0.3 are still read and resume; 0.3 cannot read a version 2 checkpoint.

### Added

- `httpSource(url, { headers })` reads a file over HTTP or HTTPS, such as an object in S3, Google Cloud Storage or R2 through a presigned URL. Its strong ETag is the source identity, so a resumed run continues only against the same version.
- Sources: `source` accepts any `ByteSource`, so an import can read storage other than local files. ImportKit validates what a source returns, counts its bytes and reports their SHA-256.
- Schemas: `schema` accepts any Standard Schema v1 implementation, such as Zod, Valibot or ArkType. It validates and types each record before `mapRecord`, which becomes optional. Validation issues report the `path` of the invalid field, with the new code `SCHEMA_ERROR`, and `includeSchemaMessages` copies the schema's messages into them.
- `concurrency` commits up to 16 batches at the same time. The checkpoint advances only over batches whose predecessors are confirmed, and a failure waits for the batches in flight before rejecting.
- `onProgress` reports the saved progress and the bytes read after every checkpoint save. A callback that throws stops the run with the new code `PROGRESS_ERROR`.
- Source lines: `mapRecord` and `measureRecordBytes` receive the `line` where each record starts, and validation issues, parse errors and `ImportKitError` report it. A CSV record with line breaks inside quoted fields reports its first line.
- Checkpoint stores: any object with `load()`, `save()` and an optional `lock()` can keep progress, for example in the destination database.
- `commitBatch` receives `{ checkpoint, signal }`. Writing the checkpoint in the same transaction as the records prevents replays after a lost acknowledgment.
- `fileSource()`, `fileCheckpointStore()`, and the `Checkpoint`, `CheckpointStore`, `CommitContext` and `FileSource` types.
- The package loads with `require()` as well as `import`.
- A transactional SQLite example, `npm run demo:transactional`.
- `npm run benchmark:throughput`, which measures how `concurrency` scales with a destination that waits on every batch.

### Changed

- The JSON Lines reader finds line breaks with `Buffer#indexOf` and reuses one decoder, which reduces parsing time.
- Benchmark reports leave out the CPU model, the memory size, the kernel version, the host name and local paths.

### Fixed

- Failures to inspect or close the source are reported as `SOURCE_ERROR` instead of escaping as raw Node.js errors or as `PARSE_ERROR`.
- Failures to inspect the checkpoint path are reported as `CHECKPOINT_ERROR` instead of escaping as raw Node.js errors.
- A callback or reader that fails after the run is cancelled reports `ABORTED` from `importFile`, as it already did from `validateFile`.
- The CSV reader no longer hangs when a run stops early while 16 or more parsed rows are buffered, for example after a header error, a rejected record or cancellation. The run used to keep the source open and the checkpoint lock held. Versions up to 0.3.0 are affected.
- When closing the source or releasing the checkpoint lock fails after a run has already failed, the run rejects with its original error instead of the cleanup failure.

### Migration from 0.3

1. Pass the source and the reader separately, and replace `checkpointPath` with a checkpoint store:

   ```ts
   // 0.3
   await importFile({
     source: { path: './orders.csv', reader: csvReader() },
     checkpointPath: './orders.checkpoint.json',
     // ...
   });

   // 1.0
   await importFile({
     source: fileSource('./orders.csv'),
     reader: csvReader(),
     checkpointStore: fileCheckpointStore('./orders.checkpoint.json'),
     // ...
   });
   ```

2. In a custom reader, yield `{ value, line }` for each record instead of the bare value, or `{ value }` for a format without lines.
3. Handle the new error codes `SCHEMA_ERROR` and `PROGRESS_ERROR` wherever you switch over `ImportErrorCode`. They only occur with the new `schema` and `onProgress` options.
4. Explicit type arguments such as `importFile<Order>(...)` still compile, but TypeScript now infers the types from `schema` and `mapRecord`, so they can go.

Record IDs of file imports are unchanged, and 1.0 reads the checkpoint files that 0.3 wrote, so an import started with 0.3 resumes where it stopped. 1.0 saves checkpoints as version 2, which 0.3 cannot read: finish such an import with 1.0.

## [0.3.0] - 2026-11-03

### Added

- Batches bounded by measured bytes with `maxBatchBytes` and `measureRecordBytes`.
- A runner that imports synthetic 1 GB and 10 GB files under a memory-limited cgroup and reports the measurements.

## [0.2.0] - 2026-11-03

### Added

- `validateFile`, which checks a whole file without writing and returns a bounded issue report.

## [0.1.0] - 2026-11-03

### Added

- `importFile` with CSV and JSON Lines readers, sequential batches, stable record IDs, local checkpoints with an exclusive lock, and at-least-once recovery.

[Unreleased]: https://github.com/Altitud-Studio-S-L-U/importkit/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Altitud-Studio-S-L-U/importkit/compare/v0.3.0...v1.0.0
[0.3.0]: https://github.com/Altitud-Studio-S-L-U/importkit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Altitud-Studio-S-L-U/importkit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Altitud-Studio-S-L-U/importkit/releases/tag/v0.1.0
