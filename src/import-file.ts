import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isPromise } from 'node:util/types';
import { resolve } from 'node:path';
import { acquireCheckpointLock, canonicalCheckpointPath, readCheckpoint, writeCheckpoint } from './checkpoint.js';
import type { Checkpoint } from './checkpoint.js';
import { ImportKitError } from './errors.js';
import { assertFileOptions, assertSourceState, checkAbort, fingerprint, openSource, positiveInteger, recordId, sourceBytes, sourceReadFlags } from './file-source.js';
import type { ImportLimits, ImportOptions, ImportRecord, ImportResult, RecordContext } from './types.js';

function assertOptions<T>(options: ImportOptions<T>): { limits: ImportLimits; batchSize: number } {
  const limits = assertFileOptions(options);
  if (typeof options.checkpointPath !== 'string' || options.checkpointPath.length === 0) {
    throw new ImportKitError('INVALID_OPTIONS', 'Source and checkpoint paths are required.');
  }
  if (typeof options.commitBatch !== 'function') {
    throw new ImportKitError('INVALID_OPTIONS', 'Reader, mapping, and destination callbacks are required.');
  }
  const batchSize = options.batchSize ?? 500;
  positiveInteger(batchSize, 'batchSize');
  if (batchSize > 10_000) {
    throw new ImportKitError('INVALID_OPTIONS', 'batchSize must not exceed 10,000 records.');
  }
  const hasByteBudget = options.maxBatchBytes !== undefined;
  const hasMeasurement = options.measureRecordBytes !== undefined;
  if (hasByteBudget !== hasMeasurement) {
    throw new ImportKitError('INVALID_OPTIONS', 'maxBatchBytes and measureRecordBytes must be provided together.');
  }
  if (hasByteBudget) {
    positiveInteger(options.maxBatchBytes!, 'maxBatchBytes');
    if (typeof options.measureRecordBytes !== 'function') {
      throw new ImportKitError('INVALID_OPTIONS', 'measureRecordBytes must be a synchronous function.');
    }
  }
  return { limits, batchSize };
}

