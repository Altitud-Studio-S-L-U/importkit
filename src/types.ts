import type { StandardSchemaV1 } from './standard-schema.js';

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

/** Where the bytes of a run come from. `fileSource()` and `httpSource()` create one; other storage can implement it. */
export interface ByteSource {
  /** Opens the content for one run. ImportKit closes what it returns when the run ends. */
  open(context: SourceContext): Promise<OpenedSource>;
}

export interface SourceContext {
  /** The run's maxSourceBytes. A larger source should fail with LIMIT_EXCEEDED before its content is read. */
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

/** One version of a source's content, opened for one run. */
export interface OpenedSource {
  /**
   * Names this version of the content, such as its SHA-256 or a strong ETag, in at most 512 characters. It must change
   * whenever the content changes: record IDs and checkpoints derive from it.
   */
  readonly identity: string;
  /** Size of the content in bytes. */
  readonly size: number;
  /** SHA-256 of the content in lowercase hexadecimal, when it is known before reading. ImportKit checks the bytes against it. */
  readonly sha256?: string;
  /** Yields the content once, from its first byte. */
  bytes(): AsyncIterable<Uint8Array>;
  /** Rejects with SOURCE_CHANGED when the content has visibly changed. Called before each batch and when a run ends. */
  assertUnchanged?(): Promise<void>;
  /** Releases what open() acquired. Called once, however the run ends. */
  close?(): Promise<void>;
}

/** A local file, created with `fileSource()`. It must stay unchanged while a run reads it. */
export interface FileSource extends ByteSource {
  readonly path: string;
}

/** Progress of one logical import, kept between runs by a checkpoint store. */
export interface Checkpoint {
  readonly version: 2;
  readonly importId: string;
  readonly transformVersion: string;
  readonly readerId: string;
  /** The source's identity: the SHA-256 of a file's content, or the strong ETag of an HTTP response. */
  readonly sourceIdentity: string;
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
   * Progress once this batch is committed, or, when an earlier batch is still in flight, the progress already
   * confirmed. Saved in the same transaction as the records, it prevents the batch from being delivered again if the
   * run stops before ImportKit saves the checkpoint itself.
   */
  readonly checkpoint: Checkpoint;
  readonly signal?: AbortSignal;
}

/** Progress reported after each checkpoint save. */
export interface ImportProgress {
  /** Records the destination has confirmed, counted from the start of the source: the saved checkpoint. */
  readonly processedRecords: number;
  /** Batches committed during this run. */
  readonly committedBatches: number;
  /** Source bytes read when the last confirmed batch was formed. Readers buffer, so it can run slightly ahead. */
  readonly bytesRead: number;
  /** Size of the source in bytes. */
  readonly totalBytes: number;
}

/**
 * `I` is the type `mapRecord` receives: the schema's output, or `unknown` without a schema. `T` is the type of the
 * values that reach the destination: what `mapRecord` returns, or the schema's output without `mapRecord`.
 */
export interface ImportOptions<I = unknown, T = I> {
  /** Where the content comes from, such as `fileSource(path)` or `httpSource(url)`. */
  readonly source: ByteSource;
  readonly reader: RecordReader;
  readonly importId: string;
  /** Change when the schema, mapping or destination semantics change. */
  readonly transformVersion: string;
  readonly checkpointStore: CheckpointStore;
  readonly batchSize?: number;
  /** Optional logical byte budget for a batch; requires measureRecordBytes. Not a heap limit. */
  readonly maxBatchBytes?: number;
  /** Synchronous size of the transformed value's intended encoding; requires maxBatchBytes. */
  readonly measureRecordBytes?: (value: T, context: RecordContext) => number;
  /** Batches committed at the same time, from 1 to 16. Batches can then finish in any order. Default: 1. */
  readonly concurrency?: number;
  readonly limits?: Partial<ImportLimits>;
  readonly signal?: AbortSignal;
  /** Called after each checkpoint save. Throwing stops the run with PROGRESS_ERROR. */
  readonly onProgress?: (progress: ImportProgress) => void | Promise<void>;
  /** Validates and types each parsed value before mapRecord. Any Standard Schema v1 implementation works. */
  readonly schema?: StandardSchemaV1<unknown, I>;
  /** Converts a parsed value, or the schema's output when there is a schema. Required without a schema. */
  readonly mapRecord?: (input: I, context: RecordContext) => T | Promise<T>;
  /** Resolve only after durable writes. Replayed IDs must not create duplicate effects. */
  readonly commitBatch: (records: readonly ImportRecord<T>[], context: CommitContext) => Promise<void>;
}

export interface ImportResult {
  readonly status: 'completed';
  readonly resumedFrom: number;
  readonly processedRecords: number;
  readonly committedBatches: number;
  /** SHA-256 of the source content. */
  readonly sourceHash: string;
}

export interface ValidationOptions<I = unknown, T = I>
  extends Pick<ImportOptions<I, T>, 'source' | 'reader' | 'importId' | 'transformVersion' | 'schema' | 'mapRecord' | 'limits' | 'signal'> {
  /** Maximum issues retained; every failure is still counted. */
  readonly maxIssues?: number;
  /** Copies the schema's own messages into issues. They can quote record values, so they are left out by default. */
  readonly includeSchemaMessages?: boolean;
}

export interface ValidationIssue {
  readonly code: 'SCHEMA_ERROR' | 'MAP_ERROR';
  readonly recordIndex: number;
  /** One-based line where the record starts, when the reader reports it. */
  readonly line?: number;
  /** Keys and array indexes from the record to the invalid value, when the schema reports them. */
  readonly path?: readonly (string | number)[];
  /** Sanitized library message, unless includeSchemaMessages copies the schema's message. */
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
  /** SHA-256 of the source content. */
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
