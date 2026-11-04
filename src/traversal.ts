import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { checkAbort, ImportKitError } from './errors.js';
import { sourceBytes } from './file-source.js';
import { recordId } from './record-id.js';
import type { ImportLimits, ImportOptions } from './types.js';

type TraversalOptions = Pick<ImportOptions<unknown>, 'reader' | 'importId' | 'transformVersion' | 'signal'>;

export interface RecordTraversal {
  /** Records from the reader, in source order. The bytes the reader consumes feed `parsedHash()`. */
  inputs(): AsyncIterable<unknown>;
  /** Counts the next parsed record, enforces maxRecords and returns its one-based ordinal. */
  visit(): number;
  recordId(index: number): string;
  /** Records parsed so far. */
  count(): number;
  /** SHA-256 of the bytes given to the reader. Call it once, after the traversal ends. */
  parsedHash(): string;
}

/**
 * One parsing pass over the open source, shared by imports and validation. Callers iterate `inputs()` directly and
 * call `visit()` per record, so each record crosses a single async iteration.
 */
export function traverseRecords(handle: FileHandle, options: TraversalOptions, limits: ImportLimits, sourceHash: string): RecordTraversal {
  const hash = createHash('sha256');
  let count = 0;

  async function* verifiedBytes(): AsyncIterable<Uint8Array> {
    for await (const chunk of sourceBytes(handle, limits.maxSourceBytes, options.signal)) {
      hash.update(chunk);
      yield chunk;
    }
  }

  return {
    inputs: () => options.reader.read(verifiedBytes(), limits),
    visit() {
      checkAbort(options.signal);
      count++;
      if (count > limits.maxRecords) throw new ImportKitError('LIMIT_EXCEEDED', 'The source exceeds maxRecords.', { recordIndex: count });
      return count;
    },
    recordId: (index) => recordId(options, sourceHash, index),
    count: () => count,
    parsedHash: () => hash.digest('hex'),
  };
}
