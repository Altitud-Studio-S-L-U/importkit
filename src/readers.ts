import { parse } from 'csv-parse';
import { ImportKitError } from './errors.js';
import type { RecordReader, ReaderLimits } from './types.js';

function assertLimit(limits: ReaderLimits): void {
  if (!Number.isSafeInteger(limits.maxRecordBytes) || limits.maxRecordBytes < 1) {
    throw new ImportKitError('INVALID_OPTIONS', 'maxRecordBytes must be a positive safe integer.');
  }
}

function limitError(): ImportKitError {
  return new ImportKitError('LIMIT_EXCEEDED', 'A serialized record exceeds maxRecordBytes.');
}

function csvError(error: unknown): ImportKitError {
  if (error instanceof ImportKitError) return error;
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'CSV_MAX_RECORD_SIZE') {
    return limitError();
  }
  // csv-parse errors may contain source values; keep those out of the public error.
  return new ImportKitError('PARSE_ERROR', 'Invalid CSV input.');
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
      assertLimit(limits);
      let completedBytes = 0;
      let offeredBytes = 0;
      // csv-parse retains a few UTF-8 bytes to distinguish delimiters, escaped
      // quotes, and multibyte whitespace. This constant lookahead is not part of
      // an accepted record's byte budget, checked independently in on_record.
      const lookaheadBytes = 4;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const parser = parse({
        bom: true,
        delimiter,
        columns: false,
        skip_empty_lines: false,
        relax_column_count: false,
        max_record_size: limits.maxRecordBytes,
        on_record: (record: string[], info) => {
          if (info.bytes - completedBytes > limits.maxRecordBytes) throw limitError();
          completedBytes = info.bytes;
          return record;
        },
      });

      // A producer and consumer run together so the parser's object-mode high-water
      // mark supplies backpressure. Feeding is bounded by parsed byte progress,
      // because max_record_size alone does not count delimiters or empty fields.
      const producer = (async () => {
        try {
          for await (const chunk of chunks) {
            let offset = 0;
            while (offset < chunk.byteLength) {
              const capacity = limits.maxRecordBytes + lookaheadBytes - (offeredBytes - completedBytes);
              if (capacity <= 0) throw limitError();
              const end = Math.min(chunk.byteLength, offset + capacity, offset + 16_384);
              const part = chunk.subarray(offset, end);
              validateUtf8(decoder, part);
              offeredBytes += part.byteLength;
              await new Promise<void>((resolve, reject) => {
                parser.write(part, (error) => error ? reject(csvError(error)) : resolve());
              });
              if (offeredBytes - completedBytes >= limits.maxRecordBytes + lookaheadBytes) throw limitError();
              offset = end;
            }
          }
          validateUtf8(decoder);
          await new Promise<void>((resolve, reject) => {
            parser.end((error?: Error | null) => error ? reject(csvError(error)) : resolve());
          });
        } catch (error) {
          parser.destroy(error instanceof ImportKitError ? error : new ImportKitError('SOURCE_ERROR', 'Unable to read source bytes.', { cause: error }));
        }
      })();

      let headers: string[] | undefined;
      try {
        for await (const row of parser as AsyncIterable<string[]>) {
          if (headers === undefined) {
            if (row.some((header) => header.trim().length === 0 || ['__proto__', 'prototype', 'constructor'].includes(header)) || new Set(row).size !== row.length) {
              throw new ImportKitError('PARSE_ERROR', 'CSV headers must be nonempty, unique, and must not use reserved object keys.');
            }
            headers = row;
            continue;
          }
          const record: Record<string, string> = Object.create(null) as Record<string, string>;
          for (const [index, header] of headers.entries()) record[header] = row[index]!;
          yield record;
        }
        await producer;
      } catch (error) {
        throw csvError(error);
      } finally {
        parser.destroy();
        await producer;
      }
    },
  };
}

/** Strict JSON Lines; empty physical lines are errors, and a final newline is optional. */
export function jsonlReader(): RecordReader {
  return {
    id: 'jsonl:v1:utf8-strict',
    async *read(chunks, limits) {
      assertLimit(limits);
      let parts: Uint8Array[] = [];
      let bytes = 0;
      let firstLine = true;

      const append = (part: Uint8Array): void => {
        if (bytes + part.byteLength > limits.maxRecordBytes) throw limitError();
        if (part.byteLength > 0) parts.push(part);
        bytes += part.byteLength;
      };
      const readLine = (): unknown => {
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts, bytes));
        } catch {
          throw new ImportKitError('PARSE_ERROR', 'Input must contain valid UTF-8.');
        }
        parts = [];
        bytes = 0;
        if (firstLine) text = text.replace(/^\uFEFF/u, '');
        firstLine = false;
        if (text.endsWith('\r')) text = text.slice(0, -1);
        if (text.trim().length === 0) throw new ImportKitError('PARSE_ERROR', 'JSON Lines input must not contain empty records.');
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new ImportKitError('PARSE_ERROR', 'Invalid JSON Lines input.');
        }
      };

      for await (const chunk of chunks) {
        let offset = 0;
        for (let index = 0; index < chunk.byteLength; index++) {
          if (chunk[index] !== 10) continue;
          append(chunk.subarray(offset, index));
          if (bytes + 1 > limits.maxRecordBytes) throw limitError();
          yield readLine();
          offset = index + 1;
        }
        append(chunk.subarray(offset));
      }
      if (bytes > 0) yield readLine();
    },
  };
}
