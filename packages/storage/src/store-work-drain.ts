/** Nonserializing ownership of accepted work and one synchronous close gate. */
export class StoreWorkDrain {
  private readonly accepted = new Set<Promise<unknown>>();
  private closing = false;
  private stopped?: Promise<void>;

  constructor(private readonly closingMessage: string) {}

  run<T>(start: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error(this.closingMessage));
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
    const task = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    this.accepted.add(task);
    void task.then(() => this.accepted.delete(task), () => this.accepted.delete(task));
    // Own reentrant close before synchronously snapshotting mutable caller input.
    try { void start().then(resolve, reject); } catch (error) { reject(error); }
    return task;
  }

  async drain(): Promise<void> { await Promise.allSettled(this.accepted); }

  close(finalize: () => Promise<void>): Promise<void> {
    if (!this.stopped) {
      this.closing = true;
      this.stopped = this.drain().then(finalize);
    }
    return this.stopped;
  }
}
