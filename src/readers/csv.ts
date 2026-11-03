import { parse } from 'csv-parse';
import type { InfoRecord } from 'csv-parse';
import { hasErrorCode, ImportKitError } from '../errors.js';
import type { ParsedRecord, RecordReader } from '../types.js';
import { LineCounter } from './line-counter.js';
import { assertReaderLimits, recordSizeError } from './shared.js';

interface CsvRow {
  readonly fields: string[];
  readonly line: number;
}

function csvError(error: unknown, line: number): ImportKitError {
  if (error instanceof ImportKitError) return error;
  if (hasErrorCode(error, 'CSV_MAX_RECORD_SIZE')) return recordSizeError(line);
  // csv-parse errors may contain source values; keep those out of the public error.
  return new ImportKitError('PARSE_ERROR', 'Invalid CSV input.', { line });
}

function validateUtf8(decoder: TextDecoder, chunk?: Uint8Array): void {
  try {
    if (chunk === undefined) decoder.decode();
    else decoder.decode(chunk, { stream: true });
  } catch {
    throw new ImportKitError('PARSE_ERROR', 'Input must contain valid UTF-8.');
  }
}

/** CSV with a header row and strict field counts. Serialized limits include row terminators. */
export function csvReader(options: { readonly delimiter?: string } = {}): RecordReader {
  const delimiter = options.delimiter ?? ',';
  if (typeof delimiter !== 'string' || delimiter.length !== 1 || delimiter.charCodeAt(0) > 127 || /[\r\n"\0]/u.test(delimiter)) {
    throw new ImportKitError('INVALID_OPTIONS', 'The CSV delimiter must be one ASCII character other than quote, NUL, CR, or LF.');
  }

  return {
    id: `csv:v1:utf8-header:${delimiter.charCodeAt(0).toString(16)}`,
    async *read(chunks, limits) {
      assertReaderLimits(limits);
      let completedBytes = 0;
      let offeredBytes = 0;
      // csv-parse counts a CRLF inside a quoted field as two lines, so lines are
      // counted from the byte offset where each record starts.
      const lines = new LineCounter();
      let recordLine = 1;
      // csv-parse retains a few UTF-8 bytes to distinguish delimiters, escaped
      // quotes, and multibyte whitespace. This constant lookahead is not part of
      // an accepted record's byte budget, checked independently in on_record.
      const lookaheadBytes = 4;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const onRecord = (fields: string[], info: InfoRecord): CsvRow => {
        if (info.bytes - completedBytes > limits.maxRecordBytes) throw recordSizeError(recordLine);
        const row = { fields, line: recordLine };
        completedBytes = info.bytes;
        recordLine = lines.lineAt(completedBytes);
        return row;
      };
      const parser = parse({
        bom: true,
        delimiter,
        columns: false,
        skip_empty_lines: false,
        relax_column_count: false,
        max_record_size: limits.maxRecordBytes,
        // The parser emits whatever on_record returns, but its types expect the unchanged fields.
        on_record: onRecord as unknown as (fields: string[], info: InfoRecord) => string[],
      });

      // destroy() drops a write callback that backpressure holds back, so every
      // wait for the parser also ends when it closes; the producer then stops.
      const closed = new Promise<void>((resolve) => { parser.once('close', resolve); });
      const settle = async (operation: (done: (error?: Error | null) => void) => void): Promise<void> => {
        const done = new Promise<void>((resolve, reject) => {
          operation((error) => error ? reject(csvError(error, recordLine)) : resolve());
        });
        // A failure reported after the parser closed has no consumer left to reach.
        done.catch(() => {});
        await Promise.race([done, closed]);
      };

      // A producer and consumer run together so the parser's object-mode high-water
      // mark supplies backpressure. Feeding is bounded by parsed byte progress,
      // because max_record_size alone does not count delimiters or empty fields.
      const producer = (async () => {
        try {
          for await (const chunk of chunks) {
            let offset = 0;
            while (offset < chunk.byteLength) {
              if (parser.destroyed) return;
              const capacity = limits.maxRecordBytes + lookaheadBytes - (offeredBytes - completedBytes);
              if (capacity <= 0) throw recordSizeError(recordLine);
              const end = Math.min(chunk.byteLength, offset + capacity, offset + 16_384);
              const part = chunk.subarray(offset, end);
              validateUtf8(decoder, part);
              offeredBytes += part.byteLength;
              lines.append(part);
              await settle((done) => parser.write(part, done));
              if (offeredBytes - completedBytes >= limits.maxRecordBytes + lookaheadBytes) throw recordSizeError(recordLine);
              offset = end;
            }
          }
          if (parser.destroyed) return;
          validateUtf8(decoder);
          await settle((done) => parser.end(done));
        } catch (error) {
          parser.destroy(error instanceof ImportKitError ? error : new ImportKitError('SOURCE_ERROR', 'Unable to read source bytes.', { cause: error }));
        }
      })();

      let headers: string[] | undefined;
      try {
        for await (const { fields, line } of parser as AsyncIterable<CsvRow>) {
          if (headers === undefined) {
            if (fields.some((header) => header.trim().length === 0 || ['__proto__', 'prototype', 'constructor'].includes(header)) || new Set(fields).size !== fields.length) {
              throw new ImportKitError('PARSE_ERROR', 'CSV headers must be nonempty, unique, and must not use reserved object keys.', { line });
            }
            headers = fields;
            continue;
          }
          const value: Record<string, string> = Object.create(null) as Record<string, string>;
          for (const [index, header] of headers.entries()) value[header] = fields[index]!;
          const record: ParsedRecord = { value, line };
          yield record;
        }
        await producer;
      } catch (error) {
        throw csvError(error, recordLine);
      } finally {
        parser.destroy();
        await producer;
      }
    },
  };
}
