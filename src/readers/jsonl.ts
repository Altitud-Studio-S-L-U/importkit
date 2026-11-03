import { ImportKitError } from '../errors.js';
import type { RecordReader } from '../types.js';
import { assertReaderLimits, recordSizeError } from './shared.js';

/** Strict JSON Lines; empty physical lines are errors, and a final newline is optional. */
export function jsonlReader(): RecordReader {
  return {
    id: 'jsonl:v1:utf8-strict',
    async *read(chunks, limits) {
      assertReaderLimits(limits);
      let parts: Uint8Array[] = [];
      let bytes = 0;
      let firstLine = true;

      const append = (part: Uint8Array): void => {
        if (bytes + part.byteLength > limits.maxRecordBytes) throw recordSizeError();
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
        if (firstLine) text = text.replace(/^﻿/u, '');
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
          if (bytes + 1 > limits.maxRecordBytes) throw recordSizeError();
          yield readLine();
          offset = index + 1;
        }
        append(chunk.subarray(offset));
      }
      if (bytes > 0) yield readLine();
    },
  };
}
