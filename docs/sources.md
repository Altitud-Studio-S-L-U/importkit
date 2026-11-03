# Sources

A source supplies the bytes of a run. `fileSource(path)` reads a local file, and any object that implements `ByteSource` can supply bytes from other storage. This page describes what ImportKit expects from a source and how to write one.

## Read a local file

```ts
import { fileSource } from '@altitud-studio/importkit';

const source = fileSource('./uploads/orders.csv');
```

- The path must name a regular file that exists when the run starts and stays unchanged until it ends. Copy an upload to a location your application owns before importing it.
- Each run reads the whole file once to compute its SHA-256, which becomes the source's identity, and then reads it again to parse it. A validation reads it a third time at the end, so that its report describes the file as it still is. A difference between the reads, or a change to the file's size or timestamps during the run, fails it with `SOURCE_CHANGED`.
- Validate and authorize the path before passing it: ImportKit is not a path sandbox.

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
