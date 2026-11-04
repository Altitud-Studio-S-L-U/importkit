# Recovery

This page describes what ImportKit guarantees when a run stops, where checkpoints live, and how to keep them in your own database so that committed batches are never delivered twice.

## How a run proceeds

1. Lock the checkpoint store, when it supports locking.
2. Open the source and establish its identity before any destination write. A file's identity is the SHA-256 of its content.
3. Load the saved checkpoint. Reject it if it describes other content, another reader or another `transformVersion`.
4. Parse the source from the beginning. Skip the records the checkpoint already confirms, and map the rest.
5. Group mapped records into batches and pass each batch to `commitBatch` in source order, one at a time unless `concurrency` allows more.
6. Once `commitBatch` has resolved for a batch and for every batch before it, save the checkpoint. The last batch, which may be smaller, is saved as completed.

```text
parse → map → commitBatch → save checkpoint → next batch
                  │
                  └─ the run stops before the save: the batch is delivered again on the next run
```

A parsing or mapping failure stops the run; no record is ever skipped silently. Resuming reparses the source from its first byte, because a CSV field can contain line breaks and only parsing finds where a record starts.

## At-least-once delivery

By default the destination and the checkpoint are written separately. A run can stop between the two writes, and `commitBatch` can write its records and then throw. In both cases the next run delivers the batch again, with the same record IDs.

Make the destination idempotent. A unique constraint on the record ID, with writes that ignore or overwrite an existing row, is usually enough. If a batch can be written partially, the written part must tolerate the replay. ImportKit cannot make emails, payments or other external effects transactional.

## Transactional checkpoints

`commitBatch` receives `{ checkpoint }`: the progress once its batch is committed. When the destination writes that checkpoint in the same transaction as the records, and the checkpoint store's `load()` reads it from the same place, the batch and its progress commit or roll back together. A run that stops after the commit, before ImportKit saves the checkpoint itself, resumes after that batch instead of delivering it again.

ImportKit still calls `save()` after each batch. With a transactional destination that second write stores the same value again, and it keeps progress current for batches that `commitBatch` does not see, such as the completion of an import whose last batch was already committed.

The [transactional example](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/examples/transactional.mjs) uses SQLite: it loses the acknowledgment of the first batch on purpose and shows the next run resuming without a replay.

## Commit batches concurrently

With `concurrency` above 1, ImportKit keeps reading and mapping while earlier batches are being committed, and up to `concurrency` calls to `commitBatch` run at the same time. A destination that spends most of each batch waiting, such as a remote database or an HTTP API, then imports several times faster.

- Batches start in source order but can finish in any order. Records within a batch stay in source order.
- The checkpoint advances only over batches whose predecessors are all confirmed. If batch 3 is confirmed before batch 2, progress stays at the end of batch 1 until batch 2 is confirmed.
- When a batch fails or the run is cancelled, no new batch starts. ImportKit waits for the batches in flight, saves the progress they confirm and then rejects with the first error. A batch confirmed after an earlier one failed is delivered again on the next run.
- Each batch in flight holds its records in memory, so a run can hold up to `concurrency` batches at once.

For a transactional destination, the `checkpoint` in `CommitContext` includes its batch only when every earlier batch is already confirmed, and otherwise holds the progress confirmed so far. Batches can then commit their checkpoints out of order, so write it with an upsert that never moves progress back:

```sql
INSERT INTO import_checkpoints (import_id, checkpoint) VALUES ($1, $2)
ON CONFLICT (import_id) DO UPDATE SET checkpoint = EXCLUDED.checkpoint
WHERE (EXCLUDED.checkpoint->>'processedRecords')::bigint >= (import_checkpoints.checkpoint->>'processedRecords')::bigint
```

Keep `concurrency` at 1 when the destination needs batches in order, for example when later records update rows that earlier ones created.

## Checkpoint stores

A checkpoint store keeps the checkpoint of one logical import.

```ts
interface CheckpointStore {
  load(): Promise<Checkpoint | undefined>;
  save(checkpoint: Checkpoint): Promise<void>;
  lock?(): Promise<() => Promise<void>>;
}
```

