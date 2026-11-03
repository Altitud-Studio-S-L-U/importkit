import type { Checkpoint, CommitContext, ImportProgress, ImportRecord } from './types.js';

/** Progress once a batch, and every batch before it, is confirmed. */
export interface BatchEnd {
  readonly checkpoint: Checkpoint;
  /** Source bytes the reader had consumed when the batch was formed. */
  readonly bytesRead: number;
}

interface Confirmed extends BatchEnd {
  readonly committedBatches: number;
}

export interface CommitQueueOptions<T> {
  readonly concurrency: number;
  readonly signal: AbortSignal | undefined;
  /** The checkpoint the run starts from, already saved. */
  readonly start: Checkpoint;
  readonly totalBytes: number;
  readonly commit: (records: readonly ImportRecord<T>[], context: CommitContext) => Promise<void>;
  readonly save: (checkpoint: Checkpoint) => Promise<void>;
  readonly progress: ((progress: ImportProgress) => Promise<void>) | undefined;
}

/**
 * Runs up to `concurrency` destination batches at a time and saves progress in source order: the checkpoint only
 * advances over batches whose predecessors are all confirmed. A batch holds its slot until its progress is saved, so
 * with a concurrency of 1 each batch is committed and saved before the next one is formed.
 */
export class CommitQueue<T> {
  readonly #options: CommitQueueOptions<T>;
  readonly #running = new Set<Promise<void>>();
  /** Confirmed batches that wait for an earlier batch, by sequence number. */
  readonly #waiting = new Map<number, BatchEnd>();
  #nextBatch = 0;
  #nextToConfirm = 0;
  #confirmed: Confirmed;
  #saved: Checkpoint;
  #saving: Promise<void> = Promise.resolve();
  #failure: { readonly error: unknown } | undefined;

  constructor(options: CommitQueueOptions<T>) {
    this.#options = options;
    this.#confirmed = { checkpoint: options.start, bytesRead: 0, committedBatches: 0 };
    this.#saved = options.start;
  }

  /** Batches confirmed, in order, during this run. */
  get committedBatches(): number {
    return this.#confirmed.committedBatches;
  }

  /** Starts committing a nonempty batch, then waits while every slot is busy. Throws the first failure of the run. */
  async submit(records: readonly ImportRecord<T>[], end: BatchEnd): Promise<void> {
    this.#throwFailure();
    const sequence = this.#nextBatch++;
    // The batch's own progress may be committed with it only when every earlier batch is already confirmed.
    const checkpoint = sequence === this.#nextToConfirm ? end.checkpoint : this.#confirmed.checkpoint;
    const { signal } = this.#options;
    const context: CommitContext = Object.freeze(signal === undefined ? { checkpoint } : { checkpoint, signal });
    const task = this.#run(sequence, records, end, context);
    this.#running.add(task);
    void task.then(() => this.#running.delete(task));
    while (this.#running.size >= this.#options.concurrency) await Promise.race(this.#running);
    this.#throwFailure();
  }

  /** Waits for every started batch and the saves it triggers. Failures are kept for `complete()`, not thrown. */
  async settle(): Promise<void> {
    await Promise.all(this.#running);
    await this.#saving;
  }

  /** Waits for every batch, then saves a completed checkpoint unless the last batch saved one. */
  async complete(processedRecords: number, bytesRead: number): Promise<void> {
    await this.settle();
    this.#throwFailure();
    if (this.#saved.completed) return;
    const checkpoint = Object.freeze({ ...this.#confirmed.checkpoint, processedRecords, completed: true });
    this.#confirmed = { ...this.#confirmed, checkpoint, bytesRead };
    this.#scheduleSave();
    await this.#saving;
    this.#throwFailure();
  }

  async #run(sequence: number, records: readonly ImportRecord<T>[], end: BatchEnd, context: CommitContext): Promise<void> {
    try {
      await this.#options.commit(records, context);
    } catch (error) {
      this.#fail(error);
      return;
    }
    this.#waiting.set(sequence, end);
    for (let next = this.#waiting.get(this.#nextToConfirm); next !== undefined; next = this.#waiting.get(this.#nextToConfirm)) {
      this.#waiting.delete(this.#nextToConfirm++);
      this.#confirmed = { ...next, committedBatches: this.#confirmed.committedBatches + 1 };
    }
    this.#scheduleSave();
    await this.#saving;
  }

  /** Saves run one at a time, each for the latest confirmed progress, so the saved checkpoint never moves back. */
  #scheduleSave(): void {
    this.#saving = this.#saving.then(async () => {
      const confirmed = this.#confirmed;
      if (confirmed.checkpoint === this.#saved) return;
      try {
        await this.#options.save(confirmed.checkpoint);
        this.#saved = confirmed.checkpoint;
        await this.#options.progress?.({
          processedRecords: confirmed.checkpoint.processedRecords,
          committedBatches: confirmed.committedBatches,
          bytesRead: confirmed.bytesRead,
          totalBytes: this.#options.totalBytes,
        });
      } catch (error) {
        this.#fail(error);
      }
    });
  }

  #fail(error: unknown): void {
    this.#failure ??= { error };
  }

  #throwFailure(): void {
    if (this.#failure !== undefined) throw this.#failure.error;
  }
}
