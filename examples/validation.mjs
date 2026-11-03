import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvReader, validateFile } from '../dist/index.js';

const exampleDirectory = dirname(fileURLToPath(import.meta.url));
const scratchRoot = join(exampleDirectory, '..', '.tmp');
await mkdir(scratchRoot, { recursive: true });
const scratchDirectory = await mkdtemp(join(scratchRoot, 'validation-'));
const sourcePath = join(scratchDirectory, 'orders.csv');

try {
  const header = 'order_id,sku,units\n';
  await writeFile(sourcePath, `${header}DEMO-001,SKU-A,2\nDEMO-002,SKU-B,0\nDEMO-003,SKU-C,-1\nDEMO-004,SKU-D,3\n`);
  const options = {
    source: { path: sourcePath, reader: csvReader() },
    importId: 'fictional-order-validation',
    transformVersion: 'orders-v1',
    maxIssues: 1,
    mapRecord(input) {
      const units = Number(input.units);
      if (!Number.isSafeInteger(units) || units < 1) throw new Error('Synthetic order must have positive units.');
      return { orderId: input.order_id, sku: input.sku, units };
    },
  };

  console.log('ImportKit validation demo · synthetic data');
  const invalid = await validateFile(options);
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.processedRecords, 4);
  assert.equal(invalid.validRecords, 2);
  assert.equal(invalid.invalidRecords, 2);
  assert.equal(invalid.issues.length, 1);
  assert.equal(invalid.issues[0].recordIndex, 2);
  assert.equal(invalid.issuesTruncated, true);
  assert.deepEqual(await readdir(scratchDirectory), ['orders.csv']);
  console.log('1. Four records checked: two valid, two invalid; one issue retained by maxIssues.');
  console.log('2. No destination or checkpoint was opened. Callback error text is not exposed.');

  await writeFile(sourcePath, `${header}DEMO-001,SKU-A,2\nDEMO-002,"unterminated`);
  const incomplete = await validateFile(options);
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(incomplete.parseError.code, 'PARSE_ERROR');
  console.log('3. A malformed CSV stops traversal and returns an incomplete report.');

  await writeFile(sourcePath, `${header}DEMO-001,SKU-A,2\nDEMO-002,SKU-B,1\n`);
  const valid = await validateFile(options);
  assert.equal(valid.status, 'valid');
  assert.equal(valid.validRecords, 2);
  assert.deepEqual(await readdir(scratchDirectory), ['orders.csv']);
  console.log('4. Corrected input validates successfully. Importing remains a separate decision.');
} finally {
  await rm(scratchDirectory, { recursive: true, force: true });
}
