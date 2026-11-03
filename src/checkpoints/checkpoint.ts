import { ImportKitError } from '../errors.js';
import type { Checkpoint, CheckpointStore, ImportLimits, ImportOptions } from '../types.js';

type CheckpointIdentity = Pick<ImportOptions<unknown>, 'reader' | 'importId' | 'transformVersion'>;

export interface GuardedCheckpointStore {
  lock(): Promise<() => Promise<void>>;
  load(): Promise<Checkpoint | undefined>;
  save(checkpoint: Checkpoint): Promise<void>;
}

export const maxCheckpointBytes = 16_384;
// Version 1, written by 0.3, named the source by its SHA-256. Version 2 holds any source identity.
const checkpointKeys = {
  1: ['version', 'importId', 'transformVersion', 'readerId', 'sourceHash', 'processedRecords', 'completed'],
  2: ['version', 'importId', 'transformVersion', 'readerId', 'sourceIdentity', 'processedRecords', 'completed'],
} as const;

export function checkpointError(message: string, cause?: unknown): ImportKitError {
  return new ImportKitError('CHECKPOINT_ERROR', message, cause === undefined ? {} : { cause });
}

/** Accepts both checkpoint versions and returns version 2. */
export function validateCheckpoint(value: unknown): Checkpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw checkpointError('The checkpoint must be a valid metadata object.');
  }
  const record = value as Record<string, unknown>;
  const keys = record.version === 1 || record.version === 2 ? checkpointKeys[record.version] : undefined;
  const identity = record.version === 1 ? record.sourceHash : record.sourceIdentity;
  if (keys === undefined || Object.keys(record).length !== keys.length || !keys.every((key) => Object.hasOwn(record, key))
    || typeof record.importId !== 'string' || record.importId.length === 0
    || typeof record.transformVersion !== 'string' || record.transformVersion.length === 0
    || typeof record.readerId !== 'string' || record.readerId.length === 0
    || typeof identity !== 'string' || identity.length === 0 || identity.length > 512
    || (record.version === 1 && !/^[a-f0-9]{64}$/u.test(identity))
    || !Number.isSafeInteger(record.processedRecords) || (record.processedRecords as number) < 0
    || typeof record.completed !== 'boolean') {
    throw checkpointError('The checkpoint has an unsupported or invalid schema.');
  }
  return {
    version: 2,
    importId: record.importId,
    transformVersion: record.transformVersion,
    readerId: record.readerId,
    sourceIdentity: identity,
    processedRecords: record.processedRecords as number,
    completed: record.completed,
  };
}

export function initialCheckpoint(options: CheckpointIdentity, sourceIdentity: string): Checkpoint {
  return Object.freeze({
    version: 2, importId: options.importId, transformVersion: options.transformVersion,
    readerId: options.reader.id, sourceIdentity, processedRecords: 0, completed: false,
  });
}

/** Rejects progress recorded for other content or import semantics, or beyond the current record limit. */
export function assertResumable(checkpoint: Checkpoint, options: CheckpointIdentity, sourceIdentity: string, limits: ImportLimits): void {
  if (checkpoint.importId !== options.importId || checkpoint.transformVersion !== options.transformVersion
    || checkpoint.readerId !== options.reader.id || checkpoint.sourceIdentity !== sourceIdentity) {
    throw new ImportKitError('CHECKPOINT_MISMATCH', 'The checkpoint belongs to different source content or import semantics.');
  }
  if (checkpoint.processedRecords > limits.maxRecords) {
    throw new ImportKitError('LIMIT_EXCEEDED', 'Checkpoint progress exceeds maxRecords.');
  }
}

async function storeCall<R>(failure: string, operation: () => R | Promise<R>): Promise<R> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ImportKitError) throw error;
    throw checkpointError(failure, error);
  }
}

/**
 * Calls an application-supplied store. Its failures become CHECKPOINT_ERROR unless they are already ImportKitError,
 * and what it loads is validated like a checkpoint file, because it may come from storage other code can write.
 */
export function guardCheckpointStore(store: CheckpointStore): GuardedCheckpointStore {
  return {
    async lock() {
      const lock = store.lock;
      if (lock === undefined) return async () => {};
      const release: unknown = await storeCall('Unable to lock the checkpoint store.', () => lock.call(store));
      if (typeof release !== 'function') {
        throw checkpointError('The checkpoint store lock must resolve to a release function.');
      }
      return () => storeCall('Unable to release the checkpoint store lock.', async () => { await release.call(undefined); });
    },
    async load() {
      const loaded: unknown = await storeCall('Unable to load the checkpoint.', () => store.load());
      return loaded === undefined || loaded === null ? undefined : validateCheckpoint(loaded);
    },
    async save(checkpoint) {
      await storeCall('Unable to save the checkpoint.', () => store.save(checkpoint));
    },
  };
}
