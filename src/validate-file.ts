import { checkAbort, ImportKitError } from './errors.js';
import { assertSourceState, closeSource, fingerprint, openSource } from './file-source.js';
import { assertValidationOptions } from './options.js';
import { traverseRecords } from './traversal.js';
import type { RecordContext, ValidationIssue, ValidationOptions, ValidationParseError, ValidationResult } from './types.js';

function issue(code: ValidationIssue['code'], context: RecordContext, message: string): ValidationIssue {
  return Object.freeze({
    code, recordIndex: context.index,
    ...(context.line === undefined ? {} : { line: context.line }),
    message,
  });
}

/** Validates an immutable local file without opening a destination or checkpoint. */
export async function validateFile<T>(options: ValidationOptions<T>): Promise<ValidationResult> {
  const { limits, maxIssues } = assertValidationOptions(options);
  checkAbort(options.signal);
  const { handle, state } = await openSource(options.source.path, limits.maxSourceBytes);
  try {
    const sourceHash = await fingerprint(handle, limits, options.signal);
    await assertSourceState(handle, state);
    let validRecords = 0;
    let invalidRecords = 0;
    const issues: ValidationIssue[] = [];
    let incomplete = false;
    let parseErrorLine: number | undefined;
    const traversal = traverseRecords(handle, options, limits, sourceHash);

    try {
      for await (const record of traversal.inputs()) {
        const index = traversal.visit(record);
        const context = traversal.context(index, record);
        try {
          await options.mapRecord(record.value, context);
          validRecords++;
        } catch {
          checkAbort(options.signal);
          invalidRecords++;
          if (issues.length < maxIssues) issues.push(issue('MAP_ERROR', context, 'Record mapping or validation failed.'));
        }
        checkAbort(options.signal);
      }
    } catch (error) {
      checkAbort(options.signal);
      if (error instanceof ImportKitError && error.code !== 'PARSE_ERROR') throw error;
      incomplete = true;
      if (error instanceof ImportKitError) parseErrorLine = error.line;
    }

    checkAbort(options.signal);
    await assertSourceState(handle, state);
    if (!incomplete && traversal.parsedHash() !== sourceHash) {
      throw new ImportKitError('SOURCE_CHANGED', 'The source bytes changed between fingerprinting and parsing.');
    }
    // Some filesystems do not expose a same-size rewrite through an open handle's
    // timestamps immediately. Re-read after mapping rather than trusting metadata.
    if (await fingerprint(handle, limits, options.signal) !== sourceHash) {
      throw new ImportKitError('SOURCE_CHANGED', 'The source bytes changed during validation.');
    }
    await assertSourceState(handle, state);
    const summary = {
      sourceHash, processedRecords: traversal.count(), validRecords, invalidRecords,
      issues: Object.freeze(issues), issuesTruncated: invalidRecords > issues.length,
    };
    if (!incomplete) return { ...summary, status: invalidRecords === 0 ? 'valid' : 'invalid' };
    const parseError: ValidationParseError = Object.freeze({
      code: 'PARSE_ERROR', message: 'The reader could not complete structural parsing.',
      ...(parseErrorLine === undefined ? {} : { line: parseErrorLine }),
    });
    return { ...summary, status: 'incomplete', parseError };
  } finally {
    await closeSource(handle);
  }
}
