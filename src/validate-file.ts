import { createHash } from 'node:crypto';
import { ImportKitError } from './errors.js';
import { assertFileOptions, assertSourceState, checkAbort, fingerprint, openSource, recordId, sourceBytes } from './file-source.js';
import type { ValidationIssue, ValidationOptions, ValidationResult } from './types.js';

/** Validates an immutable local file without opening a destination or checkpoint. */
export async function validateFile<T>(options: ValidationOptions<T>): Promise<ValidationResult> {
  const limits = assertFileOptions(options);
  const maxIssues = options.maxIssues ?? 100;
  if (!Number.isSafeInteger(maxIssues) || maxIssues < 0 || maxIssues > 10_000) {
    throw new ImportKitError('INVALID_OPTIONS', 'maxIssues must be an integer from 0 through 10,000.');
  }
  checkAbort(options.signal);
  const { handle, state } = await openSource(options.source.path, limits.maxSourceBytes);
  try {
    const sourceHash = await fingerprint(handle, limits, options.signal);
    await assertSourceState(handle, state);
    let processedRecords = 0;
    let validRecords = 0;
    let invalidRecords = 0;
    const issues: ValidationIssue[] = [];
    let incomplete = false;
    const parsedHash = createHash('sha256');
    async function* verifiedBytes(): AsyncIterable<Uint8Array> {
      for await (const chunk of sourceBytes(handle, limits.maxSourceBytes, options.signal)) {
        parsedHash.update(chunk);
        yield chunk;
      }
    }

    try {
      for await (const input of options.source.reader.read(verifiedBytes(), limits)) {
        checkAbort(options.signal);
        processedRecords++;
        if (processedRecords > limits.maxRecords) {
          throw new ImportKitError('LIMIT_EXCEEDED', 'The source exceeds maxRecords.', { recordIndex: processedRecords });
        }
        const id = recordId(options, sourceHash, processedRecords);
        try {
          await options.mapRecord(input, { id, index: processedRecords });
          validRecords++;
        } catch {
          checkAbort(options.signal);
          invalidRecords++;
          if (issues.length < maxIssues) {
            issues.push(Object.freeze({ code: 'MAP_ERROR', recordIndex: processedRecords, message: 'Record mapping or validation failed.' }));
          }
        }
        checkAbort(options.signal);
      }
    } catch (error) {
      checkAbort(options.signal);
      if (error instanceof ImportKitError && error.code !== 'PARSE_ERROR') throw error;
      incomplete = true;
    }

    checkAbort(options.signal);
    await assertSourceState(handle, state);
    if (!incomplete && parsedHash.digest('hex') !== sourceHash) {
      throw new ImportKitError('SOURCE_CHANGED', 'The source bytes changed between fingerprinting and parsing.');
    }
    // Some filesystems do not expose a same-size rewrite through an open handle's
    // timestamps immediately. Re-read after mapping rather than trusting metadata.
    if (await fingerprint(handle, limits, options.signal) !== sourceHash) {
      throw new ImportKitError('SOURCE_CHANGED', 'The source bytes changed during validation.');
    }
    await assertSourceState(handle, state);
    const summary = {
      sourceHash, processedRecords, validRecords, invalidRecords,
      issues: Object.freeze(issues), issuesTruncated: invalidRecords > issues.length,
    };
    return incomplete
      ? { ...summary, status: 'incomplete', parseError: Object.freeze({ code: 'PARSE_ERROR', message: 'The reader could not complete structural parsing.' }) }
      : { ...summary, status: invalidRecords === 0 ? 'valid' : 'invalid' };
  } finally {
    await handle.close();
  }
}
