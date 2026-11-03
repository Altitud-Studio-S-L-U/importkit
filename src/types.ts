export interface ReaderLimits {
  readonly maxRecordBytes: number;
}

/** One record decoded by a reader. */
export interface ParsedRecord {
  readonly value: unknown;
  /** One-based line of the source where the record starts, for formats that have lines. */
  readonly line?: number;
}

/** A deterministic reader: the same bytes and reader ID must yield the same records. */
export interface RecordReader {
  readonly id: string;
  read(chunks: AsyncIterable<Uint8Array>, limits: ReaderLimits): AsyncIterable<ParsedRecord>;
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
  /** One-based line where the record starts, when the reader reports it. */
  readonly line?: number;
}

/** A local file, created with `fileSource()`. It must stay unchanged while a run reads it. */
export interface FileSource {
  readonly path: string;
}

/** Progress of one logical import, kept between runs by a checkpoint store. */
export interface Checkpoint {
  readonly version: 1;
  readonly importId: string;
  readonly transformVersion: string;
  readonly readerId: string;
  /** SHA-256 of the source content. */
  readonly sourceHash: string;
  /** Records the destination has confirmed, counted from the start of the source. */
  readonly processedRecords: number;
  readonly completed: boolean;
}

/** Keeps the checkpoint of one logical import, for example in a local file or in the destination database. */
export interface CheckpointStore {
  /** Resolves to the last saved checkpoint, or `undefined` when none has been saved. */
  load(): Promise<Checkpoint | undefined>;
  /** Resolves once the checkpoint is durable. */
  save(checkpoint: Checkpoint): Promise<void>;
  /** Gives one run exclusive use of the store. Resolves to a function that releases it. */
  lock?(): Promise<() => Promise<void>>;
}

export interface CommitContext {
  /**
   * Progress once this batch is committed. Saved in the same transaction as the records, it prevents the batch from
   * being delivered again if the run stops before ImportKit saves the checkpoint itself.
   */
  readonly checkpoint: Checkpoint;
  readonly signal?: AbortSignal;
}

export interface ImportOptions<T> {
  readonly source: FileSource;
  readonly reader: RecordReader;
  readonly importId: string;
  /** Change when mapping, validation, or destination semantics change. */
  readonly transformVersion: string;
  readonly checkpointStore: CheckpointStore;
  readonly batchSize?: number;
  /** Optional logical byte budget for a batch; requires measureRecordBytes. Not a heap limit. */
  readonly maxBatchBytes?: number;
  /** Synchronous size of the transformed value's intended encoding; requires maxBatchBytes. */
  readonly measureRecordBytes?: (value: T, context: RecordContext) => number;
  readonly limits?: Partial<ImportLimits>;
  readonly signal?: AbortSignal;
  readonly mapRecord: (input: unknown, context: RecordContext) => T | Promise<T>;
  /** Resolve only after durable writes. Replayed IDs must not create duplicate effects. */
  readonly commitBatch: (records: readonly ImportRecord<T>[], context: CommitContext) => Promise<void>;
}

export interface ImportResult {
  readonly status: 'completed';
  readonly resumedFrom: number;
  readonly processedRecords: number;
  readonly committedBatches: number;
  readonly sourceHash: string;
}

export interface ValidationOptions<T> extends Pick<ImportOptions<T>, 'source' | 'reader' | 'importId' | 'transformVersion' | 'mapRecord' | 'limits' | 'signal'> {
  /** Maximum mapping issues retained; all mapping failures are still counted. */
  readonly maxIssues?: number;
}

export interface ValidationIssue {
  readonly code: 'MAP_ERROR';
  readonly recordIndex: number;
  /** One-based line where the record starts, when the reader reports it. */
  readonly line?: number;
  /** Sanitized library message; application exception messages and causes are excluded. */
  readonly message: string;
}

export interface ValidationParseError {
  readonly code: 'PARSE_ERROR';
  /** Sanitized library message; source values are excluded. */
  readonly message: string;
  /** One-based line where the malformed record starts, when the reader reports it. */
  readonly line?: number;
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
  | { readonly status: 'incomplete'; readonly parseError: ValidationParseError }
);
