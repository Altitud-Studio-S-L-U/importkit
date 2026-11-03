/**
 * Maps byte offsets of a stream to one-based line numbers by counting LF bytes, so CRLF and LF files are numbered
 * as editors show them. It retains only the bytes between the last offset looked up and the end of the stream.
 */
export class LineCounter {
  readonly #pending: Buffer[] = [];
  #pendingOffset = 0;
  #counted = 0;
  #lines = 0;

  /** Adds the next bytes of the stream. Offsets inside them can be looked up afterwards. */
  append(bytes: Uint8Array): void {
    if (bytes.byteLength > 0) this.#pending.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  /** The line of the byte at `offset`. Offsets must not decrease between calls. */
  lineAt(offset: number): number {
    while (this.#counted < offset) {
      const bytes = this.#pending[0];
      if (bytes === undefined) break;
      const end = Math.min(bytes.byteLength, this.#pendingOffset + offset - this.#counted);
      for (let index = bytes.indexOf(10, this.#pendingOffset); index !== -1 && index < end; index = bytes.indexOf(10, index + 1)) {
        this.#lines++;
      }
      this.#counted += end - this.#pendingOffset;
      if (end === bytes.byteLength) {
        this.#pending.shift();
        this.#pendingOffset = 0;
      } else {
        this.#pendingOffset = end;
      }
    }
    return this.#lines + 1;
  }
}
