# Sources

A source supplies the bytes of a run. `fileSource(path)` reads a local file, `httpSource(url)` reads one over HTTP, and any object that implements `ByteSource` can supply bytes from other storage. This page describes what ImportKit expects from a source and how to write one.

## Read a local file

```ts
import { fileSource } from '@altitud-studio/importkit';

const source = fileSource('./uploads/orders.csv');
```

- The path must name a regular file that exists when the run starts and stays unchanged until it ends. Copy an upload to a location your application owns before importing it.
- Each run reads the whole file once to compute its SHA-256, which becomes the source's identity, and then reads it again to parse it. A validation reads it a third time at the end, so that its report describes the file as it still is. A difference between the reads, or a change to the file's size or timestamps during the run, fails it with `SOURCE_CHANGED`.
- Validate and authorize the path before passing it: ImportKit is not a path sandbox.

## Read a file over HTTP

```ts
import { csvReader, fileCheckpointStore, httpSource, importFile } from '@altitud-studio/importkit';

await importFile({
  source: httpSource('https://exports.example.com/orders/2026-11.csv', {
    headers: { authorization: `Bearer ${process.env.EXPORTS_TOKEN}` },
  }),
  reader: csvReader(),
  importId: 'orders-2026-11',
  transformVersion: 'orders-v1',
  checkpointStore: fileCheckpointStore('./checkpoints/orders-2026-11.json'),
  mapRecord: (input) => parseOrder(input),
  async commitBatch(records) {
    await saveOrders(records);
  },
});
```

Each run sends one `GET` request with your headers and reads the body once, without a fingerprint pass. Object stores such as Amazon S3, Google Cloud Storage, Cloudflare R2 and Azure Blob Storage work through presigned URLs, without their SDKs.

- **The response must prove what it is.** ImportKit requires status 200, a strong `ETag`, a `Content-Length` within `maxSourceBytes` and no `Content-Encoding`, and sends `Accept-Encoding: identity` to ask for that. Any other response fails with `SOURCE_ERROR`, or `LIMIT_EXCEEDED` for its size, before a record is read.
- **The ETag is the identity.** The checkpoint stores `etag:` followed by the ETag. A resumed run downloads the content again from the first byte and continues only if the server returns the same ETag; a new version fails with `CHECKPOINT_MISMATCH`. The URL is not part of the identity, so a freshly presigned URL resumes the same import.
- **The ETag must change with the content.** Object stores guarantee it. A server that derives ETags from the modification time and the size can keep an ETag across an edit of the same size, and is not a suitable source.
- **Redirects are refused.** Pass the final URL: following a redirect could send your headers to another host.
- **Errors stay free of secrets.** Messages never include the URL or the headers. The `cause` of a network failure can name the host.
- **Bound the time.** A stalled server waits for the Node.js default timeouts. Pass a `signal` such as `AbortSignal.timeout(600_000)` to bound a run.

ImportKit fetches the URL you give it. If any part of the URL comes from a user, check it against the hosts your service is meant to reach first.

## How ImportKit uses a source

```ts
interface ByteSource {
  open(context: SourceContext): Promise<OpenedSource>;
}

interface SourceContext {
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

interface OpenedSource {
  readonly identity: string;
  readonly size: number;
  readonly sha256?: string;
  bytes(): AsyncIterable<Uint8Array>;
  assertUnchanged?(): Promise<void>;
  close?(): Promise<void>;
}
```

Each run calls `open()` once, reads `bytes()` once from the first byte, and calls `close()` once, however the run ends. `maxBytes` is the run's `maxSourceBytes`, and `signal` is the run's signal.

- **`identity`** names this version of the content in at most 512 characters, such as its SHA-256 or a strong ETag. It must change whenever the content changes: the checkpoint stores it and record IDs derive from it, so a run that finds a checkpoint with another identity fails with `CHECKPOINT_MISMATCH` instead of skipping records.
- **`size`** is the length of the content in bytes. ImportKit rejects a size above `maxSourceBytes` before reading, counts the bytes it reads, and fails with `SOURCE_CHANGED` when there are more or fewer.
- **`sha256`**, when the source knows it before reading, is checked against the bytes ImportKit reads.
- **`assertUnchanged()`**, when present, runs before every batch and at the end of the run. It should stay cheap and reject with an `ImportKitError` whose code is `SOURCE_CHANGED` when the content has visibly changed.

ImportKit validates what `open()` returns: an invalid shape fails with `INVALID_OPTIONS`, and a source's own failures become `SOURCE_ERROR` with the original error as `cause`, unless they already are an `ImportKitError`. For every source, `sourceHash` in the result is the SHA-256 of the bytes ImportKit read.

## Write your own source

This source serves content already held in memory, such as a small upload or test data:

```ts
import { createHash } from 'node:crypto';
import { ImportKitError } from '@altitud-studio/importkit';
import type { ByteSource } from '@altitud-studio/importkit';

export function bufferSource(content: Uint8Array): ByteSource {
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    async open({ maxBytes }) {
      if (content.byteLength > maxBytes) throw new ImportKitError('LIMIT_EXCEEDED', 'The source exceeds maxSourceBytes.');
      return {
        identity: sha256,
        size: content.byteLength,
        sha256,
        async *bytes() {
          yield content;
        },
      };
    },
  };
}
```

A source that reads remote storage can take its identity from the storage's version metadata, such as an object's ETag or generation number, instead of hashing the content first. It must then make sure that `bytes()` yields exactly that version, for example with a conditional request, and release its connections in `close()`.
