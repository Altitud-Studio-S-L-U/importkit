import { resolve } from 'node:path';
import { isPromise } from 'node:util/types';
import { BatchBuilder } from './batch-builder.js';
import { assertResumable, guardCheckpointStore, initialCheckpoint } from './checkpoints/checkpoint.js';
import type { GuardedCheckpointStore } from './checkpoints/checkpoint.js';
import { FileCheckpointStore } from './checkpoints/file-checkpoint.js';
import { checkAbort, ImportKitError } from './errors.js';
import { assertSourceState, closeSource, fingerprint, openSource } from './file-source.js';
import type { OpenSource } from './file-source.js';
import { assertImportOptions } from './options.js';
import type { ImportSettings } from './options.js';
import { traverseRecords } from './traversal.js';
import type { Checkpoint, CommitContext, ImportOptions, ImportResult, RecordContext } from './types.js';

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
    throw new ImportKitError('MEASURE_ERROR', 'Record byte measurement failed.', { cause: error, recordIndex: context.index, line: context.line });
  }
  checkAbort(signal);
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new ImportKitError('MEASURE_ERROR', 'Record byte measurement must return a nonnegative safe integer synchronously.', { recordIndex: context.index, line: context.line });
  }
  return bytes;
}

/** Imports an immutable local file with sequential, at-least-once destination batches. */
export async function importFile<T>(options: ImportOptions<T>): Promise<ImportResult> {
  const settings = assertImportOptions(options);
  checkAbort(options.signal);
  const sourcePath = resolve(options.source.path);
  const fileStore = options.checkpointStore instanceof FileCheckpointStore ? options.checkpointStore : undefined;
  await fileStore?.assertSeparatePath(sourcePath);
  const checkpoints = guardCheckpointStore(options.checkpointStore);
  const release = await checkpoints.lock();
  try {
    const source = await openSource(sourcePath, settings.limits.maxSourceBytes);
    try {
      await fileStore?.assertSeparateFile(source.state);
      return await importOpenSource(options, settings, checkpoints, source);
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
  checkpoints: GuardedCheckpointStore,
  { handle, state }: OpenSource,
): Promise<ImportResult> {
  const sourceHash = await fingerprint(handle, limits, options.signal);
  await assertSourceState(handle, state);
  const saved = await checkpoints.load();
  if (saved) assertResumable(saved, options, sourceHash, limits);
  let checkpoint: Checkpoint = saved ?? initialCheckpoint(options, sourceHash);
  if (!saved) await checkpoints.save(checkpoint);
  const resumedFrom = checkpoint.processedRecords;
  const traversal = traverseRecords(handle, options, limits, sourceHash);
  const batch = new BatchBuilder<T>(batchSize, byteBudget?.maxBatchBytes);
  let committedBatches = 0;

  const commit = async (completed: boolean): Promise<void> => {
    checkAbort(options.signal);
    // A byte-triggered flush can have one mapped record waiting outside this
    // batch. Only its included prefix is safe to checkpoint after persistence.
    const records = batch.records();
    const next: Checkpoint = Object.freeze({ ...checkpoint, processedRecords: records.at(-1)?.index ?? traversal.count(), completed });
    await assertSourceState(handle, state);
    const first = records[0];
    if (first !== undefined) {
      const context: CommitContext = Object.freeze(options.signal === undefined ? { checkpoint: next } : { checkpoint: next, signal: options.signal });
      try {
        await options.commitBatch(records, context);
      } catch (error) {
        checkAbort(options.signal);
        throw new ImportKitError('COMMIT_ERROR', 'Destination batch failed; its uncheckpointed records may be replayed.', { cause: error, recordIndex: first.index });
      }
    }
    // Do not cancel between a durable destination commit and its checkpoint.
    await checkpoints.save(next);
    checkpoint = next;
    if (first !== undefined) committedBatches++;
    batch.clear();
    checkAbort(options.signal);
  };

  try {
    for await (const record of traversal.inputs()) {
      const index = traversal.visit(record);
      if (index <= resumedFrom) continue;
      const context = traversal.context(index, record);
      let value: T;
      try {
        value = await options.mapRecord(record.value, context);
      } catch (error) {
        checkAbort(options.signal);
        throw new ImportKitError('MAP_ERROR', 'Record mapping or validation failed.', { cause: error, recordIndex: index, line: context.line });
      }
      checkAbort(options.signal);
      let bytes = 0;
      if (byteBudget !== undefined) {
        bytes = measureBytes(byteBudget.measureRecordBytes, value, context, options.signal);
        if (bytes > byteBudget.maxBatchBytes) {
          throw new ImportKitError('LIMIT_EXCEEDED', 'A transformed record exceeds maxBatchBytes.', { recordIndex: index, line: context.line });
        }
        if (batch.mustCommitBefore(bytes)) await commit(false);
      }
      batch.add(Object.freeze({ id: context.id, index, value }), bytes);
      if (batch.isFull()) await commit(false);
    }
  } catch (error) {
    // Callbacks, limits, source checks and persistence raise ImportKitError, so any other error came from the reader.
    if (error instanceof ImportKitError) throw error;
    checkAbort(options.signal);
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
