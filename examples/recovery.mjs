import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { csvReader, fileSource, importFile, ImportKitError } from '../dist/index.js';

const exampleDirectory = dirname(fileURLToPath(import.meta.url));
const scratchRoot = join(exampleDirectory, '..', '.tmp');
await mkdir(scratchRoot, { recursive: true });
const scratchDirectory = await mkdtemp(join(scratchRoot, 'recovery-'));
const db = new DatabaseSync(join(scratchDirectory, 'orders.sqlite'));

try {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE imported_orders (
      record_id TEXT PRIMARY KEY,
      source_row INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      sku TEXT NOT NULL,
      units INTEGER NOT NULL CHECK (units > 0)
    );
  `);

  const insert = db.prepare(`
    INSERT INTO imported_orders (record_id, source_row, order_id, sku, units)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (record_id) DO NOTHING
  `);
  let loseFirstAcknowledgment = true;
  let deliveryAttempts = 0;
  let insertedRecords = 0;

  const options = {
    source: fileSource(join(exampleDirectory, 'data', 'orders.csv')),
    reader: csvReader(),
    importId: 'fictional-orders-demo',
    transformVersion: 'orders-v1',
    checkpointPath: join(scratchDirectory, 'orders.checkpoint.json'),
    batchSize: 2,
    mapRecord(input) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Expected an order record.');
      }
      const { order_id: orderId, sku, units: rawUnits } = input;
      const units = Number(rawUnits);
      if (typeof orderId !== 'string' || !orderId.startsWith('DEMO-')
        || typeof sku !== 'string' || sku.length === 0
        || !Number.isSafeInteger(units) || units <= 0) {
        throw new Error('Invalid fictional order.');
      }
      return { orderId, sku, units };
    },
    async commitBatch(records) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const record of records) {
          deliveryAttempts++;
          const result = insert.run(
            record.id,
            record.index,
            record.value.orderId,
            record.value.sku,
            record.value.units,
          );
          insertedRecords += Number(result.changes);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }

      // Persistence succeeded, but the caller did not receive an acknowledgment.
      if (loseFirstAcknowledgment) {
        loseFirstAcknowledgment = false;
        throw new Error('Simulated failure after the durable database commit.');
      }
    },
  };

  console.log('ImportKit recovery demo · synthetic data');
  await assert.rejects(importFile(options), (error) => {
    assert.ok(error instanceof ImportKitError);
    assert.equal(error.code, 'COMMIT_ERROR');
    return true;
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM imported_orders').get().count, 2);
  console.log('1. Database committed two records; acknowledgment was deliberately lost.');

  // Stable record IDs do not depend on batch size.
  const result = await importFile({ ...options, batchSize: 3 });
  const storedRecords = db.prepare('SELECT COUNT(*) AS count FROM imported_orders').get().count;
  assert.equal(result.status, 'completed');
  assert.equal(storedRecords, 5);
  assert.equal(deliveryAttempts, 7);
  assert.equal(insertedRecords, 5);

  console.log('2. The next run replayed the uncheckpointed records and completed.');
  console.log(`3. ${deliveryAttempts} delivery attempts, ${storedRecords} stored records, ${deliveryAttempts - insertedRecords} deduplicated replays.`);
  console.log('Recovery verified. Destination idempotency prevented duplicate effects.');
} finally {
  db.close();
  await rm(scratchDirectory, { recursive: true, force: true });
}