During a run ImportKit calls `lock()` once, if it exists, and `load()` once. It calls `save()` when an import starts, whenever confirmed progress advances, and once more to mark the import completed if its last batch was already saved. Saves never overlap and never move progress back. Finally it calls the release function returned by `lock()`, whether the run succeeded or failed.

ImportKit validates whatever `load()` returns, exactly as it validates a checkpoint file: an object with other fields, wrong types or an unknown `version` fails with `CHECKPOINT_ERROR`, and a checkpoint for other content, another reader or another `transformVersion` fails with `CHECKPOINT_MISMATCH`. A store's own failures become `CHECKPOINT_ERROR`, with the original error as `cause`. A store can also throw an `ImportKitError` itself, for example `IMPORT_LOCKED`, and it reaches the caller unchanged.

### Write your own store

- Keep one checkpoint per logical import: a row keyed by `importId` is the usual shape.
- Resolve `save()` only once the checkpoint is durable.
- Return from `load()` exactly what `save()` received. Storing it as JSON is enough.
- Let only the importing service write checkpoints. ImportKit rejects malformed checkpoints, but a well-formed one written for the same import would make the next run skip records.
- Implement `lock()` if two workers can run the same import at once, for example with a database advisory lock. Without it, concurrent runs are not coordinated.

### A PostgreSQL store

The following sketch uses the [`pg`](https://node-postgres.com/) client and a table `import_checkpoints (import_id text primary key, checkpoint jsonb not null)`. It is type-checked with the documentation but not executed in this repository.

```ts
import { ImportKitError } from '@altitud-studio/importkit';
import type { CheckpointStore } from '@altitud-studio/importkit';
import type { Pool } from 'pg';

export function postgresCheckpointStore(pool: Pool, importId: string): CheckpointStore {
  return {
    async load() {
      const { rows } = await pool.query('SELECT checkpoint FROM import_checkpoints WHERE import_id = $1', [importId]);
      return rows[0]?.checkpoint;
    },
    async save(checkpoint) {
      await pool.query(
        `INSERT INTO import_checkpoints (import_id, checkpoint) VALUES ($1, $2)
         ON CONFLICT (import_id) DO UPDATE SET checkpoint = EXCLUDED.checkpoint`,
        [importId, checkpoint],
      );
    },
    async lock() {
      const client = await pool.connect();
      const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [importId]);
      if (rows[0]?.locked !== true) {
        client.release();
        throw new ImportKitError('IMPORT_LOCKED', 'Another run holds this import.');
      }
      return async () => {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [importId]);
        } finally {
          client.release();
        }
      };
    },
  };
}
```

The advisory lock lives in the session of the connection that took it, so the release function returns that same connection to the pool. In `commitBatch`, take a connection from the pool, insert the records and the checkpoint between `BEGIN` and `COMMIT`, and release the connection afterwards.

## The checkpoint file

`fileCheckpointStore(path)` keeps the checkpoint in a JSON file of at most 16 KiB.

- Every save writes a temporary file, flushes it to disk and renames it over the previous checkpoint, then flushes the directory where the platform supports it. The operating system and file system still decide what survives a power loss.
- Symbolic links and other non-regular files are rejected instead of followed.
- The directory must already exist. ImportKit does not create it.
- A run holds an exclusive lock file, `<path>.lock`, from start to finish. A run that finds the lock fails with `IMPORT_LOCKED`.
- ImportKit refuses a source that is the checkpoint file or its lock, including through a hard link.

A process that is killed cannot remove its lock. Before you delete `<path>.lock` by hand, confirm that the process named in it has stopped: the age of the lock is not evidence that its owner is gone. ImportKit never removes a lock automatically.

The lock coordinates runs on one machine that use the same path. Shared network file systems, distributed locking and automatic recovery of stale locks are outside its scope; use a store with a database lock for those cases.

## Keep the source unchanged

ImportKit establishes the source's identity before writing anything. For a file, it computes the SHA-256 of the content and checks the file's identity, size and timestamps throughout the run. A change fails the run with `SOURCE_CHANGED`. This detects edits, but it does not turn a file that another process is writing into a stable snapshot: copy uploads to a location your application owns and import that copy.
