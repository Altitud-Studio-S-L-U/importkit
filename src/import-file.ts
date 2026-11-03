import type { BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isPromise } from 'node:util/types';
import { BatchBuilder } from './batch-builder.js';
import { assertResumable, initialCheckpoint } from './checkpoints/checkpoint.js';
import type { Checkpoint } from './checkpoints/checkpoint.js';
import { acquireCheckpointLock, canonicalCheckpointPath, readCheckpoint, writeCheckpoint } from './checkpoints/file-checkpoint.js';
import { checkAbort, hasErrorCode, ImportKitError } from './errors.js';
import { assertSourceState, closeSource, fingerprint, openSource, sourceReadFlags } from './file-source.js';
import type { OpenSource } from './file-source.js';
import { assertImportOptions } from './options.js';
import type { ImportSettings } from './options.js';
import { traverseRecords } from './traversal.js';
import type { ImportOptions, ImportResult, RecordContext } from './types.js';

function measureBytes<T>(measure: (value: T, context: RecordContext) => number, value: T, context: RecordContext, signal: AbortSignal | undefined): number {
  let bytes: unknown;
  try {
    bytes = measure(value, context);
    // Async results are rejected below. Observe their rejection so an invalid
    // callback does not also escape as an unrelated unhandled rejection.
    if (isPromise(bytes)) {
      void Promise.prototype.then.call(bytes, undefined, () => {});
    }
  } catch (error) {
    checkAbort(signal);
    throw new ImportKitError('MEASURE_ERROR', 'Record byte measurement failed.', { cause: error, recordIndex: context.index });
  }
  checkAbort(signal);
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new ImportKitError('MEASURE_ERROR', 'Record byte measurement must return a nonnegative safe integer synchronously.', { recordIndex: context.index });
  }
  return bytes;
}

/** Compares file identity as well as paths, so a hard link cannot make the checkpoint or its lock overwrite the source. */
async function assertSeparateFiles(source: BigIntStats, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    let reserved: FileHandle | undefined;
    try {
      reserved = await open(path, sourceReadFlags);
      const state = await reserved.stat({ bigint: true });
      if (state.dev === source.dev && state.ino === source.ino) {
        throw new ImportKitError('INVALID_OPTIONS', 'Source, checkpoint, and lock must be different files.');
      }
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    } finally {
      await reserved?.close();
    }
  }
}

/** Imports an immutable local file with sequential, at-least-once destination batches. */
export async function importFile<T>(options: ImportOptions<T>): Promise<ImportResult> {
  const settings = assertImportOptions(options);
  checkAbort(options.signal);
  const checkpointPath = await canonicalCheckpointPath(options.checkpointPath);
  const lockPath = `${checkpointPath}.lock`;
  const sourcePath = resolve(options.source.path);
  if (sourcePath === checkpointPath || sourcePath === lockPath) {
    throw new ImportKitError('INVALID_OPTIONS', 'Source, checkpoint, and lock must be different files.');
  }
  const release = await acquireCheckpointLock(checkpointPath);
  try {
    const source = await openSource(sourcePath, settings.limits.maxSourceBytes);
    try {
      await assertSeparateFiles(source.state, [checkpointPath, lockPath]);
      return await importOpenSource(options, settings, checkpointPath, source);
    } finally {
      await closeSource(source.handle);
    }
  } finally {
    await release();
  }
}

async function importOpenSource<T>(
  options: ImportOptions<T>,
  { limits, batchSize, byteBudget }: ImportSettings<T>,
  checkpointPath: string,
  { handle, state }: OpenSource,
): Promise<ImportResult> {
  const sourceHash = await fingerprint(handle, limits, options.signal);
  await assertSourceState(handle, state);
  const saved = await readCheckpoint(checkpointPath);
  if (saved) assertResumable(saved, options, sourceHash, limits);
  let checkpoint: Checkpoint = saved ?? initialCheckpoint(options, sourceHash);
  if (!saved) await writeCheckpoint(checkpointPath, checkpoint);
  const resumedFrom = checkpoint.processedRecords;
  const traversal = traverseRecords(handle, options, limits, sourceHash);
  const batch = new BatchBuilder<T>(batchSize, byteBudget?.maxBatchBytes);
  let committedBatches = 0;

  const commit = async (completed: boolean): Promise<void> => {
    checkAbort(options.signal);
    // A byte-triggered flush can have one mapped record waiting outside this
    // batch. Only its included prefix is safe to checkpoint after persistence.
    const records = batch.records();
    const processedThrough = records.at(-1)?.index ?? traversal.count();
    await assertSourceState(handle, state);
    const first = records[0];
    if (first !== undefined) {
      try {
        await options.commitBatch(records);
      } catch (error) {
        throw new ImportKitError('COMMIT_ERROR', 'Destination batch failed; its uncheckpointed records may be replayed.', { cause: error, recordIndex: first.index });
      }
    }
    // Do not cancel between a durable destination commit and its checkpoint.
    const next: Checkpoint = { ...checkpoint, processedRecords: processedThrough, completed };
    await writeCheckpoint(checkpointPath, next);
    checkpoint = next;
    if (first !== undefined) committedBatches++;
    batch.clear();
    checkAbort(options.signal);
  };

  try {
    for await (const input of traversal.inputs()) {
      const index = traversal.visit();
      if (index <= resumedFrom) continue;
      const id = traversal.recordId(index);
      let value: T;
      try {
        value = await options.mapRecord(input, { id, index });
      } catch (error) {
        throw new ImportKitError('MAP_ERROR', 'Record mapping or validation failed.', { cause: error, recordIndex: index });
      }
      checkAbort(options.signal);
      let bytes = 0;
      if (byteBudget !== undefined) {
        bytes = measureBytes(byteBudget.measureRecordBytes, value, { id, index }, options.signal);
        if (bytes > byteBudget.maxBatchBytes) {
          throw new ImportKitError('LIMIT_EXCEEDED', 'A transformed record exceeds maxBatchBytes.', { recordIndex: index });
        }
        if (batch.mustCommitBefore(bytes)) await commit(false);
      }
      batch.add(Object.freeze({ id, index, value }), bytes);
      if (batch.isFull()) await commit(false);
    }
  } catch (error) {
    // Callbacks, limits, source checks and persistence raise ImportKitError, so any other error came from the reader.
    if (error instanceof ImportKitError) throw error;
    throw new ImportKitError('PARSE_ERROR', 'The reader failed to produce records.', { cause: error, recordIndex: traversal.count() + 1 });
  }
  if (traversal.parsedHash() !== sourceHash) {
    throw new ImportKitError('SOURCE_CHANGED', 'The source bytes changed between fingerprinting and parsing.');
  }
  await assertSourceState(handle, state);
  const processedRecords = traversal.count();
  if (processedRecords < resumedFrom) throw new ImportKitError('CHECKPOINT_MISMATCH', 'Checkpoint progress exceeds the reader output.');
  // Completed imports are parsed again so smaller limits and reader failures still apply.
  if (!checkpoint.completed || batch.size > 0) await commit(true);
  else checkAbort(options.signal);
  return { status: 'completed', resumedFrom, processedRecords, committedBatches, sourceHash };
}
