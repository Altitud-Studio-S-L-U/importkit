import { checkAbort, ImportKitError } from './errors.js';
import type { StandardSchemaV1Issue, StandardSchemaV1Result } from './standard-schema.js';
import type { ImportOptions, RecordContext } from './types.js';

type TransformOptions<I, T> = Pick<ImportOptions<I, T>, 'schema' | 'mapRecord' | 'signal'>;
type Mapper<I, T> = (input: I, context: RecordContext) => Promise<T | RejectedRecord>;

/** A record that failed its schema or mapRecord. Imports throw it as an ImportKitError; validation reports it. */
export class RejectedRecord {
  readonly code: 'SCHEMA_ERROR' | 'MAP_ERROR';
  /** The schema's issues, when it returned them instead of throwing. */
  readonly issues: readonly StandardSchemaV1Issue[] | undefined;
  readonly cause: unknown;

  constructor(code: 'SCHEMA_ERROR' | 'MAP_ERROR', issues: readonly StandardSchemaV1Issue[] | undefined, cause: unknown) {
    this.code = code;
    this.issues = issues;
    this.cause = cause;
  }

  toError(context: RecordContext): ImportKitError {
    const message = this.code === 'SCHEMA_ERROR' ? 'The record does not match the schema.' : 'Record mapping or validation failed.';
    return new ImportKitError(this.code, message, { cause: this.cause, recordIndex: context.index, line: context.line });
  }
}

export type RecordTransform<T> = (input: unknown, context: RecordContext) => Promise<T | RejectedRecord>;

function mapper<I, T>(mapRecord: (input: I, context: RecordContext) => T | Promise<T>, signal: AbortSignal | undefined): Mapper<I, T> {
  return async (input, context) => {
    try {
      return await mapRecord(input, context);
    } catch (error) {
      checkAbort(signal);
      return new RejectedRecord('MAP_ERROR', undefined, error);
    }
  };
}

/** Applies the schema, then mapRecord, to each parsed value. The shapes of both options must already be validated. */
export function recordTransform<I, T>({ schema, mapRecord, signal }: TransformOptions<I, T>): RecordTransform<T> {
  const map = mapRecord === undefined ? undefined : mapper(mapRecord, signal);
  if (schema === undefined) {
    if (map === undefined) throw new ImportKitError('INVALID_OPTIONS', 'mapRecord or schema is required.');
    // Without a schema, mapRecord receives the parsed value, typed as unknown.
    return map as RecordTransform<T>;
  }

  const standard = schema['~standard'];
  return async (input, context) => {
    let result: StandardSchemaV1Result<I>;
    try {
      result = await standard.validate(input);
    } catch (error) {
      checkAbort(signal);
      return new RejectedRecord('SCHEMA_ERROR', undefined, error);
    }
    if (result.issues !== undefined) return new RejectedRecord('SCHEMA_ERROR', result.issues, result);
    // Without mapRecord, the record's value is the schema's output, and T defaults to that type.
    return map === undefined ? result.value as unknown as T : map(result.value, context);
  };
}
