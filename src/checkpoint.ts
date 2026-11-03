import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImportKitError } from './errors.js';

export interface Checkpoint {
  readonly version: 1;
  readonly importId: string;
  readonly transformVersion: string;
  readonly readerId: string;
  readonly sourceHash: string;
  readonly processedRecords: number;
  readonly completed: boolean;
}

const maxCheckpointBytes = 16_384;
const checkpointKeys = [
  'version', 'importId', 'transformVersion', 'readerId',
  'sourceHash', 'processedRecords', 'completed',
] as const;

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function checkpointError(message: string, cause?: unknown): ImportKitError {
  return new ImportKitError('CHECKPOINT_ERROR', message, cause === undefined ? {} : { cause });
}

function validateCheckpoint(value: unknown): Checkpoint {
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

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw checkpointError('Checkpoint metadata must be stored in a regular file, not a symbolic link.');
  }
  // O_NOFOLLOW prevents a symlink substitution where the platform supports it.
  // O_NONBLOCK avoids blocking on a nonregular replacement on POSIX systems.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw checkpointError('Checkpoint metadata must be stored in a regular file.');
    if (stat.size > maxBytes) throw checkpointError('Checkpoint metadata exceeds its size limit.');
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
    if (hasCode(error, 'ENOENT')) return undefined;
    if (error instanceof ImportKitError) throw error;
    throw checkpointError('Unable to read valid checkpoint metadata.', error);
  }
}

function unsupportedDirectorySync(error: unknown): boolean {
  const codes = process.platform === 'win32'
    ? ['EPERM', 'EISDIR', 'EINVAL', 'EBADF']
    : ['EINVAL', 'ENOTSUP'];
  return codes.some((code) => hasCode(error, code));
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
      if (!hasCode(error, 'ENOENT')) throw error;
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
        if (!hasCode(error, 'ENOENT')) {
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
    if (hasCode(error, 'EEXIST')) {
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
      if (!hasCode(unlinkError, 'ENOENT')) failures.push(unlinkError);
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
      if (hasCode(error, 'ENOENT')) {
        released = true;
        return;
      }
      if (error instanceof ImportKitError) throw error;
      throw checkpointError('Unable to release the checkpoint lock.', error);
    }
  };
}
