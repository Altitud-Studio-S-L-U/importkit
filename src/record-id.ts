import { hash } from 'node:crypto';
import type { ImportOptions } from './types.js';

type RecordIdentity = Pick<ImportOptions<unknown>, 'reader' | 'importId' | 'transformVersion'>;

/**
 * Destinations deduplicate replayed records by this ID. Changing its inputs or their encoding would make every
 * replayed record look new, so the derivation is part of the public contract: the SHA-256 of
 * `JSON.stringify([importId, sourceIdentity, readerId, transformVersion, index])`. A file's identity is the SHA-256
 * that 0.3 used in the same position, so IDs of file imports are unchanged.
 *
 * Only the index changes between the records of a run, and a safe integer serializes as its decimal digits, so the
 * serialized array is a constant prefix, the index and `]`. Hashing that concatenation yields the same IDs without
 * serializing the constant parts for every record.
 */
export function recordIds(options: RecordIdentity, sourceIdentity: string): (index: number) => string {
  const constant = JSON.stringify([options.importId, sourceIdentity, options.reader.id, options.transformVersion]);
  const prefix = `${constant.slice(0, -1)},`;
  return (index) => hash('sha256', `${prefix}${index}]`);
}
