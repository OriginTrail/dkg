/** One owner for admission, concurrent preparation, serialized commit and shutdown. */
export class TwoPhaseMutationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<Promise<unknown>>();
  private closing = false;
  private closeTask?: Promise<void>;

  constructor(private readonly closingMessage: string) {}

  run<T>(commit: () => Promise<T>): Promise<T> {
    return this.admit(() => this.enqueue(commit));
  }

  runPrepared<P, T>(prepare: () => Promise<P>, commit: (prepared: P) => Promise<T>): Promise<T> {
    return this.admit(() => prepare().then(prepared => this.enqueue(() => commit(prepared))));
  }

  private admit<T>(start: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error(this.closingMessage));
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
    const task = new Promise<T>((onSuccess, onFailure) => { resolve = onSuccess; reject = onFailure; });
    this.pending.add(task);
    void task.finally(() => { this.pending.delete(task); }).catch(() => undefined);
    try {
      // Start preparation synchronously: callers snapshot mutable input before
      // their first await. Register ownership first: preparation can initiate close.
      void start().then(resolve, reject);
    } catch (error) { reject(error); }
    return task;
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.pending);
    await this.tail;
  }

  close(finalize: () => Promise<void>): Promise<void> {
    if (!this.closeTask) {
      this.closing = true;
      this.closeTask = this.drain().then(finalize);
    }
    return this.closeTask;
  }

  private enqueue<T>(commit: () => Promise<T>): Promise<T> {
    const task = this.tail.then(commit, commit);
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }
}
