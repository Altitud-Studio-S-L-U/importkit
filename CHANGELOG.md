# Changelog

All notable changes to ImportKit are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Breaking changes

- `importFile` and `validateFile` take `source: fileSource(path)` and a separate `reader` option instead of `source: { path, reader }`.
- `importFile` takes `checkpointStore` instead of `checkpointPath`. `fileCheckpointStore(path)` keeps the previous behavior, and checkpoint files written by 0.3 still resume.

### Added

- Checkpoint stores: any object with `load()`, `save()` and an optional `lock()` can keep progress, for example in the destination database.
- `commitBatch` receives `{ checkpoint, signal }`. Writing the checkpoint in the same transaction as the records prevents replays after a lost acknowledgment.
- `fileSource()`, `fileCheckpointStore()`, and the `Checkpoint`, `CheckpointStore`, `CommitContext` and `FileSource` types.
- The package loads with `require()` as well as `import`.
- A transactional SQLite example, `npm run demo:transactional`.

### Fixed

- Failures to inspect or close the source are reported as `SOURCE_ERROR` instead of escaping as raw Node.js errors or as `PARSE_ERROR`.
- Failures to inspect the checkpoint path are reported as `CHECKPOINT_ERROR` instead of escaping as raw Node.js errors.
- A callback or reader that fails after the run is cancelled reports `ABORTED` from `importFile`, as it already did from `validateFile`.

### Migration from 0.3

```ts
// 0.3
await importFile({
  source: { path: './orders.csv', reader: csvReader() },
  checkpointPath: './orders.checkpoint.json',
  // ...
});

// Now
await importFile({
  source: fileSource('./orders.csv'),
  reader: csvReader(),
  checkpointStore: fileCheckpointStore('./orders.checkpoint.json'),
  // ...
});
```

Record IDs and the checkpoint file format are unchanged, so an import started with 0.3 resumes where it stopped.

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

[Unreleased]: https://github.com/Altitud-Studio-S-L-U/importkit/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Altitud-Studio-S-L-U/importkit/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Altitud-Studio-S-L-U/importkit/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Altitud-Studio-S-L-U/importkit/releases/tag/v0.1.0
