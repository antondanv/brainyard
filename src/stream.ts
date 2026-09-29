/**
 * A replayable async stream: every iterator starts from the first item, so a
 * consumer that subscribes late (or twice) sees the whole run, not a tail.
 */
export class EventStream<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  #closed = false;
  #failure: { error: unknown } | undefined;
  #waiters: (() => void)[] = [];

  /** Everything pushed so far. */
  get items(): readonly T[] {
    return this.#items;
  }

  get closed(): boolean {
    return this.#closed;
  }

  push(item: T): void {
    if (this.#closed) return;
    this.#items.push(item);
    this.#wake();
  }

  /** No more items. Iterators finish after draining what was pushed. */
  end(): void {
    this.#closed = true;
    this.#wake();
  }

  /** Iterators throw `error` after draining what was pushed. */
  fail(error: unknown): void {
    if (this.#closed) return;
    this.#failure = { error };
    this.end();
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    let index = 0;
    let finished = false;
    return {
      next: async (): Promise<IteratorResult<T>> => {
        for (;;) {
          if (finished) return { value: undefined, done: true };
          if (index < this.#items.length) {
            return { value: this.#items[index++] as T, done: false };
          }
          if (this.#closed) {
            if (this.#failure) throw this.#failure.error;
            return { value: undefined, done: true };
          }
          await new Promise<void>((wake) => this.#waiters.push(wake));
        }
      },
      return: async (): Promise<IteratorResult<T>> => {
        finished = true;
        this.#wake();
        return { value: undefined, done: true };
      },
    };
  }
}
