import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { acquireCheckpointLock, canonicalCheckpointPath, readCheckpoint, writeCheckpoint } from '../dist/checkpoint.js';

const scratchRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp');
const fixture = Object.freeze({
  version: 1,
  importId: 'fixture-import',
  transformVersion: 'v1',
  readerId: 'jsonl:v1:utf8-strict',
  sourceHash: 'a'.repeat(64),
  processedRecords: 2,
  completed: false,
});

async function scope(t) {
  await mkdir(scratchRoot, { recursive: true });
  const directory = await mkdtemp(join(scratchRoot, 'checkpoint-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, checkpoint: join(directory, 'progress.json') };
}

test('an absent checkpoint starts without progress', async (t) => {
  const { checkpoint } = await scope(t);
  assert.equal(await readCheckpoint(checkpoint), undefined);
});

test('checkpoint writes replace progress and leave only the final file', async (t) => {
  const { directory, checkpoint } = await scope(t);
  await writeCheckpoint(checkpoint, fixture);
  assert.deepEqual(await readCheckpoint(checkpoint), fixture);
  const completed = { ...fixture, processedRecords: 5, completed: true };
  await writeCheckpoint(checkpoint, completed);
  assert.deepEqual(await readCheckpoint(checkpoint), completed);
  assert.deepEqual(await readdir(directory), ['progress.json']);
  if (process.platform !== 'win32') assert.equal((await stat(checkpoint)).mode & 0o777, 0o600);
});

test('corrupt, oversized, and invalid UTF-8 checkpoint files fail explicitly', async (t) => {
  const { checkpoint } = await scope(t);
  for (const bytes of ['{', ' '.repeat(16_385), Buffer.from([0xc3, 0x28])]) {
    await writeFile(checkpoint, bytes);
    await assert.rejects(readCheckpoint(checkpoint), { code: 'CHECKPOINT_ERROR' });
  }
});

test('checkpoint validation rejects incompatible or unexpected metadata', async (t) => {
  const { checkpoint } = await scope(t);
  const invalid = [
    null, [], {},
    { ...fixture, version: 2 },
    { ...fixture, importId: '' },
    { ...fixture, transformVersion: 1 },
    { ...fixture, readerId: '' },
    { ...fixture, sourceHash: 'not-a-sha256' },
    { ...fixture, processedRecords: -1 },
    { ...fixture, processedRecords: 0.5 },
    { ...fixture, processedRecords: Number.MAX_SAFE_INTEGER + 1 },
    { ...fixture, completed: 'true' },
    { ...fixture, rawData: 'unexpected' },
  ];
  for (const value of invalid) {
    await writeFile(checkpoint, JSON.stringify(value));
    await assert.rejects(readCheckpoint(checkpoint), { code: 'CHECKPOINT_ERROR' });
  }
});

test('invalid writes preserve the previous checkpoint', async (t) => {
  const { directory, checkpoint } = await scope(t);
  await writeCheckpoint(checkpoint, fixture);
  await assert.rejects(writeCheckpoint(checkpoint, { ...fixture, processedRecords: -1 }), { code: 'CHECKPOINT_ERROR' });
  await assert.rejects(writeCheckpoint(checkpoint, { ...fixture, importId: 'x'.repeat(20_000) }), { code: 'CHECKPOINT_ERROR' });
  assert.deepEqual(await readCheckpoint(checkpoint), fixture);
  assert.deepEqual(await readdir(directory), ['progress.json']);
});

test('nonregular checkpoint destinations are rejected without changing them', async (t) => {
  const { checkpoint } = await scope(t);
  await mkdir(checkpoint);
  await assert.rejects(readCheckpoint(checkpoint), { code: 'CHECKPOINT_ERROR' });
  await assert.rejects(writeCheckpoint(checkpoint, fixture), { code: 'CHECKPOINT_ERROR' });
  assert.equal((await stat(checkpoint)).isDirectory(), true);
});

test('canonical paths normalize relative segments and require an existing directory', async (t) => {
  const { directory } = await scope(t);
  const resolved = await canonicalCheckpointPath(join(directory, '..', directory.split(/[\\/]/u).at(-1), 'progress.json'));
  assert.equal(resolved, join(await realpath(directory), 'progress.json'));
  await assert.rejects(canonicalCheckpointPath(join(directory, 'missing', 'progress.json')), { code: 'CHECKPOINT_ERROR' });
  await assert.rejects(canonicalCheckpointPath(''), { code: 'CHECKPOINT_ERROR' });
});

test('a lock excludes other writers and releases idempotently', async (t) => {
  const { checkpoint } = await scope(t);
  const release = await acquireCheckpointLock(checkpoint);
  await assert.rejects(acquireCheckpointLock(checkpoint), { code: 'IMPORT_LOCKED' });
  const metadata = JSON.parse(await readFile(`${checkpoint}.lock`, 'utf8'));
  assert.equal(metadata.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(metadata.createdAt)));
  await release();
  await release();
  const releaseAgain = await acquireCheckpointLock(checkpoint);
  await releaseAgain();
});

test('an existing lock is not recovered automatically even if it claims an old date', async (t) => {
  const { checkpoint } = await scope(t);
  const lockPath = `${checkpoint}.lock`;
  const content = JSON.stringify({ token: 'someone-else', pid: 1, createdAt: '1970-01-01T00:00:00.000Z' });
  await writeFile(lockPath, content);
  await assert.rejects(acquireCheckpointLock(checkpoint), { code: 'IMPORT_LOCKED' });
  assert.equal(await readFile(lockPath, 'utf8'), content);
});

test('releasing a lock never removes a replacement owned by another run', async (t) => {
  const { checkpoint } = await scope(t);
  const release = await acquireCheckpointLock(checkpoint);
  const lockPath = `${checkpoint}.lock`;
  await unlink(lockPath);
  const replacement = JSON.stringify({ token: 'different-owner' });
  await writeFile(lockPath, replacement);
  await assert.rejects(release(), { code: 'CHECKPOINT_ERROR' });
  assert.equal(await readFile(lockPath, 'utf8'), replacement);
});

test('symlink checkpoint files are rejected without changing their targets', async (t) => {
  const { directory, checkpoint } = await scope(t);
  const target = join(directory, 'target.json');
  await writeCheckpoint(target, fixture);
  try {
    await symlink(target, checkpoint, 'file');
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('This Windows account cannot create file symlinks (EPERM).');
    return;
  }
  await assert.rejects(readCheckpoint(checkpoint), { code: 'CHECKPOINT_ERROR' });
  await assert.rejects(writeCheckpoint(checkpoint, fixture), { code: 'CHECKPOINT_ERROR' });
  assert.deepEqual(await readCheckpoint(target), fixture);
});

test('directory aliases canonicalize to the same checkpoint path', async (t) => {
  const { directory } = await scope(t);
  const alias = join(directory, 'directory-alias');
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await canonicalCheckpointPath(join(alias, 'alias-progress.json')), join(await realpath(directory), 'alias-progress.json'));
});
