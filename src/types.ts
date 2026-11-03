export interface ReaderLimits {
  readonly maxRecordBytes: number;
}

/** A deterministic reader: the same bytes and reader ID must yield the same records. */
export interface RecordReader {
  readonly id: string;
  read(chunks: AsyncIterable<Uint8Array>, limits: ReaderLimits): AsyncIterable<unknown>;
}

export interface ImportLimits extends ReaderLimits {
  readonly maxSourceBytes: number;
  readonly maxRecords: number;
}

export interface ImportRecord<T> {
  readonly id: string;
  /** One-based parsed record ordinal; a CSV header is not a record. */
  readonly index: number;
  readonly value: T;
}

export interface RecordContext {
  readonly id: string;
  readonly index: number;
}

export interface ImportOptions<T> {
  readonly source: { readonly path: string; readonly reader: RecordReader };
  readonly importId: string;
  /** Change when mapping, validation, or destination semantics change. */
  readonly transformVersion: string;
  readonly checkpointPath: string;
  readonly batchSize?: number;
  /** Optional logical byte budget for a batch; requires measureRecordBytes. Not a heap limit. */
  readonly maxBatchBytes?: number;
  /** Synchronous size of the transformed value's intended encoding; requires maxBatchBytes. */
  readonly measureRecordBytes?: (value: T, context: RecordContext) => number;
  readonly limits?: Partial<ImportLimits>;
  readonly signal?: AbortSignal;
  readonly mapRecord: (input: unknown, context: RecordContext) => T | Promise<T>;
  /** Resolve only after durable writes. Replayed IDs must not create duplicate effects. */
  readonly commitBatch: (records: readonly ImportRecord<T>[]) => Promise<void>;
}

export interface ImportResult {
  readonly status: 'completed';
  readonly resumedFrom: number;
  readonly processedRecords: number;
  readonly committedBatches: number;
  readonly sourceHash: string;
}

export interface ValidationOptions<T> extends Pick<ImportOptions<T>, 'source' | 'importId' | 'transformVersion' | 'mapRecord' | 'limits' | 'signal'> {
  /** Maximum mapping issues retained; all mapping failures are still counted. */
  readonly maxIssues?: number;
}

export interface ValidationIssue {
  readonly code: 'MAP_ERROR';
  readonly recordIndex: number;
  /** Sanitized library message; application exception messages and causes are excluded. */
  readonly message: string;
}

interface ValidationSummary {
  readonly sourceHash: string;
  readonly processedRecords: number;
  readonly validRecords: number;
  readonly invalidRecords: number;
  readonly issues: readonly ValidationIssue[];
  readonly issuesTruncated: boolean;
}

export type ValidationResult = ValidationSummary & (
  | { readonly status: 'valid' | 'invalid' }
  | { readonly status: 'incomplete'; readonly parseError: { readonly code: 'PARSE_ERROR'; readonly message: string } }
);
