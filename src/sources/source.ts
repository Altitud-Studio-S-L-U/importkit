import type { BigIntStats } from 'node:fs';
import { checkAbort, ImportKitError } from '../errors.js';
import type { ByteSource, ImportLimits, OpenedSource } from '../types.js';
import { OpenedFile } from './file-source.js';

/** An opened source whose output ImportKit has checked and bounded. */
export interface GuardedSource {
  readonly identity: string;
  readonly size: number;
  readonly sha256: string | undefined;
  /** Set for local files, so the file checkpoint store can compare file identities. */
  readonly fileState: BigIntStats | undefined;
  /** The content, counted against `size`. Ends with SOURCE_CHANGED when there are more or fewer bytes. */
  bytes(): AsyncIterable<Uint8Array>;
  assertUnchanged(): Promise<void>;
  /** Like assertUnchanged(), but a local file is read again and its content compared. */
  assertContentUnchanged(): Promise<void>;
  close(): Promise<void>;
}

async function sourceCall<R>(failure: string, operation: () => Promise<R>): Promise<R> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ImportKitError) throw error;
    throw new ImportKitError('SOURCE_ERROR', failure, { cause: error });
  }
}

async function* countedBytes(read: () => AsyncIterable<Uint8Array>, size: number, signal: AbortSignal | undefined): AsyncIterable<Uint8Array> {
  let count = 0;
  try {
    for await (const chunk of read()) {
      checkAbort(signal);
      if (!(chunk instanceof Uint8Array)) throw new ImportKitError('INVALID_OPTIONS', 'A source must yield Uint8Array chunks.');
      count += chunk.byteLength;
      if (count > size) throw new ImportKitError('SOURCE_CHANGED', 'The source produced more bytes than its size.');
      yield chunk;
    }
  } catch (error) {
    if (error instanceof ImportKitError) throw error;
    checkAbort(signal);
    throw new ImportKitError('SOURCE_ERROR', 'Unable to read the source.', { cause: error });
  }
  if (count !== size) throw new ImportKitError('SOURCE_CHANGED', 'The source ended before its size.');
}

/**
 * Opens a source and checks what it returns, because a custom source is application code: its identity and size are
 * validated, its bytes are counted, and its own failures become SOURCE_ERROR unless they are already ImportKitError.
 */
export async function openSource(source: ByteSource, limits: ImportLimits, signal: AbortSignal | undefined): Promise<GuardedSource> {
  const context = signal === undefined ? { maxBytes: limits.maxSourceBytes } : { maxBytes: limits.maxSourceBytes, signal };
  const opened: unknown = await sourceCall('Unable to open the source.', () => source.open(Object.freeze(context)));
  // Every member is read once: a getter could otherwise pass validation and then report another size or identity.
  const { identity, size, sha256, bytes, assertUnchanged, close } =
    (typeof opened === 'object' && opened !== null ? opened : {}) as Partial<Record<keyof OpenedSource, unknown>>;
  let closed = false;
  const release = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (typeof close === 'function') await sourceCall('Unable to close the source.', async () => { await close.call(opened); });
  };

  if (typeof identity !== 'string' || identity.length === 0 || identity.length > 512
    || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0
    || (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(sha256)))
    || typeof bytes !== 'function'
    || (assertUnchanged !== undefined && typeof assertUnchanged !== 'function')
    || (close !== undefined && typeof close !== 'function')) {
    await release();
    throw new ImportKitError('INVALID_OPTIONS', 'A source must open to { identity, size, bytes() }, with an identity of 1 to 512 characters.');
  }
  if (size > limits.maxSourceBytes) {
    await release();
    throw new ImportKitError('LIMIT_EXCEEDED', 'The source exceeds maxSourceBytes.');
  }
  const check = async (): Promise<void> => {
    if (typeof assertUnchanged === 'function') await sourceCall('Unable to check the source.', async () => { await assertUnchanged.call(opened); });
  };
  const file = opened instanceof OpenedFile ? opened : undefined;
  return {
    identity,
    size,
    sha256: sha256 as string | undefined,
    fileState: file?.state,
    bytes: () => countedBytes(() => bytes.call(opened) as AsyncIterable<Uint8Array>, size, signal),
    assertUnchanged: check,
    assertContentUnchanged: () => file === undefined ? check() : file.assertContentUnchanged(),
    close: release,
  };
}
