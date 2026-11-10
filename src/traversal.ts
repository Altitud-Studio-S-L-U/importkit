import { createHash } from 'node:crypto';
import { checkAbort, ImportKitError } from './errors.js';
import { recordIds } from './record-id.js';
import type { GuardedSource } from './sources/source.js';
import type { ImportLimits, ImportOptions, ParsedRecord, RecordContext } from './types.js';

type TraversalOptions = Pick<ImportOptions<unknown>, 'reader' | 'importId' | 'transformVersion' | 'signal'>;

export interface RecordTraversal {
  /** Records from the reader, in source order. The bytes the reader consumes feed `contentHash()`. */
  inputs(): AsyncIterable<ParsedRecord>;
  /** Checks the next parsed record, enforces maxRecords and returns its one-based ordinal. */
  visit(record: ParsedRecord): number;
  /** The context that callbacks receive for the record at `index`. */
  context(index: number, record: ParsedRecord): RecordContext;
  /** Records parsed so far. */
  count(): number;
  /** Source bytes read so far. */
  bytesRead(): number;
  /** Reads whatever the reader left unread, so that the hash covers the whole source. */
  drain(): Promise<void>;
  /** SHA-256 of the whole source. Call it once, after `drain()`. */
  contentHash(): string;
  /** Stops reading the source when the traversal ends early. */
  close(): Promise<void>;
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
 * call `visit()` per record, so each record crosses a single async iteration. The source iterator outlives the
 * reader's, so that after a parse error the rest of the source can still be hashed.
 */
export function traverseRecords(source: GuardedSource, options: TraversalOptions, limits: ImportLimits): RecordTraversal {
  const hash = createHash('sha256');
  const idOf = recordIds(options, source.identity);
  const chunks = source.bytes()[Symbol.asyncIterator]();
  let ended = false;
  let count = 0;
  let bytesRead = 0;

  const pull = async (): Promise<Uint8Array | undefined> => {
    if (ended) return undefined;
    const next = await chunks.next();
    if (next.done === true) {
      ended = true;
      return undefined;
    }
    hash.update(next.value);
    bytesRead += next.value.byteLength;
    return next.value;
  };

  async function* readerInput(): AsyncIterable<Uint8Array> {
    for (let chunk = await pull(); chunk !== undefined; chunk = await pull()) yield chunk;
  }

  return {
    inputs: () => options.reader.read(readerInput(), limits),
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
      const id = idOf(index);
      return record.line === undefined ? { id, index } : { id, index, line: record.line };
    },
    count: () => count,
    bytesRead: () => bytesRead,
    async drain() {
      while (await pull() !== undefined) checkAbort(options.signal);
    },
    contentHash: () => hash.digest('hex'),
    async close() {
      if (ended) return;
      ended = true;
      await chunks.return?.();
    },
  };
}
