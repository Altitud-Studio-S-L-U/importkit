export type ImportErrorCode =
  | 'INVALID_OPTIONS'
  | 'SOURCE_ERROR'
  | 'SOURCE_CHANGED'
  | 'LIMIT_EXCEEDED'
  | 'PARSE_ERROR'
  | 'CHECKPOINT_ERROR'
  | 'CHECKPOINT_MISMATCH'
  | 'IMPORT_LOCKED'
  | 'MAP_ERROR'
  | 'MEASURE_ERROR'
  | 'COMMIT_ERROR'
  | 'ABORTED';

export interface ImportKitErrorOptions {
  readonly cause?: unknown;
  readonly recordIndex?: number | undefined;
  readonly line?: number | undefined;
}

export class ImportKitError extends Error {
  readonly code: ImportErrorCode;
  readonly recordIndex: number | undefined;
  /** One-based source line of the record involved, when the reader reports it. */
  readonly line: number | undefined;

  constructor(code: ImportErrorCode, message: string, options: ImportKitErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ImportKitError';
    this.code = code;
    this.recordIndex = options.recordIndex;
    this.line = options.line;
  }
}

export function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImportKitError('ABORTED', 'Import cancelled.');
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
