import { ImportKitError } from '../errors.js';
import type { ImportLimits, ImportOptions } from '../types.js';

export interface Checkpoint {
  readonly version: 1;
  readonly importId: string;
  readonly transformVersion: string;
  readonly readerId: string;
  readonly sourceHash: string;
  readonly processedRecords: number;
  readonly completed: boolean;
}

type CheckpointIdentity = Pick<ImportOptions<unknown>, 'reader' | 'importId' | 'transformVersion'>;

export const maxCheckpointBytes = 16_384;
const checkpointKeys = [
  'version', 'importId', 'transformVersion', 'readerId',
  'sourceHash', 'processedRecords', 'completed',
] as const;

export function checkpointError(message: string, cause?: unknown): ImportKitError {
  return new ImportKitError('CHECKPOINT_ERROR', message, cause === undefined ? {} : { cause });
}

export function validateCheckpoint(value: unknown): Checkpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw checkpointError('The checkpoint must be a valid metadata object.');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== checkpointKeys.length
    || !checkpointKeys.every((key) => Object.hasOwn(record, key))
    || record.version !== 1
    || typeof record.importId !== 'string' || record.importId.length === 0
    || typeof record.transformVersion !== 'string' || record.transformVersion.length === 0
    || typeof record.readerId !== 'string' || record.readerId.length === 0
    || typeof record.sourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(record.sourceHash)
    || !Number.isSafeInteger(record.processedRecords) || (record.processedRecords as number) < 0
    || typeof record.completed !== 'boolean') {
    throw checkpointError('The checkpoint has an unsupported or invalid schema.');
  }
  return {
    version: 1,
    importId: record.importId,
    transformVersion: record.transformVersion,
    readerId: record.readerId,
    sourceHash: record.sourceHash,
    processedRecords: record.processedRecords as number,
    completed: record.completed,
  };
}

export function initialCheckpoint(options: CheckpointIdentity, sourceHash: string): Checkpoint {
  return {
    version: 1, importId: options.importId, transformVersion: options.transformVersion,
    readerId: options.reader.id, sourceHash, processedRecords: 0, completed: false,
  };
}

/** Rejects progress recorded for other content or import semantics, or beyond the current record limit. */
export function assertResumable(checkpoint: Checkpoint, options: CheckpointIdentity, sourceHash: string, limits: ImportLimits): void {
  if (checkpoint.importId !== options.importId || checkpoint.transformVersion !== options.transformVersion
    || checkpoint.readerId !== options.reader.id || checkpoint.sourceHash !== sourceHash) {
    throw new ImportKitError('CHECKPOINT_MISMATCH', 'The checkpoint belongs to different source content or import semantics.');
  }
  if (checkpoint.processedRecords > limits.maxRecords) {
    throw new ImportKitError('LIMIT_EXCEEDED', 'Checkpoint progress exceeds maxRecords.');
  }
}
