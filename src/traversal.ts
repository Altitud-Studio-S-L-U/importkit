import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { checkAbort, ImportKitError } from './errors.js';
import { sourceBytes } from './file-source.js';
import { recordId } from './record-id.js';
import type { ImportLimits, ImportOptions, ParsedRecord, RecordContext } from './types.js';

type TraversalOptions = Pick<ImportOptions<unknown>, 'reader' | 'importId' | 'transformVersion' | 'signal'>;

export interface RecordTraversal {
  /** Records from the reader, in source order. The bytes the reader consumes feed `parsedHash()`. */
  inputs(): AsyncIterable<ParsedRecord>;
  /** Checks the next parsed record, enforces maxRecords and returns its one-based ordinal. */
  visit(record: ParsedRecord): number;
  /** The context that callbacks receive for the record at `index`. */
  context(index: number, record: ParsedRecord): RecordContext;
  /** Records parsed so far. */
  count(): number;
  /** Source bytes given to the reader so far. */
  bytesRead(): number;
  /** SHA-256 of the bytes given to the reader. Call it once, after the traversal ends. */
  parsedHash(): string;
}

/** Readers are application code, and one written for 0.3 yields bare values that must not be taken for records. */
function isParsedRecord(record: unknown): record is ParsedRecord {
  if (typeof record !== 'object' || record === null || !Object.hasOwn(record, 'value')) return false;
  for (const key in record) if (key !== 'value' && key !== 'line') return false;
  const { line } = record as { readonly line?: unknown };
  return line === undefined || (Number.isSafeInteger(line) && (line as number) >= 1);
}

/**
 * One parsing pass over the open source, shared by imports and validation. Callers iterate `inputs()` directly and
 * call `visit()` per record, so each record crosses a single async iteration.
 */
export function traverseRecords(handle: FileHandle, options: TraversalOptions, limits: ImportLimits, sourceHash: string): RecordTraversal {
  const hash = createHash('sha256');
  let count = 0;
  let bytesRead = 0;

  async function* verifiedBytes(): AsyncIterable<Uint8Array> {
    for await (const chunk of sourceBytes(handle, limits.maxSourceBytes, options.signal)) {
      hash.update(chunk);
      bytesRead += chunk.byteLength;
      yield chunk;
    }
  }

  return {
    inputs: () => options.reader.read(verifiedBytes(), limits),
    visit(record) {
      checkAbort(options.signal);
      if (!isParsedRecord(record)) {
        throw new ImportKitError('INVALID_OPTIONS', 'A reader must yield records as { value, line? }, with line a positive integer.', { recordIndex: count + 1 });
      }
      count++;
      if (count > limits.maxRecords) throw new ImportKitError('LIMIT_EXCEEDED', 'The source exceeds maxRecords.', { recordIndex: count, line: record.line });
      return count;
    },
    context(index, record) {
      const id = recordId(options, sourceHash, index);
      return record.line === undefined ? { id, index } : { id, index, line: record.line };
    },
    count: () => count,
    bytesRead: () => bytesRead,
    parsedHash: () => hash.digest('hex'),
  };
}
