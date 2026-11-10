import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hasErrorCode, ImportKitError } from '../errors.js';
import { sourceReadFlags } from '../sources/file-source.js';
import type { Checkpoint, CheckpointStore } from '../types.js';
import { checkpointError, maxCheckpointBytes, validateCheckpoint } from './checkpoint.js';

function symbolicLinkCheckpoint(): ImportKitError {
  return checkpointError('Checkpoint metadata must be stored in a regular file, not a symbolic link.');
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  // Open before inspecting, so every check below describes the file that is read rather than whatever
  // the path named a moment earlier. O_NOFOLLOW refuses a symbolic link where the platform supports it;
  // O_NONBLOCK keeps a FIFO from blocking the open on POSIX systems.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let handle: FileHandle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    if (hasErrorCode(error, 'ELOOP')) throw symbolicLinkCheckpoint();
    throw error;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw checkpointError('Checkpoint metadata must be stored in a regular file.');
    // Without O_NOFOLLOW (Windows) the open follows a link, so the path itself must still name this file.
    const entry = await lstat(path, { bigint: true });
    if (entry.isSymbolicLink() || entry.dev !== stat.dev || entry.ino !== stat.ino) throw symbolicLinkCheckpoint();
    if (stat.size > BigInt(maxBytes)) throw checkpointError('Checkpoint metadata exceeds its size limit.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.byteLength) {
      const result = await handle.read(buffer, bytes, buffer.byteLength - bytes, bytes);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > maxBytes) throw checkpointError('Checkpoint metadata exceeds its size limit.');
    return buffer.subarray(0, bytes);
  } finally {
    await handle.close();
  }
}

export async function canonicalCheckpointPath(input: string): Promise<string> {
  try {
    if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
      throw checkpointError('A checkpoint path must be a nonempty filesystem path.');
    }
    const absolute = resolve(input);
    const directory = await realpath(dirname(absolute));
    return join(directory, basename(absolute));
  } catch (error) {
    if (error instanceof ImportKitError) throw error;
    throw checkpointError('Unable to resolve the checkpoint directory.', error);
  }
}

export async function readCheckpoint(path: string): Promise<Checkpoint | undefined> {
  try {
    const bytes = await readBoundedRegularFile(path, maxCheckpointBytes);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return validateCheckpoint(JSON.parse(text) as unknown);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    if (error instanceof ImportKitError) throw error;
    throw checkpointError('Unable to read valid checkpoint metadata.', error);
  }
}

function unsupportedDirectorySync(error: unknown): boolean {
  const codes = process.platform === 'win32'
    ? ['EPERM', 'EISDIR', 'EINVAL', 'EBADF']
    : ['EINVAL', 'ENOTSUP'];
  return codes.some((code) => hasErrorCode(error, code));
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (!unsupportedDirectorySync(error)) throw error;
  } finally {
    if (handle !== undefined) await handle.close();
  }
}

export async function writeCheckpoint(path: string, state: Checkpoint): Promise<void> {
  let temporaryPath: string | undefined;
  let handle: FileHandle | undefined;
  let failure: unknown;
  try {
    const snapshot = validateCheckpoint(state);
    const bytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
    if (bytes.byteLength > maxCheckpointBytes) throw checkpointError('Checkpoint metadata exceeds its size limit.');
    try {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw checkpointError('The checkpoint destination must be a regular file, not a symbolic link.');
      }
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    }

    temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    temporaryPath = undefined;
    await syncDirectory(dirname(path));
    return;
  } catch (error) {
    failure = error;
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); } catch (error) {
        failure = failure === undefined ? error : new AggregateError([failure, error], 'Checkpoint cleanup failed.');
      }
    }
    if (temporaryPath !== undefined) {
      try { await unlink(temporaryPath); } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
          failure = failure === undefined ? error : new AggregateError([failure, error], 'Checkpoint cleanup failed.');
        }
      }
    }
  }
  if (failure instanceof ImportKitError) throw failure;
  throw checkpointError('Unable to persist checkpoint metadata.', failure);
}

