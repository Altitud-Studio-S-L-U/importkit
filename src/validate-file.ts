import { checkAbort, ImportKitError, withCleanup } from './errors.js';
import { IssueCollector } from './issues.js';
import { assertValidationOptions } from './options.js';
import type { ValidationSettings } from './options.js';
import { openSource } from './sources/source.js';
import type { GuardedSource } from './sources/source.js';
import { RejectedRecord } from './transform.js';
import { traverseRecords } from './traversal.js';
import type { ValidationOptions, ValidationParseError, ValidationResult } from './types.js';

/** Validates an unchanging source without opening a destination or checkpoint. */
export async function validateFile<I = unknown, T = I>(options: ValidationOptions<I, T>): Promise<ValidationResult> {
  const settings = assertValidationOptions(options);
  checkAbort(options.signal);
  const source = await openSource(options.source, settings.limits, options.signal);
  return withCleanup(() => validateOpenSource(options, settings, source), source.close);
}

async function validateOpenSource<I, T>(
  options: ValidationOptions<I, T>,
  { limits, transform, maxIssues, includeSchemaMessages }: ValidationSettings<T>,
  source: GuardedSource,
): Promise<ValidationResult> {
  let validRecords = 0;
  let invalidRecords = 0;
  const issues = new IssueCollector(maxIssues, includeSchemaMessages);
  let incomplete = false;
  let parseErrorLine: number | undefined;
  const traversal = traverseRecords(source, options, limits);

  await withCleanup(async () => {
    try {
      for await (const record of traversal.inputs()) {
        const index = traversal.visit(record);
        const context = traversal.context(index, record);
        const result = await transform(record.value, context);
        if (result instanceof RejectedRecord) {
          invalidRecords++;
          issues.add(result, context);
        } else {
          validRecords++;
        }
        checkAbort(options.signal);
      }
    } catch (error) {
      checkAbort(options.signal);
      if (error instanceof ImportKitError && error.code !== 'PARSE_ERROR') throw error;
      incomplete = true;
      if (error instanceof ImportKitError) parseErrorLine = error.line;
    }
    // Read what the reader left, so that the hash covers every byte even after a structural error.
    await traversal.drain();
  }, traversal.close);

  checkAbort(options.signal);
  const sourceHash = traversal.contentHash();
  if (source.sha256 !== undefined && sourceHash !== source.sha256) {
    throw new ImportKitError('SOURCE_CHANGED', 'The source bytes changed between fingerprinting and parsing.');
  }
  // A report describes the content as it still is, however long the callbacks took.
  await source.assertContentUnchanged();
  const summary = {
    sourceHash, processedRecords: traversal.count(), validRecords, invalidRecords,
    issues: issues.issues(), issuesTruncated: issues.truncated(),
  };
  if (!incomplete) return { ...summary, status: invalidRecords === 0 ? 'valid' : 'invalid' };
  const parseError: ValidationParseError = Object.freeze({
    code: 'PARSE_ERROR', message: 'The reader could not complete structural parsing.',
    ...(parseErrorLine === undefined ? {} : { line: parseErrorLine }),
  });
  return { ...summary, status: 'incomplete', parseError };
}
