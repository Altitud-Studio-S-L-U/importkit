# Limits

ImportKit bounds the size of the source, of each record and of each batch. The limits protect your service from oversized or hostile files; they are not a cap on process memory.

## Resource limits

| Option | Default | Meaning |
| --- | --- | --- |
| `batchSize` | 500 | Records per `commitBatch` call, from 1 to 10,000. |
| `maxBatchBytes` | Not set | Sum of measured record sizes per batch. Requires `measureRecordBytes`. |
| `limits.maxSourceBytes` | 1,073,741,824 (1 GiB) | Size of the source file. |
| `limits.maxRecordBytes` | 1,048,576 (1 MiB) | Serialized UTF-8 bytes of one record, including its line terminator. |
| `limits.maxRecords` | 10,000,000 | Records in the source, including records skipped on resume. |

```ts
const limits = {
  maxSourceBytes: 100_000_000,
  maxRecordBytes: 100_000,
  maxRecords: 1_000_000,
};
```

Every limit must be a positive safe integer.

- The readers enforce `maxRecordBytes` while decoding. For CSV it also applies to the header row, and delimiters, quotes, a byte order mark and line terminators count toward a record's size.
- The source limits do not bound mapped values, which can be larger than their input. `mapRecord`, `measureRecordBytes` and `commitBatch` must bound their own allocations and work.
- ImportKit sends one batch at a time and waits for `commitBatch` before reading further, so a slow destination slows reading down instead of filling memory.

## Bound a batch by measured bytes

By default only `batchSize` decides when a batch is committed. To also bound batches by size, pass both `maxBatchBytes` and `measureRecordBytes`. The count limit keeps applying.

```ts
import { csvReader, fileCheckpointStore, fileSource, importFile } from '@altitud-studio/importkit';

await importFile({
  source: fileSource('./uploads/orders.csv'),
  reader: csvReader(),
  importId: 'orders-2026-11',
  transformVersion: 'encoded-orders-v1',
  checkpointStore: fileCheckpointStore('./checkpoints/orders-2026-11.json'),
  batchSize: 500,
  maxBatchBytes: 4 * 1024 * 1024,
  mapRecord: (input) => `${JSON.stringify(parseOrder(input))}\n`,
  measureRecordBytes: (value) => Buffer.byteLength(value, 'utf8'),
  async commitBatch(records) {
    await saveEncodedOrders(records);
  },
});
```

Here each record is encoded as one line of JSON, and its measured size is the length of that line in UTF-8, newline included. The measurement covers only what you measure: it does not include database, request or batch overhead, and ImportKit never serializes values on your behalf.

`measureRecordBytes` receives the mapped value and `{ id, index }`, once for each record mapped in a run.

- It must return a nonnegative safe integer synchronously; zero is allowed.
- Exceptions, negative or fractional numbers, `NaN`, infinities and promises fail the run with `MEASURE_ERROR` and the record's index.
- It should be deterministic and free of side effects, because a later run can map and measure the same records again.

The batch then behaves as follows:

- If the next record would exceed the remaining budget, the current batch is committed first, and the record starts a new batch.
- Reaching either limit exactly commits the batch at once.
- A single record measured above `maxBatchBytes` fails with `LIMIT_EXCEEDED` before the pending batch is committed. Batches committed earlier stay committed.
- The checkpoint always covers the last record of the committed batch, even when the next record was already mapped to decide that the batch was full.

Batch limits change how records are grouped, not their IDs or the checkpoint format, so they can change between runs of the same import.

Keep each mapped value unchanged until its batch is committed. ImportKit holds the values you return without copying them, so reusing one mutable object or buffer for several records would change values that were already measured.

`maxBatchBytes` limits the sizes you report, not the V8 heap or the process's resident memory, and a value is mapped and measured before an oversized one can be rejected. [Performance](performance.md#space) explains what bounds memory in practice.
