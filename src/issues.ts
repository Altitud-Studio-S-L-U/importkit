import type { StandardSchemaV1Issue } from './standard-schema.js';
import type { RejectedRecord } from './transform.js';
import type { RecordContext, ValidationIssue } from './types.js';

const sanitizedMessages = {
  SCHEMA_ERROR: 'The record does not match the schema.',
  MAP_ERROR: 'Record mapping or validation failed.',
} as const;

/** Standard Schema paths can hold path segment objects and symbols; reports hold JSON keys. */
function issuePath(path: StandardSchemaV1Issue['path']): readonly (string | number)[] | undefined {
  if (path === undefined || path.length === 0) return undefined;
  return Object.freeze(path.map((segment) => {
    const key = typeof segment === 'object' ? segment.key : segment;
    return typeof key === 'symbol' ? key.toString() : key;
  }));
}

/** Keeps the first `maxIssues` issues of a validation and counts every one. */
export class IssueCollector {
  readonly #maxIssues: number;
  readonly #includeSchemaMessages: boolean;
  readonly #issues: ValidationIssue[] = [];
  #count = 0;

  constructor(maxIssues: number, includeSchemaMessages: boolean) {
    this.#maxIssues = maxIssues;
    this.#includeSchemaMessages = includeSchemaMessages;
  }

  /** Adds one issue per schema issue, or one for a record whose schema or mapRecord threw. */
  add(rejected: RejectedRecord, context: RecordContext): void {
    const schemaIssues = rejected.issues !== undefined && rejected.issues.length > 0 ? rejected.issues : [undefined];
    for (const schemaIssue of schemaIssues) {
      this.#count++;
      if (this.#issues.length === this.#maxIssues) continue;
      const path = issuePath(schemaIssue?.path);
      this.#issues.push(Object.freeze({
        code: rejected.code,
        recordIndex: context.index,
        ...(context.line === undefined ? {} : { line: context.line }),
        ...(path === undefined ? {} : { path }),
        message: schemaIssue !== undefined && this.#includeSchemaMessages ? String(schemaIssue.message) : sanitizedMessages[rejected.code],
      }));
    }
  }

  issues(): readonly ValidationIssue[] {
    return Object.freeze(this.#issues.slice());
  }

  /** Whether more issues occurred than were kept. */
  truncated(): boolean {
    return this.#count > this.#issues.length;
  }
}
