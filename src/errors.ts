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
  | 'COMMIT_ERROR'
  | 'ABORTED';

export class ImportKitError extends Error {
  readonly code: ImportErrorCode;
  readonly recordIndex: number | undefined;

  constructor(code: ImportErrorCode, message: string, options: { cause?: unknown; recordIndex?: number } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ImportKitError';
    this.code = code;
    this.recordIndex = options.recordIndex;
  }
}
