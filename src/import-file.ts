import { resolve } from 'node:path';
import { isPromise } from 'node:util/types';
import { BatchBuilder } from './batch-builder.js';
import { assertResumable, guardCheckpointStore, initialCheckpoint } from './checkpoints/checkpoint.js';
import type { GuardedCheckpointStore } from './checkpoints/checkpoint.js';
import { FileCheckpointStore } from './checkpoints/file-checkpoint.js';
import { CommitQueue } from './commit-queue.js';
import { checkAbort, ImportKitError } from './errors.js';
import { assertImportOptions } from './options.js';
import type { ImportSettings } from './options.js';
import { FileByteSource } from './sources/file-source.js';
import { openSource } from './sources/source.js';
import type { GuardedSource } from './sources/source.js';
import { RejectedRecord } from './transform.js';
import { traverseRecords } from './traversal.js';
import type { Checkpoint, ImportOptions, ImportProgress, ImportResult, RecordContext } from './types.js';

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

/** Imports an unchanging source in at-least-once destination batches, saving progress in source order. */
export async function importFile<I = unknown, T = I>(options: ImportOptions<I, T>): Promise<ImportResult> {
  const settings = assertImportOptions(options);
  checkAbort(options.signal);
  const fileStore = options.checkpointStore instanceof FileCheckpointStore ? options.checkpointStore : undefined;
  if (fileStore !== undefined && options.source instanceof FileByteSource) await fileStore.assertSeparatePath(resolve(options.source.path));
  const checkpoints = guardCheckpointStore(options.checkpointStore);
  const release = await checkpoints.lock();
  try {
    const source = await openSource(options.source, settings.limits, options.signal);
    try {
      if (fileStore !== undefined && source.fileState !== undefined) await fileStore.assertSeparateFile(source.fileState);
      return await importOpenSource(options, settings, checkpoints, source);
    } finally {
      await source.close();
    }
  } finally {
    await release();
  }
}

function progressReporter(onProgress: ImportOptions['onProgress'], signal: AbortSignal | undefined): ((progress: ImportProgress) => Promise<void>) | undefined {
  if (onProgress === undefined) return undefined;
  return async (progress) => {
    try {
      await onProgress(Object.freeze(progress));
    } catch (error) {
      checkAbort(signal);
      throw new ImportKitError('PROGRESS_ERROR', 'The progress callback failed.', { cause: error });
    }
  };
}

async function importOpenSource<I, T>(
  options: ImportOptions<I, T>,
  { limits, transform, batchSize, byteBudget, concurrency }: ImportSettings<T>,
  checkpoints: GuardedCheckpointStore,
  source: GuardedSource,
): Promise<ImportResult> {
  const saved = await checkpoints.load();
  if (saved) assertResumable(saved, options, source.identity, limits);
  const start: Checkpoint = saved ?? initialCheckpoint(options, source.identity);
  if (!saved) await checkpoints.save(start);
  const resumedFrom = start.processedRecords;
  const traversal = traverseRecords(source, options, limits);
  const batch = new BatchBuilder<T>(batchSize, byteBudget?.maxBatchBytes);
  const queue = new CommitQueue<T>({
    concurrency,
    signal: options.signal,
    start,
    totalBytes: source.size,
    commit: async (records, context) => {
      await source.assertUnchanged();
      try {
        await options.commitBatch(records, context);
      } catch (error) {
        checkAbort(options.signal);
        throw new ImportKitError('COMMIT_ERROR', 'Destination batch failed; its uncheckpointed records may be replayed.', { cause: error, recordIndex: records[0]?.index });
      }
    },
    save: (checkpoint) => checkpoints.save(checkpoint),
    progress: progressReporter(options.onProgress, options.signal),
  });

  const flush = async (completed: boolean): Promise<void> => {
    checkAbort(options.signal);
    // A byte-triggered flush can have one mapped record waiting outside this
    // batch. Only its included prefix is safe to checkpoint after persistence.
    const records = batch.records();
    batch.clear();
    const last = records.at(-1);
    if (last !== undefined) {
      const checkpoint: Checkpoint = Object.freeze({ ...start, processedRecords: last.index, completed });
      await queue.submit(records, { checkpoint, bytesRead: traversal.bytesRead() });
    }
    // The queue saves a committed batch's checkpoint before cancellation is observed here.
    checkAbort(options.signal);
  };

  const deliver = async (): Promise<void> => {
    try {
      for await (const record of traversal.inputs()) {
        const index = traversal.visit(record);
        if (index <= resumedFrom) continue;
        const context = traversal.context(index, record);
        const value = await transform(record.value, context);
        if (value instanceof RejectedRecord) throw value.toError(context);
        checkAbort(options.signal);
        let bytes = 0;
        if (byteBudget !== undefined) {
          bytes = measureBytes(byteBudget.measureRecordBytes, value, context, options.signal);
          if (bytes > byteBudget.maxBatchBytes) {
            throw new ImportKitError('LIMIT_EXCEEDED', 'A transformed record exceeds maxBatchBytes.', { recordIndex: index, line: context.line });
          }
          if (batch.mustCommitBefore(bytes)) await flush(false);
        }
        batch.add(Object.freeze({ id: context.id, index, value }), bytes);
        if (batch.isFull()) await flush(false);
      }
    } catch (error) {
      // Callbacks, limits, source checks and persistence raise ImportKitError, so any other error came from the reader.
      if (error instanceof ImportKitError) throw error;
      checkAbort(options.signal);
      throw new ImportKitError('PARSE_ERROR', 'The reader failed to produce records.', { cause: error, recordIndex: traversal.count() + 1 });
    }
  };

  let sourceHash: string;
  try {
    await deliver();
    // A reader may stop before the last byte; the hash and the size check cover the whole source.
    await traversal.drain();
    sourceHash = traversal.contentHash();
    if (source.sha256 !== undefined && sourceHash !== source.sha256) {
      throw new ImportKitError('SOURCE_CHANGED', 'The source bytes changed between fingerprinting and parsing.');
    }
    await source.assertUnchanged();
    if (traversal.count() < resumedFrom) throw new ImportKitError('CHECKPOINT_MISMATCH', 'Checkpoint progress exceeds the reader output.');
    // Completed imports are parsed again so smaller limits and reader failures still apply.
    await flush(true);
    await queue.complete(traversal.count(), traversal.bytesRead());
    checkAbort(options.signal);
  } catch (error) {
    // No callback may run once the import settles: wait for batches in flight and save the progress they confirm.
    await queue.settle();
    throw error;
  } finally {
    await traversal.close();
  }
  return { status: 'completed', resumedFrom, processedRecords: traversal.count(), committedBatches: queue.committedBatches, sourceHash };
}