export async function acquireCheckpointLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  const token = randomUUID();
  let handle: FileHandle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      throw new ImportKitError('IMPORT_LOCKED', 'This checkpoint is already locked. Verify the original process has stopped before removing its lock.');
    }
    throw checkpointError('Unable to acquire the checkpoint lock.', error);
  }

  const identity = await handle.stat().catch(async (error: unknown) => {
    try { await handle.close(); } catch (closeError) {
      throw checkpointError('Unable to inspect or close the newly acquired checkpoint lock.', new AggregateError([error, closeError]));
    }
    throw checkpointError('Unable to inspect the newly acquired checkpoint lock. Verify ownership before removing it.', error);
  });
  try {
    await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
    await handle.sync();
    await handle.close();
  } catch (error) {
    const failures = [error];
    try {
      const current = await lstat(lockPath);
      if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
        await unlink(lockPath);
      }
    } catch (unlinkError) {
      if (!hasErrorCode(unlinkError, 'ENOENT')) failures.push(unlinkError);
    }
    try { await handle.close(); } catch (closeError) { failures.push(closeError); }
    throw checkpointError('Unable to initialize the checkpoint lock.', new AggregateError(failures));
  }

  let released = false;
  return async () => {
    if (released) return;
    try {
      const current = await lstat(lockPath);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw checkpointError('The checkpoint lock was replaced and has not been removed.');
      }
      const bytes = await readBoundedRegularFile(lockPath, 1_024);
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      if (typeof value !== 'object' || value === null || !('token' in value) || value.token !== token) {
        throw checkpointError('The checkpoint lock was replaced and has not been removed.');
      }
      await unlink(lockPath);
      released = true;
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        released = true;
        return;
      }
      if (error instanceof ImportKitError) throw error;
      throw checkpointError('Unable to release the checkpoint lock.', error);
    }
  };
}

/** Checkpoints in a local JSON file, replaced atomically, with an exclusive lock file beside it. */
export class FileCheckpointStore implements CheckpointStore {
  readonly #path: string;
  #resolved: string | undefined;

  constructor(path: string) {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
      throw new ImportKitError('INVALID_OPTIONS', 'A checkpoint path must be a nonempty filesystem path.');
    }
    this.#path = path;
  }

  /** The checkpoint file and its lock. The directory is resolved on first use and reused afterwards. */
  async paths(): Promise<{ readonly checkpoint: string; readonly lock: string }> {
    this.#resolved ??= await canonicalCheckpointPath(this.#path);
    return { checkpoint: this.#resolved, lock: `${this.#resolved}.lock` };
  }

  async lock(): Promise<() => Promise<void>> {
    return acquireCheckpointLock((await this.paths()).checkpoint);
  }

  async load(): Promise<Checkpoint | undefined> {
    return readCheckpoint((await this.paths()).checkpoint);
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    await writeCheckpoint((await this.paths()).checkpoint, checkpoint);
  }

  /** Rejects a source path that names the checkpoint file or its lock. */
  async assertSeparatePath(sourcePath: string): Promise<void> {
    const paths = await this.paths();
    if (sourcePath === paths.checkpoint || sourcePath === paths.lock) {
      throw new ImportKitError('INVALID_OPTIONS', 'Source, checkpoint, and lock must be different files.');
    }
  }

  /** Compares file identity as well as paths, so a hard link cannot make the checkpoint or its lock overwrite the source. */
  async assertSeparateFile(source: BigIntStats): Promise<void> {
    const paths = await this.paths();
    for (const path of [paths.checkpoint, paths.lock]) {
      let reserved: FileHandle | undefined;
      try {
        reserved = await open(path, sourceReadFlags);
        const state = await reserved.stat({ bigint: true });
        if (state.dev === source.dev && state.ino === source.ino) {
          throw new ImportKitError('INVALID_OPTIONS', 'Source, checkpoint, and lock must be different files.');
        }
      } catch (error) {
        if (error instanceof ImportKitError) throw error;
        if (!hasErrorCode(error, 'ENOENT')) throw checkpointError('Unable to inspect the checkpoint path.', error);
      } finally {
        await reserved?.close();
      }
    }
  }
}

/** Keeps progress in a local file. Its directory must exist; the file and `<path>.lock` are created as needed. */
export function fileCheckpointStore(path: string): CheckpointStore {
  return new FileCheckpointStore(path);
}
