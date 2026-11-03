# Readers

A reader decodes the bytes of a source into records. ImportKit includes readers for CSV and JSON Lines, and accepts any object that implements `RecordReader`.

## CSV

```ts
import { csvReader } from '@altitud-studio/importkit';

const commaSeparated = csvReader();
const semicolonSeparated = csvReader({ delimiter: ';' });
```

`csvReader` uses the maintained [`csv-parse`](https://csv.js.org/parse/) parser.

- The first row holds the headers. Every following row becomes an object keyed by header, with string values; your `mapRecord` converts and validates them.
- Quoted fields, line breaks inside quoted fields, UTF-8, a byte order mark and CRLF line endings are supported.
- Every row must have as many fields as the header. Empty, duplicate or reserved headers (`__proto__`, `prototype`, `constructor`) are rejected, and records are created without a prototype.
- The delimiter is one ASCII character other than a quote, CR, LF or NUL.
- `maxRecordBytes` counts serialized bytes, including delimiters, quotes and the line terminator, and also applies to the header row.

## JSON Lines

```ts
import { jsonlReader } from '@altitud-studio/importkit';

const reader = jsonlReader();
```

Each line holds one JSON value: an object, an array, a string, a number, a boolean or `null`.

- UTF-8, a byte order mark at the start of the file, CRLF line endings and a last line without a line break are supported.
- Blank lines, malformed JSON and invalid UTF-8 are rejected.
- This reader handles JSON Lines (also called NDJSON), not a file holding one large JSON array.

## Write your own reader

```ts
interface RecordReader {
  readonly id: string;
  read(chunks: AsyncIterable<Uint8Array>, limits: ReaderLimits): AsyncIterable<unknown>;
}
```

`read` receives the source's bytes and yields one value per record. A reader must:

- **Be deterministic.** The same bytes must always produce the same records in the same order. Record IDs and checkpoints rely on it.
- **Identify its rules in `id`.** Include a version and every option that changes the output, as in `csv:v1:utf8-header:3b` for a semicolon-separated CSV reader. Changing `id` changes every record ID and makes existing checkpoints refuse to resume.
- **Enforce `limits.maxRecordBytes` while decoding.** Fail with an `ImportKitError` whose code is `LIMIT_EXCEEDED` before buffering an oversized record.
- **Clean up when iteration stops early.** ImportKit stops reading at the first failure; release parsers, streams and timers in a `finally` block.

Throw an `ImportKitError` with an operational code, such as `SOURCE_ERROR`, to report a problem that is not the file's fault. Any other exception is treated as a structural error in the file: `PARSE_ERROR` from `importFile`, an incomplete report from `validateFile`. Keep raw input out of error messages; they may be logged.
