import { ImportKitError } from './errors.js';
import type { ImportLimits, ImportOptions, RecordContext, ValidationOptions } from './types.js';

type FileOptions<T> = Pick<ImportOptions<T>, 'source' | 'reader' | 'importId' | 'transformVersion' | 'mapRecord' | 'limits' | 'signal'>;

export interface ByteBudget<T> {
  readonly maxBatchBytes: number;
  readonly measureRecordBytes: (value: T, context: RecordContext) => number;
}

export interface ImportSettings<T> {
  readonly limits: ImportLimits;
  readonly batchSize: number;
  readonly byteBudget: ByteBudget<T> | undefined;
}

export interface ValidationSettings {
  readonly limits: ImportLimits;
  readonly maxIssues: number;
}

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

function assertFileOptions<T>(options: FileOptions<T>): ImportLimits {
  if (options === null || typeof options !== 'object') {
    throw new ImportKitError('INVALID_OPTIONS', 'Import options are required.');
  }
  identity(options.importId, 'importId');
  identity(options.transformVersion, 'transformVersion');
  if (typeof options.source?.path !== 'string' || options.source.path.length === 0) {
    throw new ImportKitError('INVALID_OPTIONS', 'A source created with fileSource(path) is required.');
  }
  if (options.reader === undefined && 'reader' in options.source) {
    throw new ImportKitError('INVALID_OPTIONS', 'Pass the reader as its own option: { source: fileSource(path), reader: csvReader() }.');
  }
  identity(options.reader?.id, 'reader.id');
  if (typeof options.reader.read !== 'function' || typeof options.mapRecord !== 'function') {
    throw new ImportKitError('INVALID_OPTIONS', 'Reader and mapping callbacks are required.');
  }
  const limits: ImportLimits = { ...DEFAULT_LIMITS, ...options.limits };
  positiveInteger(limits.maxSourceBytes, 'maxSourceBytes');
  positiveInteger(limits.maxRecordBytes, 'maxRecordBytes');
  positiveInteger(limits.maxRecords, 'maxRecords');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new ImportKitError('INVALID_OPTIONS', 'signal must be an AbortSignal.');
  }
  return limits;
}

export function assertImportOptions<T>(options: ImportOptions<T>): ImportSettings<T> {
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
  const { maxBatchBytes, measureRecordBytes } = options;
  if ((maxBatchBytes === undefined) !== (measureRecordBytes === undefined)) {
    throw new ImportKitError('INVALID_OPTIONS', 'maxBatchBytes and measureRecordBytes must be provided together.');
  }
  if (maxBatchBytes === undefined || measureRecordBytes === undefined) return { limits, batchSize, byteBudget: undefined };
  positiveInteger(maxBatchBytes, 'maxBatchBytes');
  if (typeof measureRecordBytes !== 'function') {
    throw new ImportKitError('INVALID_OPTIONS', 'measureRecordBytes must be a synchronous function.');
  }
  return { limits, batchSize, byteBudget: { maxBatchBytes, measureRecordBytes } };
}

export function assertValidationOptions<T>(options: ValidationOptions<T>): ValidationSettings {
  const limits = assertFileOptions(options);
  const maxIssues = options.maxIssues ?? 100;
  if (!Number.isSafeInteger(maxIssues) || maxIssues < 0 || maxIssues > 10_000) {
    throw new ImportKitError('INVALID_OPTIONS', 'maxIssues must be an integer from 0 through 10,000.');
  }
  return { limits, maxIssues };
}
