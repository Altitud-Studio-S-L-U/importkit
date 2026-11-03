import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkAbort, ImportKitError } from '../errors.js';
import type { FileSource, OpenedSource, SourceContext } from '../types.js';

export const sourceReadFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

function sourceChanged(): ImportKitError {
  return new ImportKitError('SOURCE_CHANGED', 'The source changed during the import. Keep it immutable for the entire run.');
}

async function inspect(handle: FileHandle): Promise<BigIntStats> {
  try {
    return await handle.stat({ bigint: true });
  } catch (error) {
    throw new ImportKitError('SOURCE_ERROR', 'Unable to inspect the source file.', { cause: error });
  }
}

async function assertSameFile(handle: FileHandle, expected: BigIntStats): Promise<void> {
  const current = await inspect(handle);
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.size !== expected.size
    || current.mtimeNs !== expected.mtimeNs || current.ctimeNs !== expected.ctimeNs) {
    throw sourceChanged();
  }
}

async function* fileBytes(handle: FileHandle, signal: AbortSignal | undefined): AsyncIterable<Uint8Array> {
  let position = 0;
  try {
    while (true) {
      checkAbort(signal);
      // Fresh buffers preserve consumer ownership across the fingerprint and parse passes.
      const buffer = Buffer.allocUnsafe(65_536);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) return;
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } catch (error) {
    if (error instanceof ImportKitError) throw error;
    throw new ImportKitError('SOURCE_ERROR', 'Unable to read the source file.', { cause: error });
  }
}

async function fingerprint(handle: FileHandle, size: number, signal: AbortSignal | undefined): Promise<string> {
  const hash = createHash('sha256');
  let count = 0;
  for await (const chunk of fileBytes(handle, signal)) {
    count += chunk.byteLength;
    if (count > size) throw sourceChanged();
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** A local file opened for one run. Its identity is the SHA-256 of its content. */
export class OpenedFile implements OpenedSource {
  readonly identity: string;
  readonly size: number;
  readonly sha256: string;
  /** The file's identity on disk, so the file checkpoint store can refuse to write over it through a hard link. */
  readonly state: BigIntStats;
  readonly #handle: FileHandle;

  constructor(handle: FileHandle, state: BigIntStats, sha256: string) {
    this.#handle = handle;
    this.state = state;
    this.size = Number(state.size);
    this.sha256 = sha256;
    this.identity = sha256;
  }

  bytes(): AsyncIterable<Uint8Array> {
    return fileBytes(this.#handle, undefined);
  }

  assertUnchanged(): Promise<void> {
    return assertSameFile(this.#handle, this.state);
  }

  async close(): Promise<void> {
    try {
      await this.#handle.close();
    } catch (error) {
      throw new ImportKitError('SOURCE_ERROR', 'Unable to close the source file.', { cause: error });
    }
  }
}

export class FileByteSource implements FileSource {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    Object.freeze(this);
  }

  /** Opens the file and fingerprints its content before any record is read. */
  async open({ maxBytes, signal }: SourceContext): Promise<OpenedFile> {
    let handle: FileHandle;
    try {
      handle = await open(resolve(this.path), sourceReadFlags);
    } catch (error) {
      throw new ImportKitError('SOURCE_ERROR', 'Unable to open the source file.', { cause: error });
    }
    try {
      const state = await inspect(handle);
      if (!state.isFile()) throw new ImportKitError('SOURCE_ERROR', 'The source must be a regular file.');
      if (state.size > BigInt(maxBytes)) throw new ImportKitError('LIMIT_EXCEEDED', 'The source exceeds maxSourceBytes.');
      const sha256 = await fingerprint(handle, Number(state.size), signal);
      await assertSameFile(handle, state);
      return new OpenedFile(handle, state, sha256);
    } catch (error) {
      try { await handle.close(); } catch (closeError) {
        throw new ImportKitError('SOURCE_ERROR', 'Unable to inspect or close the source file.', { cause: new AggregateError([error, closeError]) });
      }
      throw error;
    }
  }
}

/** Selects a local file as the source of an import or a validation. */
export function fileSource(path: string): FileSource {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
    throw new ImportKitError('INVALID_OPTIONS', 'A source path must be a nonempty filesystem path.');
  }
  return new FileByteSource(path);
}
