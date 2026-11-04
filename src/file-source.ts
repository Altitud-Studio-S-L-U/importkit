import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { checkAbort, ImportKitError } from './errors.js';
import type { ImportLimits } from './types.js';

export interface OpenSource {
  readonly handle: FileHandle;
  readonly state: BigIntStats;
}

export const sourceReadFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

export async function openSource(path: string, maxSourceBytes: number): Promise<OpenSource> {
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

export async function closeSource(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    throw new ImportKitError('SOURCE_ERROR', 'Unable to close the source file.', { cause: error });
  }
}

export async function assertSourceState(handle: FileHandle, expected: BigIntStats): Promise<void> {
  let current: BigIntStats;
  try {
    current = await handle.stat({ bigint: true });
  } catch (error) {
    throw new ImportKitError('SOURCE_ERROR', 'Unable to inspect the source file.', { cause: error });
  }
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
