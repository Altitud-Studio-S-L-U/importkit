import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { resolve } from 'node:path';
import { acquireCheckpointLock, canonicalCheckpointPath, readCheckpoint, writeCheckpoint } from './checkpoint.js';
import type { Checkpoint } from './checkpoint.js';
import { ImportKitError } from './errors.js';
import type { ImportLimits, ImportOptions, ImportRecord, ImportResult } from './types.js';

const DEFAULT_LIMITS: ImportLimits = Object.freeze({
  maxSourceBytes: 1_073_741_824,
  maxRecordBytes: 1_048_576,
  maxRecords: 10_000_000,
});

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ImportKitError('INVALID_OPTIONS', `${name} must be a positive safe integer.`);
  }
}

function identity(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value) > 256) {
    throw new ImportKitError('INVALID_OPTIONS', `${name} must be a nonempty string of at most 256 UTF-8 bytes.`);
  }
}

function assertOptions<T>(options: ImportOptions<T>): { limits: ImportLimits; batchSize: number } {
  if (options === null || typeof options !== 'object') {
    throw new ImportKitError('INVALID_OPTIONS', 'Import options are required.');
  }
  identity(options.importId, 'importId');
  identity(options.transformVersion, 'transformVersion');
  if (typeof options.checkpointPath !== 'string' || options.checkpointPath.length === 0
    || typeof options.source?.path !== 'string' || options.source.path.length === 0) {
    throw new ImportKitError('INVALID_OPTIONS', 'Source and checkpoint paths are required.');
  }
  identity(options.source.reader?.id, 'reader.id');
  if (typeof options.source.reader.read !== 'function'
    || typeof options.mapRecord !== 'function' || typeof options.commitBatch !== 'function') {
    throw new ImportKitError('INVALID_OPTIONS', 'Reader, mapping, and destination callbacks are required.');
  }
  const batchSize = options.batchSize ?? 500;
  positiveInteger(batchSize, 'batchSize');
  if (batchSize > 10_000) {
    throw new ImportKitError('INVALID_OPTIONS', 'batchSize must not exceed 10,000 records.');
  }
  const limits: ImportLimits = { ...DEFAULT_LIMITS, ...options.limits };
  positiveInteger(limits.maxSourceBytes, 'maxSourceBytes');
  positiveInteger(limits.maxRecordBytes, 'maxRecordBytes');
  positiveInteger(limits.maxRecords, 'maxRecords');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new ImportKitError('INVALID_OPTIONS', 'signal must be an AbortSignal.');
  }
  return { limits, batchSize };
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportKitError('ABORTED', 'Import cancelled.');
}

function sameFileState(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.size === second.size
    && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}

async function assertSourceState(handle: FileHandle, expected: BigIntStats): Promise<void> {
  const current = await handle.stat({ bigint: true });
  if (!sameFileState(current, expected)) {
    throw new ImportKitError('SOURCE_CHANGED', 'The source changed during the import. Keep it immutable for the entire run.');
  }
}

async function* sourceBytes(handle: FileHandle, maxBytes: number, signal: AbortSignal | undefined): AsyncIterable<Uint8Array> {
  let count = 0;
  try {
    while (true) {
      checkAbort(signal);
      // Each yielded buffer remains owned by its consumer. Positional reads also
      // keep the descriptor open across fingerprinting, parsing, and state checks.
      const buffer = Buffer.allocUnsafe(65_536);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, count);
      if (bytesRead === 0) break;
      count += bytesRead;
      if (count > maxBytes) throw new ImportKitError('LIMIT_EXCEEDED', 'The source exceeds maxSourceBytes.');
      yield buffer.subarray(0, bytesRead);
    }
  } catch (error) {
    if (error instanceof ImportKitError) throw error;
    throw new ImportKitError('SOURCE_ERROR', 'Unable to read the source file.', { cause: error });
  }
}

async function fingerprint(handle: FileHandle, limits: ImportLimits, signal: AbortSignal | undefined): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of sourceBytes(handle, limits.maxSourceBytes, signal)) hash.update(chunk);
  return hash.digest('hex');
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
  checkAbort(options.signal);
  const checkpointPath = await canonicalCheckpointPath(options.checkpointPath);
  const sourcePath = resolve(options.source.path);
  if (sourcePath === checkpointPath || sourcePath === `${checkpointPath}.lock`) {
    throw new ImportKitError('INVALID_OPTIONS', 'Source, checkpoint, and lock must be different files.');
  }
  const release = await acquireCheckpointLock(checkpointPath);
  const readFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
  let handle: FileHandle | undefined;
  try {
    try {
      handle = await open(sourcePath, readFlags);
    } catch (error) {
      throw new ImportKitError('SOURCE_ERROR', 'Unable to open the source file.', { cause: error });
    }
    const sourceState = await handle.stat({ bigint: true });
    if (!sourceState.isFile()) throw new ImportKitError('SOURCE_ERROR', 'The source must be a regular file.');
    if (sourceState.size > BigInt(limits.maxSourceBytes)) {
      throw new ImportKitError('LIMIT_EXCEEDED', 'The source exceeds maxSourceBytes.');
    }
    // Compare file identity as well as paths so hardlinks cannot overwrite the source.
    for (const reservedPath of [checkpointPath, `${checkpointPath}.lock`]) {
      let reserved: FileHandle | undefined;
      try {
        reserved = await open(reservedPath, readFlags);
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

    const commit = async (completed: boolean): Promise<void> => {
      checkAbort(options.signal);
      await assertSourceState(handle!, sourceState);
      if (batch.length > 0) {
        try {
          await options.commitBatch(Object.freeze(batch.slice()));
        } catch (error) {
          throw new ImportKitError('COMMIT_ERROR', 'Destination batch failed; its uncheckpointed records may be replayed.', { cause: error, recordIndex: batch[0]!.index });
        }
      }
      // Do not cancel between a durable destination commit and its checkpoint.
      const next: Checkpoint = { ...checkpoint!, processedRecords: index, completed };
      await writeCheckpoint(checkpointPath, next);
      checkpoint = next;
      if (batch.length > 0) committedBatches++;
      batch = [];
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
        const id = createHash('sha256').update(JSON.stringify([
          options.importId, sourceHash, options.source.reader.id, options.transformVersion, index,
        ])).digest('hex');
        let value: T;
        try {
          value = await options.mapRecord(input, { id, index });
        } catch (error) {
          throw new ImportKitError('MAP_ERROR', 'Record mapping or validation failed.', { cause: error, recordIndex: index });
        }
        batch.push(Object.freeze({ id, index, value }));
        if (batch.length === batchSize) await commit(false);
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
