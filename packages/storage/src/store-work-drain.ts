interface WorkGeneration {
  readonly accepted: Set<Promise<unknown>>;
  closing?: Promise<void>;
}
const newGeneration = (): WorkGeneration => ({ accepted: new Set() });

/** Nonserializing admission; successful close ends one reusable lifetime. */
export class StoreWorkDrain {
  private generation = newGeneration();

  constructor(private readonly closingMessage: string) {}

  run<T>(start: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    if (generation.closing) return Promise.reject(new Error(this.closingMessage));
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason: unknown) => void;
    const task = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    generation.accepted.add(task);
    void task.then(() => generation.accepted.delete(task), () => generation.accepted.delete(task));
    // Own reentrant close before synchronously snapshotting mutable caller input.
    try { void start().then(resolve, reject); } catch (error) { reject(error); }
    return task;
  }

  async drain(): Promise<void> { await Promise.allSettled(this.generation.accepted); }

  close(finalize: () => Promise<void>, beforeDrain?: () => Promise<void>): Promise<void> {
    const generation = this.generation;
    if (!generation.closing) {
      const draining = Promise.allSettled(generation.accepted);
      // The gate is installed before this optional cancellation phase can run.
      const beginning = beforeDrain ? Promise.resolve().then(beforeDrain) : Promise.resolve();
      generation.closing = Promise.allSettled([draining, beginning]).then(async () => {
        // Cleanup follows all accepted work even when early shutdown failed.
        await finalize();
        await beginning;
        // Old cleanup never changes a subsequent lifetime; failed close stays fenced.
        if (this.generation === generation) this.generation = newGeneration();
      });
    }
    return generation.closing;
  }
}
