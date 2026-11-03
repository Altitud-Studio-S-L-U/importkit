import type { ImportRecord } from './types.js';

/** Pending destination records, bounded by a record count and an optional measured byte budget. */
export class BatchBuilder<T> {
  readonly #maxRecords: number;
  readonly #maxBytes: number | undefined;
  #records: ImportRecord<T>[] = [];
  #bytes = 0;

  constructor(maxRecords: number, maxBytes: number | undefined) {
    this.#maxRecords = maxRecords;
    this.#maxBytes = maxBytes;
  }

  get size(): number {
    return this.#records.length;
  }

  /** Whether the pending records must be committed before a record of `bytes` can join the batch. */
  mustCommitBefore(bytes: number): boolean {
    // Compare with the remaining budget: the sum of two safe integers can exceed Number.MAX_SAFE_INTEGER.
    return this.#maxBytes !== undefined && this.#records.length > 0 && bytes > this.#maxBytes - this.#bytes;
  }

  add(record: ImportRecord<T>, bytes: number): void {
    this.#records.push(record);
    this.#bytes += bytes;
  }

  /** Reaching either limit exactly commits the batch without reading another record. */
  isFull(): boolean {
    return this.#records.length === this.#maxRecords || (this.#maxBytes !== undefined && this.#bytes === this.#maxBytes);
  }

  /** A frozen copy, so destination code cannot change the pending batch. */
  records(): readonly ImportRecord<T>[] {
    return Object.freeze(this.#records.slice());
  }

  clear(): void {
    this.#records = [];
    this.#bytes = 0;
  }
}
