# Performance

This page states what an import costs in time, reads and memory with the included readers, and how those costs were measured on large files. Custom readers and your callbacks can have different costs.

## Time

| Symbol | Meaning |
| --- | --- |
| `N` | Source bytes. |
| `R` | Parsed records. |
| `B` | Nonempty batches committed in a run. |
| `b` | The `batchSize` record limit. |
| `c` | The `concurrency` limit on batches in flight. |
| `K` | The optional `maxBatchBytes` limit. |
| `S` | The largest serialized record, bounded by `maxRecordBytes`. |
| `H` | CSV columns. Header bytes are also bounded by `S`. |
| `I` | Issues kept in a validation report. |

| Operation | Cost |
| --- | --- |
| Import | `O(N + R + H + B)`, plus the cost of every `mapRecord`, `measureRecordBytes` and `commitBatch` call and of every checkpoint save. |
| Validation | `O(N + R + H + I)`, plus the cost of every `mapRecord` call. |

These bounds assume decoding linear in the input. Callbacks, database work and file system flushes are not constant-time.

## Reads

- An import reads about `2N` bytes: one pass to fingerprint the source, and one to parse it while hashing it again.
- A validation reads `3N`: fingerprint, parse, and a final fingerprint after the callbacks. The final pass catches edits of the same size even where file timestamps lag. A structural error still costs both full fingerprints.
- Validating and then importing therefore reads `5N`. File system caches make the passes cheaper, but they remain separate reads.
- Resuming parses the whole source again. It skips mapping and delivery for confirmed records, but the reads do not shrink with the remaining work.
- A checkpoint holds fixed metadata of at most 16 KiB, never a list of records. A successful run saves it `B + O(1)` times.

## Space

ImportKit keeps the pending batch, the reader's state and at most `I` validation issues. It never accumulates the `R` records of the file. When mapped values are about as large as their measured size, the extra memory grows as `O(S + H + c·b + I)` plus the values of the batches held, where `c` is `concurrency`: up to `c` batches are in flight at once.

- CSV can take more memory than its byte size suggests: many short or empty fields still allocate one string and one object entry per column.
- Deciding whether the next record fits can hold the pending batch and one more record of up to `K` measured bytes, so measured payload can approach `2K`.
- `maxBatchBytes` bounds memory only to the extent that your measurement reflects what the values occupy. Arbitrary objects, shared buffers or inaccurate measurements do not bound the heap, and an oversized value already exists in memory when it is rejected.
- No bound here limits the process's resident memory. V8 allocation and garbage collection, native buffers, allocator fragmentation and your callbacks all add to it. Measurements describe one workload on one machine, not a ceiling.

## Measure a synthetic workload

```sh
npm run benchmark -- 100000 1000
```

The arguments are the number of records, from 100,000 to 10,000,000, and the batch size, from 1 to 10,000. The [benchmark script](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/benchmarks/import.mjs) generates deterministic JSON Lines, validates them, then imports them into a local JSON Lines file with an `fsync` per batch and real checkpoints. It measures a fresh run; its destination does not deduplicate replays, which the recovery demos cover instead.

The JSON report lists the Node.js version, the platform, input and output bytes, the source hash, record and batch counts, the time of each phase, sampled resident memory and heap use, and the process's peak resident memory. Generating the input is excluded from the timings, and validation runs before the import in the same process without clearing file system caches. Memory samples are observations, not the absolute peak.

## Import 1 GB and 10 GB files

The [large-file runner](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/benchmarks/large-files.mjs) generates synthetic CSV or JSON Lines files of an exact size and runs each phase in a fresh Node.js process. File sizes are decimal (1 GB is 1,000,000,000 bytes); memory figures use MiB (1,048,576 bytes).

```sh
npm run build
node benchmarks/large-files.mjs --format jsonl --bytes 1000000000 --mode both --work-dir /var/tmp/importkit-bench --require-cgroup
node benchmarks/large-files.mjs --format jsonl --bytes 10000000000 --mode import --work-dir /var/tmp/importkit-bench --require-cgroup
```

The first command validates and imports 1 GB; the second imports 10 GB. Use `--format csv` for CSV. The runner sets `maxSourceBytes` to the generated size without changing the library's default. Other options: `--row-bytes`, `--batch-size`, `--max-batch-bytes`, `--max-records`, `--sample-ms`, `--rss-budget-mib`, `--heap-budget-mib` and `--slow-ms`.

`--require-cgroup` refuses to run unless a Linux cgroup memory limit is in place, so an unconstrained run is never reported as memory-capped. With a systemd user manager, this runs the 1 GB case in a fresh 512 MiB cgroup with swap disabled:

```sh
systemd-run --user --wait --pipe --collect --quiet \
  -p MemoryMax=536870912 -p MemorySwapMax=0 \
  "$(command -v node)" --max-old-space-size=64 \
  "$PWD/benchmarks/large-files.mjs" --format jsonl --bytes 1000000000 \
  --mode both --work-dir "$PWD/.tmp" --require-cgroup > report.json
```

The runner's destination checks record count, order and a digest in memory, while the import saves real checkpoints. It does not write to a database or measure database throughput. Progress goes to standard error, so standard output can be kept as evidence.

### Results for ImportKit 0.3.0

Measured with ImportKit 0.3.0 on Node.js 24.11.1, Linux x64 under WSL2, with synthetic records of about 4 KiB, batches of at most 1 measured MiB, and a 512 MiB cgroup without swap.

| Format | Source bytes | Imported records | Importer peak resident memory |
| --- | ---: | ---: | ---: |
| CSV | 1,000,000,000 | 244,141 | 81.91 MiB |
| CSV | 10,000,000,000 | 2,441,407 | 85.39 MiB |
| JSON Lines | 1,000,000,000 | 244,141 | 88.18 MiB |
| JSON Lines | 10,000,000,000 | 2,441,407 | 81.86 MiB |

The acceptance criterion, set before measuring, allowed at most 64 MiB more peak memory at 10 GB than at 1 GB for the same format; both formats met it. Every source size, record order, value, count, digest and batch limit was verified, and no process ran out of memory. The 1 GB cases also completed a separate validation phase.

These are single observations per case, with up to two cases overlapping and file system caches left intact. They do not establish a throughput or memory guarantee; the cgroup's own peak also includes the coordinating process and the file cache. The [0.3.0 release](https://github.com/Altitud-Studio-S-L-U/importkit/releases/tag/v0.3.0) holds the raw reports, the criteria, the analysis and a memory chart.
