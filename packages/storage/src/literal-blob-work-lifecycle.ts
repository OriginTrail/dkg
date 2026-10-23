/** Own logical work through hydration/preparation without serializing disk I/O. */
export class LiteralBlobWorkLifecycle {
  private readonly accepted = new Set<Promise<unknown>>();
  private closing = false;
  private stopped?: Promise<void>;

  run<T>(start: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Literal blob store is closing'));
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
    const task = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    this.accepted.add(task);
    void task.then(() => this.accepted.delete(task), () => this.accepted.delete(task));
    // Snapshot mutable caller input synchronously, after owning any reentrant close.
    try { void start().then(resolve, reject); } catch (error) { reject(error); }
    return task;
  }

  close(finalize: () => Promise<void>): Promise<void> {
    if (!this.stopped) {
      this.closing = true;
      this.stopped = Promise.allSettled(this.accepted).then(finalize);
    }
    return this.stopped;
  }
}
