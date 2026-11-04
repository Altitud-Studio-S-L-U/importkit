import { createHash } from 'node:crypto';
import type { ImportOptions } from './types.js';

type RecordIdentity = Pick<ImportOptions<unknown>, 'reader' | 'importId' | 'transformVersion'>;

/**
 * Destinations deduplicate replayed records by this ID. Changing its inputs or their encoding would make every
 * replayed record look new, so the derivation is part of the public contract.
 */
export function recordId(options: RecordIdentity, sourceHash: string, index: number): string {
  return createHash('sha256').update(JSON.stringify([
    options.importId, sourceHash, options.reader.id, options.transformVersion, index,
  ])).digest('hex');
}
