import { ImportKitError } from './errors.js';
import type { StandardSchemaV1 } from './standard-schema.js';
import { recordTransform } from './transform.js';
import type { RecordTransform } from './transform.js';
import type { ImportLimits, ImportOptions, RecordContext, ValidationOptions } from './types.js';

type FileOptions<I, T> = Pick<ImportOptions<I, T>, 'source' | 'reader' | 'importId' | 'transformVersion' | 'schema' | 'mapRecord' | 'limits' | 'signal'>;

export interface ByteBudget<T> {
  readonly maxBatchBytes: number;
  readonly measureRecordBytes: (value: T, context: RecordContext) => number;
}

interface FileSettings<T> {
  readonly limits: ImportLimits;
  readonly transform: RecordTransform<T>;
}

export interface ImportSettings<T> extends FileSettings<T> {
  readonly batchSize: number;
  readonly byteBudget: ByteBudget<T> | undefined;
}

export interface ValidationSettings<T> extends FileSettings<T> {
  readonly maxIssues: number;
  readonly includeSchemaMessages: boolean;
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

/** Some libraries, such as ArkType, implement schemas as functions. */
function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  const standard = (value as Partial<StandardSchemaV1>)['~standard'];
  return typeof standard === 'object' && standard !== null && standard.version === 1 && typeof standard.validate === 'function';
}

function assertFileOptions<I, T>(options: FileOptions<I, T>): FileSettings<T> {
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
  if (typeof options.reader.read !== 'function') {
    throw new ImportKitError('INVALID_OPTIONS', 'reader.read must be a function.');
  }
  if (options.schema !== undefined && !isStandardSchema(options.schema)) {
    throw new ImportKitError('INVALID_OPTIONS', 'schema must implement Standard Schema v1.');
  }
  if (options.mapRecord !== undefined && typeof options.mapRecord !== 'function') {
    throw new ImportKitError('INVALID_OPTIONS', 'mapRecord must be a function.');
  }
  const limits: ImportLimits = { ...DEFAULT_LIMITS, ...options.limits };
  positiveInteger(limits.maxSourceBytes, 'maxSourceBytes');
  positiveInteger(limits.maxRecordBytes, 'maxRecordBytes');
  positiveInteger(limits.maxRecords, 'maxRecords');
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new ImportKitError('INVALID_OPTIONS', 'signal must be an AbortSignal.');
  }
  return { limits, transform: recordTransform(options) };
}

export function assertImportOptions<I, T>(options: ImportOptions<I, T>): ImportSettings<T> {
  const { limits, transform } = assertFileOptions(options);
  if ('checkpointPath' in options) {
    throw new ImportKitError('INVALID_OPTIONS', 'checkpointPath was replaced by { checkpointStore: fileCheckpointStore(path) }.');
  }
  const store: unknown = options.checkpointStore;
  if (typeof store !== 'object' || store === null || !('load' in store) || !('save' in store)
    || typeof store.load !== 'function' || typeof store.save !== 'function'
    || ('lock' in store && store.lock !== undefined && typeof store.lock !== 'function')) {
    throw new ImportKitError('INVALID_OPTIONS', 'checkpointStore must provide load() and save(), and lock() when present.');
  }
  if (typeof options.commitBatch !== 'function') {
    throw new ImportKitError('INVALID_OPTIONS', 'commitBatch must be a function.');
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
  if (maxBatchBytes === undefined || measureRecordBytes === undefined) return { limits, transform, batchSize, byteBudget: undefined };
  positiveInteger(maxBatchBytes, 'maxBatchBytes');
  if (typeof measureRecordBytes !== 'function') {
    throw new ImportKitError('INVALID_OPTIONS', 'measureRecordBytes must be a synchronous function.');
  }
  return { limits, transform, batchSize, byteBudget: { maxBatchBytes, measureRecordBytes } };
}

export function assertValidationOptions<I, T>(options: ValidationOptions<I, T>): ValidationSettings<T> {
  const { limits, transform } = assertFileOptions(options);
  const maxIssues = options.maxIssues ?? 100;
  if (!Number.isSafeInteger(maxIssues) || maxIssues < 0 || maxIssues > 10_000) {
    throw new ImportKitError('INVALID_OPTIONS', 'maxIssues must be an integer from 0 through 10,000.');
  }
  const includeSchemaMessages = options.includeSchemaMessages ?? false;
  if (typeof includeSchemaMessages !== 'boolean') {
    throw new ImportKitError('INVALID_OPTIONS', 'includeSchemaMessages must be a boolean.');
  }
  return { limits, transform, maxIssues, includeSchemaMessages };
}
