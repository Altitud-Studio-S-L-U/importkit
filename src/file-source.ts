import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { ImportKitError } from './errors.js';
import type { ImportLimits, ImportOptions } from './types.js';

type FileOptions<T> = Pick<ImportOptions<T>, 'source' | 'importId' | 'transformVersion' | 'mapRecord' | 'limits' | 'signal'>;
type RecordIdentity = Pick<ImportOptions<unknown>, 'source' | 'importId' | 'transformVersion'>;

const DEFAULT_LIMITS: ImportLimits = Object.freeze({
  maxSourceBytes: 1_073_741_824,
  maxRecordBytes: 1_048_576,
  maxRecords: 10_000_000,
});

export const sourceReadFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

export function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ImportKitError('INVALID_OPTIONS', `${name} must be a positive safe integer.`);
  }
}

function identity(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value) > 256) {
    throw new ImportKitError('INVALID_OPTIONS', `${name} must be a nonempty string of at most 256 UTF-8 bytes.`);
  }
}

export function assertFileOptions<T>(options: FileOptions<T>): ImportLimits {
  if (options === null || typeof options !== 'object') {
    throw new ImportKitError('INVALID_OPTIONS', 'Import options are required.');
  }
  identity(options.importId, 'importId');
  identity(options.transformVersion, 'transformVersion');
  if (typeof options.source?.path !== 'string' || options.source.path.length === 0) {
    throw new ImportKitError('INVALID_OPTIONS', 'A source path is required.');
  }
  identity(options.source.reader?.id, 'reader.id');
  if (typeof options.source.reader.read !== 'function' || typeof options.mapRecord !== 'function') {
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

export function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportKitError('ABORTED', 'Import cancelled.');
}

export async function openSource(path: string, maxSourceBytes: number): Promise<{ handle: FileHandle; state: BigIntStats }> {
  let handle: FileHandle;
  try {
    handle = await open(path, sourceReadFlags);
  } catch (error) {
    throw new ImportKitError('SOURCE_ERROR', 'Unable to open the source file.', { cause: error });
  }
  try {
    const state = await handle.stat({ bigint: true });
    if (!state.isFile()) throw new ImportKitError('SOURCE_ERROR', 'The source must be a regular file.');
    if (state.size > BigInt(maxSourceBytes)) {
      throw new ImportKitError('LIMIT_EXCEEDED', 'The source exceeds maxSourceBytes.');
    }
    return { handle, state };
  } catch (error) {
    try { await handle.close(); } catch (closeError) {
      throw new ImportKitError('SOURCE_ERROR', 'Unable to inspect or close the source file.', { cause: new AggregateError([error, closeError]) });
    }
    if (error instanceof ImportKitError) throw error;
    throw new ImportKitError('SOURCE_ERROR', 'Unable to inspect the source file.', { cause: error });
  }
}

export async function assertSourceState(handle: FileHandle, expected: BigIntStats): Promise<void> {
  const current = await handle.stat({ bigint: true });
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.size !== expected.size
    || current.mtimeNs !== expected.mtimeNs || current.ctimeNs !== expected.ctimeNs) {
    throw new ImportKitError('SOURCE_CHANGED', 'The source changed during the import. Keep it immutable for the entire run.');
  }
}

export async function* sourceBytes(handle: FileHandle, maxBytes: number, signal: AbortSignal | undefined): AsyncIterable<Uint8Array> {
  let count = 0;
  try {
    while (true) {
      checkAbort(signal);
      // Fresh buffers preserve consumer ownership across the fingerprint and parse passes.
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

export async function fingerprint(handle: FileHandle, limits: ImportLimits, signal: AbortSignal | undefined): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of sourceBytes(handle, limits.maxSourceBytes, signal)) hash.update(chunk);
  return hash.digest('hex');
}

export function recordId(options: RecordIdentity, sourceHash: string, index: number): string {
  return createHash('sha256').update(JSON.stringify([
    options.importId, sourceHash, options.source.reader.id, options.transformVersion, index,
  ])).digest('hex');
}
