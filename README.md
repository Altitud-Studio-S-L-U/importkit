# ImportKit

Resumable, validated CSV and JSON Lines imports for Node.js backends.

[![npm version](https://img.shields.io/npm/v/@altitud-studio/importkit)](https://www.npmjs.com/package/@altitud-studio/importkit)
[![license](https://img.shields.io/npm/l/@altitud-studio/importkit)](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@altitud-studio/importkit)](https://nodejs.org/)

ImportKit imports CSV and JSON Lines files into your backend in bounded batches and records progress after each batch your code confirms. If a run stops halfway, the next run resumes after the last confirmed batch. Each record keeps the same ID across runs, so your destination can skip repeats. Keep progress in the same database transaction as the records, and a resumed run never delivers a committed batch again.

You write two functions: one that validates and converts a record, and one that writes a batch. ImportKit streams the file, enforces size limits, groups records into batches, saves checkpoints and coordinates recovery.

## Install

```sh
npm install @altitud-studio/importkit
```

ImportKit requires Node.js 24 or later and works with both `import` and `require()`. Its only runtime dependency is [`csv-parse`](https://csv.js.org/parse/).

## Import a file

```ts
import { csvReader, fileCheckpointStore, fileSource, importFile } from '@altitud-studio/importkit';

const result = await importFile({
  source: fileSource('./uploads/orders.csv'),
  reader: csvReader(),
  importId: 'orders-2026-11',
  transformVersion: 'orders-v1',
  checkpointStore: fileCheckpointStore('./checkpoints/orders-2026-11.json'),

  // Validate and convert one record. Throwing stops the import.
  mapRecord: (input) => parseOrder(input),

  // Write one batch. Resolve only once the write is durable.
  async commitBatch(records) {
    await saveOrders(records);
  },
});

console.log(`Imported ${result.processedRecords - result.resumedFrom} records in this run.`);
```

`parseOrder` and `saveOrders` stand for your application's code. Each record passed to `commitBatch` is `{ id, index, value }`: `value` is what `mapRecord` returned, `index` is the record's one-based position among the file's records, and `id` is its stable ID.

- `importId` names one logical import, such as one uploaded file. Run again with the same `importId` and checkpoint store to resume.
- `transformVersion` names your mapping rules. Change it when `mapRecord` or the meaning of the destination changes; a saved checkpoint for another version is then rejected instead of mixing both.
- Record IDs derive from `importId`, `transformVersion`, the file's content, the reader and the record's position. They do not depend on the batch size.

## Validate before importing

`validateFile` runs the reader and your rules over the whole file without writing anything, and returns a report you can send back to whoever uploaded the file. Write the rules as a schema from any [Standard Schema](https://standardschema.dev) library, such as Zod, Valibot or ArkType, as a `mapRecord` function, or both.

```ts
import { z } from 'zod';
import { csvReader, fileSource, validateFile } from '@altitud-studio/importkit';

const orderSchema = z.object({
  orderId: z.string().min(1),
  sku: z.string().min(1),
  units: z.coerce.number().int().positive(),
});

const report = await validateFile({
  source: fileSource('./uploads/orders.csv'),
  reader: csvReader(),
  importId: 'orders-2026-11',
  transformVersion: 'orders-v1',
  schema: orderSchema,
});

if (report.status !== 'valid') console.log(report.invalidRecords, report.issues);
```

| Status | Meaning |
| --- | --- |
| `valid` | The whole file parsed, and every record passed. |
| `invalid` | The whole file parsed, and at least one record failed. |
| `incomplete` | Parsing stopped at a structural error, so the rest of the file was not checked. |

Each issue names the record, the line where it starts and the field that failed: `{ code: 'SCHEMA_ERROR', recordIndex: 2, line: 3, path: ['units'], message: 'The record does not match the schema.' }`. A report never contains record values or the messages of your exceptions, and contains schema messages only if you ask for them. Pass the same schema to `importFile`, and `commitBatch` receives the validated, typed values. [Validation in detail](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/docs/validation.md)

## When a run fails

ImportKit saves a checkpoint after each batch that `commitBatch` confirms. The next run of the same import skips the confirmed records and continues with the rest.

A run can stop after your destination wrote a batch but before the checkpoint was saved. The next run then delivers that batch again, with the same record IDs. Delivery is therefore at least once: make the writes idempotent, for example with a unique constraint on the record ID, or keep the checkpoint in your database as the next section shows.

[Recovery in detail](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/docs/recovery.md)

## Keep progress in your database

A checkpoint store is any object with `load()` and `save()`. `commitBatch` receives the checkpoint that describes progress once its batch is committed. Write it in the same transaction as the records, return it from `load()`, and a committed batch is never delivered again.

```ts
import { csvReader, fileSource, importFile } from '@altitud-studio/importkit';
import type { CheckpointStore } from '@altitud-studio/importkit';

const importId = 'orders-2026-11';

const checkpointStore: CheckpointStore = {
  load: () => db.checkpoints.find(importId),
  save: (checkpoint) => db.checkpoints.upsert(importId, checkpoint),
};

await importFile({
  source: fileSource('./uploads/orders.csv'),
  reader: csvReader(),
  importId,
  transformVersion: 'orders-v1',
  checkpointStore,
  mapRecord: (input) => parseOrder(input),
  async commitBatch(records, { checkpoint }) {
    await db.transaction(async (tx) => {
      await tx.orders.insertMany(records);
      await tx.checkpoints.upsert(importId, checkpoint);
    });
  },
});
```

`db` stands for your database client. The [transactional example](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/examples/transactional.mjs) runs this pattern against SQLite and simulates a lost acknowledgment.

## Limits

| Option | Default | What it bounds |
| --- | --- | --- |
| `batchSize` | 500 | Records per `commitBatch` call, from 1 to 10,000. |
| `concurrency` | 1 | Batches committed at the same time, from 1 to 16. |
| `maxBatchBytes` | Not set | Measured bytes per batch. Requires `measureRecordBytes`. |
| `limits.maxSourceBytes` | 1 GiB | Size of the source file. |
| `limits.maxRecordBytes` | 1 MiB | Serialized size of one record, including its line terminator. |
| `limits.maxRecords` | 10,000,000 | Records in the source. |

The readers check `maxRecordBytes` while decoding, so an oversized record fails before it is buffered in full. [Limits in detail](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/docs/limits.md)

## Is ImportKit a good fit?

Use it when:

- your backend receives CSV or JSON Lines files large enough for a deploy, a crash or a timeout to interrupt the import;
- you want to report invalid records before writing anything;
- memory has to stay bounded whatever the size of the file.

Consider something else when:

- the file fits comfortably in one database transaction: load it inside that transaction;
- the data is XLSX, XML or a single large JSON array: convert it first, or [write a reader](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/docs/readers.md#write-your-own-reader);
- the work needs joins or aggregations across records: an ETL tool or the database itself fits better.

## Examples

```sh
git clone https://github.com/Altitud-Studio-S-L-U/importkit.git
cd importkit
npm ci
npm run demo
```

| Script | What it shows | Expected result |
| --- | --- | --- |
| `npm run demo:validation` | A report with invalid records, a truncated issue list and an incomplete parse. | Four numbered steps, each one verified. |
| `npm run demo:recovery` | A lost acknowledgment after a SQLite commit, with a checkpoint file. | 7 deliveries, 5 stored records, 2 deduplicated replays. |
| `npm run demo:transactional` | The same failure, with the checkpoint in the orders database. | 5 deliveries, 5 stored records, no replays. |

The demos use synthetic data. The two recovery demos use Node's built-in `node:sqlite`, which some Node.js versions report as experimental.

## Documentation

- [API reference](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/docs/api.md): every option, result, type and error code.
- [Validation](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/docs/validation.md): schemas, reports and HTTP responses.
- [Recovery](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/docs/recovery.md): the checkpoint contract, custom stores, locks and concurrent runs.
- [Readers](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/docs/readers.md): CSV, JSON Lines and your own formats.
- [Limits](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/docs/limits.md): resource limits and batches bounded by measured bytes.
- [Performance](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/docs/performance.md): time and space costs, and measurements with 1 GB and 10 GB files.
- [Changelog](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/CHANGELOG.md)

## Contributing and security

[CONTRIBUTING.md](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/CONTRIBUTING.md) explains how to propose a change. To report a vulnerability, follow [SECURITY.md](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/SECURITY.md).

## License

[MIT](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/LICENSE). Built by [Altitud Studio](https://altitudstudio.ad/en/).
