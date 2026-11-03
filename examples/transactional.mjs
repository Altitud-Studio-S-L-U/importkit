import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { csvReader, fileSource, importFile, ImportKitError } from '../dist/index.js';

const exampleDirectory = dirname(fileURLToPath(import.meta.url));
const scratchRoot = join(exampleDirectory, '..', '.tmp');
await mkdir(scratchRoot, { recursive: true });
const scratchDirectory = await mkdtemp(join(scratchRoot, 'transactional-'));
const db = new DatabaseSync(join(scratchDirectory, 'orders.sqlite'));
const importId = 'fictional-orders-transactional-demo';

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
    CREATE TABLE import_checkpoints (
      import_id TEXT PRIMARY KEY,
      checkpoint TEXT NOT NULL
    );
  `);

  // A plain INSERT: a replayed record would violate the primary key and fail the batch.
  const insertOrder = db.prepare(`
    INSERT INTO imported_orders (record_id, source_row, order_id, sku, units)
    VALUES (?, ?, ?, ?, ?)
  `);
  const upsertCheckpoint = db.prepare(`
    INSERT INTO import_checkpoints (import_id, checkpoint) VALUES (?, ?)
    ON CONFLICT (import_id) DO UPDATE SET checkpoint = excluded.checkpoint
  `);
  const selectCheckpoint = db.prepare('SELECT checkpoint FROM import_checkpoints WHERE import_id = ?');
  const storedOrders = () => db.prepare('SELECT COUNT(*) AS count FROM imported_orders').get().count;

  let loseFirstAcknowledgment = true;
  let deliveryAttempts = 0;

  const options = {
    source: fileSource(join(exampleDirectory, 'data', 'orders.csv')),
    reader: csvReader(),
    importId,
    transformVersion: 'orders-v1',
    batchSize: 2,
    // Progress lives in the same database as the orders.
    checkpointStore: {
      async load() {
        const row = selectCheckpoint.get(importId);
        return row === undefined ? undefined : JSON.parse(row.checkpoint);
      },
      async save(checkpoint) {
        upsertCheckpoint.run(importId, JSON.stringify(checkpoint));
      },
    },
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
    async commitBatch(records, { checkpoint }) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const record of records) {
          deliveryAttempts++;
          insertOrder.run(record.id, record.index, record.value.orderId, record.value.sku, record.value.units);
        }
        upsertCheckpoint.run(importId, JSON.stringify(checkpoint));
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

  console.log('ImportKit transactional checkpoint demo · synthetic data');
  await assert.rejects(importFile(options), (error) => {
    assert.ok(error instanceof ImportKitError);
    assert.equal(error.code, 'COMMIT_ERROR');
    return true;
  });
  assert.equal(storedOrders(), 2);
  console.log('1. The first batch and its checkpoint committed together; the acknowledgment was lost.');

  const result = await importFile(options);
  assert.equal(result.status, 'completed');
  assert.equal(result.resumedFrom, 2);
  assert.equal(storedOrders(), 5);
  assert.equal(deliveryAttempts, 5);

  console.log('2. The next run resumed after the committed batch.');
  console.log(`3. ${deliveryAttempts} delivery attempts, ${storedOrders()} stored records, ${deliveryAttempts - storedOrders()} replays.`);
  console.log('Recovery verified. The checkpoint shared the transaction of its records.');
} finally {
  db.close();
  await rm(scratchDirectory, { recursive: true, force: true });
}
