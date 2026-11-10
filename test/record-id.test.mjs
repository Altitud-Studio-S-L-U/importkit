import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { recordIds } from '../dist/record-id.js';

const reference = (importId, sourceIdentity, readerId, transformVersion, index) => createHash('sha256')
  .update(JSON.stringify([importId, sourceIdentity, readerId, transformVersion, index])).digest('hex');

test('record IDs equal the SHA-256 of the serialized identity array for any text and safe index', () => {
  const texts = ['orders-2026-11', '', 'quote " and backslash \\', 'line\nbreak\ttab', 'ñandú 東京 🚀', '\u2028\u2029', 'a'.repeat(512)];
  const indexes = [1, 2, 9, 10, 99, 1000, 2 ** 31, 2 ** 32 + 1, Number.MAX_SAFE_INTEGER];
  for (const importId of texts) {
    for (const transformVersion of [...texts, undefined]) {
      const options = { importId, reader: { id: 'csv:v1:utf8-header:2c' }, transformVersion };
      const idOf = recordIds(options, 'f'.repeat(64));
      for (const index of indexes) {
        assert.equal(idOf(index), reference(importId, 'f'.repeat(64), options.reader.id, transformVersion, index));
      }
    }
  }
});
