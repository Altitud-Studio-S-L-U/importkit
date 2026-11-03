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

- An import of a file reads about `2N` bytes: one pass to fingerprint it, and one to parse it while hashing it again.
- A validation of a file also reads `2N`. After a structural error it reads the rest of the file without parsing it, so the second hash still covers every byte.
- Validating and then importing therefore reads `4N`. File system caches make the passes cheaper, but they remain separate reads. A custom source whose identity needs no fingerprint, such as one based on an ETag, is read once per run.
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

The JSON report lists the Node.js version, the platform, the number of logical cores, input and output bytes, the source hash, record and batch counts, the time of each phase, sampled resident memory and heap use, and the process's peak resident memory. Generating the input is excluded from the timings, and validation runs before the import in the same process without clearing file system caches. Memory samples are observations, not the absolute peak.

Every benchmark report leaves out the CPU model, the memory size, the kernel version, the host name and local paths, so it can be published as it is.

## Commit batches concurrently

When the destination's latency dominates each batch, `concurrency` multiplies throughput. The [throughput benchmark](https://github.com/Altitud-Studio-S-L-U/importkit/blob/main/benchmarks/throughput.mjs) imports 20,000 synthetic JSON Lines records in 200 batches of 100 into a destination that waits a fixed time per batch, once for each `concurrency` of 1, 2, 4 and 8. It keeps checkpoints in memory, so that file system flushes do not mask the effect.

```sh
npm run benchmark:throughput -- 20
```

The argument is the destination's wait per batch, from 1 to 1,000 milliseconds. The criterion, set before measuring, requires four batches in flight to import at least three times as many records per second as one, and the script exits with a failure status when it is not met.

### Results for ImportKit 1.0.0

Three runs on Node.js 24.11.1, Windows x64 with 16 logical cores, with a wait of 20 ms per batch. At a concurrency of 1 each batch took about 30 ms: the wait rounds up to the resolution of Windows timers, and parsing, mapping and checkpoints add the rest.

| `concurrency` | Records per second | Speedup over 1 |
| ---: | ---: | ---: |
| 1 | 3,243–3,337 | 1 |
| 2 | 6,418–6,644 | 1.95–1.99 |
| 4 | 12,494–13,184 | 3.76–3.95 |
| 8 | 24,005–25,043 | 7.22–7.72 |

Every run met the criterion. The figures show how throughput scales when the destination only waits; a real database also limits concurrency through its connections, locks and disk.

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
