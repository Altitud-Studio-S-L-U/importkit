import { ImportKitError } from '../errors.js';
import type { ParsedRecord, RecordReader } from '../types.js';
import { assertReaderLimits, recordSizeError } from './shared.js';

/** Strict JSON Lines; empty physical lines are errors, and a final newline is optional. */
export function jsonlReader(): RecordReader {
  return {
    id: 'jsonl:v1:utf8-strict',
    async *read(chunks, limits) {
      assertReaderLimits(limits);
      // Each decode call is complete, so one decoder serves every line.
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      let parts: Uint8Array[] = [];
      let bytes = 0;
      let line = 1;
      let firstLine = true;

      const append = (part: Uint8Array): void => {
        if (bytes + part.byteLength > limits.maxRecordBytes) throw recordSizeError(line);
        if (part.byteLength > 0) parts.push(part);
        bytes += part.byteLength;
      };
      const readLine = (): ParsedRecord => {
        let text: string;
        try {
          text = decoder.decode(parts.length === 1 ? parts[0] : Buffer.concat(parts, bytes));
        } catch {
          throw new ImportKitError('PARSE_ERROR', 'Input must contain valid UTF-8.', { line });
        }
        parts = [];
        bytes = 0;
        if (firstLine) text = text.replace(/^\uFEFF/u, '');
        firstLine = false;
        if (text.endsWith('\r')) text = text.slice(0, -1);
        if (text.trim().length === 0) throw new ImportKitError('PARSE_ERROR', 'JSON Lines input must not contain empty records.', { line });
        let value: unknown;
        try {
          value = JSON.parse(text) as unknown;
        } catch {
          throw new ImportKitError('PARSE_ERROR', 'Invalid JSON Lines input.', { line });
        }
        return { value, line: line++ };
      };

      for await (const chunk of chunks) {
        // Buffer#indexOf finds line feeds natively; a UTF-8 multibyte sequence never contains the byte 10.
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        let offset = 0;
        for (let index = buffer.indexOf(10); index !== -1; index = buffer.indexOf(10, offset)) {
          append(buffer.subarray(offset, index));
          if (bytes + 1 > limits.maxRecordBytes) throw recordSizeError(line);
          yield readLine();
          offset = index + 1;
        }
        append(buffer.subarray(offset));
      }
      if (bytes > 0) yield readLine();
    },
  };
}
