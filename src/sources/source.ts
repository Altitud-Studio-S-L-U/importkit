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
  close(): Promise<void>;
}

function isOpenedSource(value: unknown): value is OpenedSource {
  if (typeof value !== 'object' || value === null) return false;
  const opened = value as Partial<Record<keyof OpenedSource, unknown>>;
  return typeof opened.identity === 'string' && opened.identity.length > 0 && opened.identity.length <= 512
    && Number.isSafeInteger(opened.size) && (opened.size as number) >= 0
    && (opened.sha256 === undefined || (typeof opened.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(opened.sha256)))
    && typeof opened.bytes === 'function'
    && (opened.assertUnchanged === undefined || typeof opened.assertUnchanged === 'function')
    && (opened.close === undefined || typeof opened.close === 'function');
}

async function sourceCall<R>(failure: string, operation: () => Promise<R>): Promise<R> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ImportKitError) throw error;
    throw new ImportKitError('SOURCE_ERROR', failure, { cause: error });
  }
}

async function* countedBytes(opened: OpenedSource, signal: AbortSignal | undefined): AsyncIterable<Uint8Array> {
  let count = 0;
  try {
    for await (const chunk of opened.bytes()) {
      checkAbort(signal);
      if (!(chunk instanceof Uint8Array)) throw new ImportKitError('INVALID_OPTIONS', 'A source must yield Uint8Array chunks.');
      count += chunk.byteLength;
      if (count > opened.size) throw new ImportKitError('SOURCE_CHANGED', 'The source produced more bytes than its size.');
      yield chunk;
    }
  } catch (error) {
    if (error instanceof ImportKitError) throw error;
    checkAbort(signal);
    throw new ImportKitError('SOURCE_ERROR', 'Unable to read the source.', { cause: error });
  }
  if (count !== opened.size) throw new ImportKitError('SOURCE_CHANGED', 'The source ended before its size.');
}

/**
 * Opens a source and checks what it returns, because a custom source is application code: its identity and size are
 * validated, its bytes are counted, and its own failures become SOURCE_ERROR unless they are already ImportKitError.
 */
export async function openSource(source: ByteSource, limits: ImportLimits, signal: AbortSignal | undefined): Promise<GuardedSource> {
  const context = signal === undefined ? { maxBytes: limits.maxSourceBytes } : { maxBytes: limits.maxSourceBytes, signal };
  const opened: unknown = await sourceCall('Unable to open the source.', () => source.open(Object.freeze(context)));
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const release = (opened as Partial<OpenedSource> | null)?.close;
    if (typeof release === 'function') await sourceCall('Unable to close the source.', () => release.call(opened));
  };

  if (!isOpenedSource(opened)) {
    await close();
    throw new ImportKitError('INVALID_OPTIONS', 'A source must open to { identity, size, bytes() }, with an identity of 1 to 512 characters.');
  }
  if (opened.size > limits.maxSourceBytes) {
    await close();
    throw new ImportKitError('LIMIT_EXCEEDED', 'The source exceeds maxSourceBytes.');
  }
  return {
    identity: opened.identity,
    size: opened.size,
    sha256: opened.sha256,
    fileState: opened instanceof OpenedFile ? opened.state : undefined,
    bytes: () => countedBytes(opened, signal),
    assertUnchanged: async () => {
      const check = opened.assertUnchanged;
      if (check !== undefined) await sourceCall('Unable to check the source.', () => check.call(opened));
    },
    close,
  };
}