function measureBytes<T>(measure: NonNullable<ImportOptions<T>['measureRecordBytes']>, value: T, context: RecordContext, signal: AbortSignal | undefined): number {
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

function assertCheckpoint<T>(state: Checkpoint, options: ImportOptions<T>, sourceHash: string, limits: ImportLimits): void {
  if (state.importId !== options.importId || state.transformVersion !== options.transformVersion
    || state.readerId !== options.source.reader.id || state.sourceHash !== sourceHash) {
    throw new ImportKitError('CHECKPOINT_MISMATCH', 'The checkpoint belongs to different source content or import semantics.');
  }
  if (state.processedRecords > limits.maxRecords) {
    throw new ImportKitError('LIMIT_EXCEEDED', 'Checkpoint progress exceeds maxRecords.');
  }
}

/** Imports an immutable local file with sequential, at-least-once destination batches. */
export async function importFile<T>(options: ImportOptions<T>): Promise<ImportResult> {
  const { limits, batchSize } = assertOptions(options);
  const { maxBatchBytes, measureRecordBytes } = options;
  checkAbort(options.signal);
  const checkpointPath = await canonicalCheckpointPath(options.checkpointPath);
  const sourcePath = resolve(options.source.path);
  if (sourcePath === checkpointPath || sourcePath === `${checkpointPath}.lock`) {
    throw new ImportKitError('INVALID_OPTIONS', 'Source, checkpoint, and lock must be different files.');
  }
  const release = await acquireCheckpointLock(checkpointPath);
  let handle: FileHandle | undefined;
  try {
    const source = await openSource(sourcePath, limits.maxSourceBytes);
    handle = source.handle;
    const sourceState = source.state;
    // Compare file identity as well as paths so hardlinks cannot overwrite the source.
    for (const reservedPath of [checkpointPath, `${checkpointPath}.lock`]) {
      let reserved: FileHandle | undefined;
      try {
        reserved = await open(reservedPath, sourceReadFlags);
        const reservedState = await reserved.stat({ bigint: true });
        if (reservedState.dev === sourceState.dev && reservedState.ino === sourceState.ino) {
          throw new ImportKitError('INVALID_OPTIONS', 'Source, checkpoint, and lock must be different files.');
        }
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
      } finally {
        await reserved?.close();
      }
    }

    const sourceHash = await fingerprint(handle, limits, options.signal);
    await assertSourceState(handle, sourceState);
    let checkpoint = await readCheckpoint(checkpointPath);
    if (checkpoint) assertCheckpoint(checkpoint, options, sourceHash, limits);
    else {
      checkpoint = {
        version: 1, importId: options.importId, transformVersion: options.transformVersion,
        readerId: options.source.reader.id, sourceHash, processedRecords: 0, completed: false,
      };
      await writeCheckpoint(checkpointPath, checkpoint);
    }
    const resumedFrom = checkpoint.processedRecords;
    let committedBatches = 0;
    let index = 0;
    let batch: ImportRecord<T>[] = [];
    let batchBytes = 0;

    const commit = async (completed: boolean): Promise<void> => {
      checkAbort(options.signal);
      // A byte-triggered flush can have one mapped record waiting outside this
      // batch. Only its included prefix is safe to checkpoint after persistence.
      const processedThrough = batch.length > 0 ? batch[batch.length - 1]!.index : index;
      await assertSourceState(handle!, sourceState);
      if (batch.length > 0) {
        try {
          await options.commitBatch(Object.freeze(batch.slice()));
        } catch (error) {
          throw new ImportKitError('COMMIT_ERROR', 'Destination batch failed; its uncheckpointed records may be replayed.', { cause: error, recordIndex: batch[0]!.index });
        }
      }
      // Do not cancel between a durable destination commit and its checkpoint.
      const next: Checkpoint = { ...checkpoint!, processedRecords: processedThrough, completed };
      await writeCheckpoint(checkpointPath, next);
      checkpoint = next;
      if (batch.length > 0) committedBatches++;
      batch = [];
      batchBytes = 0;
      checkAbort(options.signal);
    };

    const parsedHash = createHash('sha256');
    const sourceHandle = handle;
    async function* verifiedBytes(): AsyncIterable<Uint8Array> {
      for await (const chunk of sourceBytes(sourceHandle!, limits.maxSourceBytes, options.signal)) {
        parsedHash.update(chunk);
        yield chunk;
      }
    }

    try {
      for await (const input of options.source.reader.read(verifiedBytes(), limits)) {
        checkAbort(options.signal);
        index++;
        if (index > limits.maxRecords) throw new ImportKitError('LIMIT_EXCEEDED', 'The source exceeds maxRecords.', { recordIndex: index });
        if (index <= resumedFrom) continue;
        const id = recordId(options, sourceHash, index);
        let value: T;
        try {
          value = await options.mapRecord(input, { id, index });
        } catch (error) {
          throw new ImportKitError('MAP_ERROR', 'Record mapping or validation failed.', { cause: error, recordIndex: index });
        }
        checkAbort(options.signal);
        let valueBytes = 0;
        if (maxBatchBytes !== undefined) {
          valueBytes = measureBytes(measureRecordBytes!, value, { id, index }, options.signal);
          if (valueBytes > maxBatchBytes) {
            throw new ImportKitError('LIMIT_EXCEEDED', 'A transformed record exceeds maxBatchBytes.', { recordIndex: index });
          }
          if (batch.length > 0 && valueBytes > maxBatchBytes - batchBytes) await commit(false);
        }
        batch.push(Object.freeze({ id, index, value }));
        batchBytes += valueBytes;
        if (batch.length === batchSize || (maxBatchBytes !== undefined && batchBytes === maxBatchBytes)) await commit(false);
      }
    } catch (error) {
      if (error instanceof ImportKitError) throw error;
      throw new ImportKitError('PARSE_ERROR', 'The reader failed to produce records.', { cause: error, recordIndex: index + 1 });
    }
    if (parsedHash.digest('hex') !== sourceHash) {
      throw new ImportKitError('SOURCE_CHANGED', 'The source bytes changed between fingerprinting and parsing.');
    }
    await assertSourceState(handle, sourceState);
    if (index < resumedFrom) throw new ImportKitError('CHECKPOINT_MISMATCH', 'Checkpoint progress exceeds the reader output.');
    // Completed imports are parsed again so smaller limits and reader failures still apply.
    if (!checkpoint.completed || batch.length > 0) await commit(true);
    else checkAbort(options.signal);
    return { status: 'completed', resumedFrom, processedRecords: index, committedBatches, sourceHash };
  } finally {
    try { await handle?.close(); } finally { await release(); }
  }
}
