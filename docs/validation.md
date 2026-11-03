# Validation

`validateFile` checks a whole file without writing anything and returns a report that you can log or send back to whoever uploaded the file. This page shows how to define the rules with a schema, what a report contains and how to return it from an HTTP endpoint.

## Define the rules with a schema

Pass any schema that implements [Standard Schema](https://standardschema.dev), such as one built with Zod, Valibot or ArkType. ImportKit does not depend on any of them. Each parsed record is validated against the schema, and every issue points at the field that failed.

```ts
import { z } from 'zod';
import { csvReader, fileSource, validateFile } from '@altitud-studio/importkit';

const orderSchema = z.object({
  orderId: z.string().min(1),
  sku: z.string().regex(/^[A-Z0-9-]+$/u),
  units: z.coerce.number().int().positive(),
});

const report = await validateFile({
  source: fileSource('./uploads/orders.csv'),
  reader: csvReader(),
  importId: 'orders-2026-11',
  transformVersion: 'orders-v1',
  schema: orderSchema,
});
```

CSV values are strings, so the schema converts them, here with `z.coerce.number()`. Pass the same schema, `importId` and `transformVersion` to `importFile`, and `commitBatch` receives the schema's output with its type.

`mapRecord` is optional when there is a schema. When you pass both, the schema runs first and `mapRecord` receives its output. Use it for rules a schema cannot express, such as a lookup in data your service already holds:

```ts
import { z } from 'zod';
import { csvReader, fileCheckpointStore, fileSource, importFile } from '@altitud-studio/importkit';

const orderSchema = z.object({
  orderId: z.string().min(1),
  sku: z.string().min(1),
  units: z.coerce.number().int().positive(),
});
const activeSkus = new Set(['SKU-1', 'SKU-2']);

await importFile({
  source: fileSource('./uploads/orders.csv'),
  reader: csvReader(),
  importId: 'orders-2026-11',
  transformVersion: 'orders-v2',
  checkpointStore: fileCheckpointStore('./checkpoints/orders-2026-11.json'),
  schema: orderSchema,
  mapRecord: (order) => {
    if (!activeSkus.has(order.sku)) throw new Error('Unknown SKU.');
    return order;
  },
  async commitBatch(records) {
    await saveOrders(records);
  },
});
```

The schema is part of your mapping rules: change `transformVersion` whenever it changes.

## Read a report

| Status | Meaning |
| --- | --- |
| `valid` | The whole file parsed, and every record passed the schema and `mapRecord`. |
| `invalid` | The whole file parsed, and at least one record failed. |
| `incomplete` | Parsing stopped at a structural error, so the rest of the file was not checked. |

A report for a CSV file whose second record has `0` units looks like this:

```json
{
  "status": "invalid",
  "sourceHash": "3f1c…",
  "processedRecords": 3,
  "validRecords": 2,
  "invalidRecords": 1,
  "issues": [
    { "code": "SCHEMA_ERROR", "recordIndex": 2, "line": 3, "path": ["units"], "message": "The record does not match the schema." }
  ],
  "issuesTruncated": false
}
```

- **One issue per problem.** A record with two invalid fields produces two issues. `invalidRecords` counts records, `maxIssues` bounds the issues kept (100 by default, 0 to keep only counts), and `issuesTruncated` is `true` when some were left out.
- **`code`** is `SCHEMA_ERROR` when the schema rejected the record and `MAP_ERROR` when `mapRecord` threw.
- **`recordIndex`** is the record's one-based position among the file's records; a CSV header is not a record. **`line`** is the line where the record starts.
- **`path`** lists the keys from the record to the invalid value, such as `["units"]` or `["items", 0, "sku"]`. For a CSV file the first key is a column header. It is absent when the problem concerns the whole record.
- **`parseError`**, present only when the status is `incomplete`, gives the line of the malformed record. Readers buffer input, so records just before that line may not have been checked yet.

## Include schema messages

By default every issue carries the same library message, because a schema's message can quote the value it rejects, and a report is often logged. Pass `includeSchemaMessages: true` to copy each schema message instead:

```ts
import { z } from 'zod';
import { csvReader, fileSource, validateFile } from '@altitud-studio/importkit';

const report = await validateFile({
  source: fileSource('./uploads/orders.csv'),
  reader: csvReader(),
  importId: 'orders-2026-11',
  transformVersion: 'orders-v1',
  schema: z.object({ units: z.coerce.number().int().positive() }),
  includeSchemaMessages: true,
});
```

Turn it on when the report goes back to the person who sent the file, or when the file holds no personal data. Exceptions never reach a report: when `mapRecord` or the schema itself throws, the issue keeps the library message and has no `path`.

## Return a report from an HTTP endpoint

A report is plain JSON. This function maps it to a status code and a response body, independent of your web framework:

```ts
import type { ValidationResult } from '@altitud-studio/importkit';

export function validationResponse(report: ValidationResult) {
  if (report.status === 'valid') {
    return { status: 200, body: { status: 'valid', records: report.processedRecords } };
  }
  return {
    status: 422,
    body: {
      status: report.status,
      invalidRecords: report.invalidRecords,
      issues: report.issues,
      issuesTruncated: report.issuesTruncated,
      ...(report.status === 'incomplete' ? { parseError: report.parseError } : {}),
    },
  };
}
```

## Keep validation and import consistent

For the same file, reader, schema, `mapRecord`, `importId` and `transformVersion`, `validateFile` and `importFile` see the same records with the same IDs, and accept or reject the same ones. `importFile` stops at the first rejected record with `SCHEMA_ERROR` or `MAP_ERROR`; validating first lets you reject the whole file before any batch is written.

`validateFile` treats every exception from `mapRecord` or the schema as an invalid record. Keep network calls out of them: if a dependency is down, cancel the run instead of reporting the file as invalid.

Operational failures, such as invalid options, an unreadable or changed source, an exceeded limit or cancellation, reject with an [`ImportKitError`](api.md#errors) instead of returning a report.
