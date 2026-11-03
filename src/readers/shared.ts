import { ImportKitError } from '../errors.js';
import type { ReaderLimits } from '../types.js';

export function assertReaderLimits(limits: ReaderLimits): void {
  if (!Number.isSafeInteger(limits.maxRecordBytes) || limits.maxRecordBytes < 1) {
    throw new ImportKitError('INVALID_OPTIONS', 'maxRecordBytes must be a positive safe integer.');
  }
}

export function recordSizeError(line: number): ImportKitError {
  return new ImportKitError('LIMIT_EXCEEDED', 'A serialized record exceeds maxRecordBytes.', { line });
}
