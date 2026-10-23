/** One owner for admission, concurrent preparation, serialized commit and shutdown. */
import { StoreWorkDrain } from './store-work-drain.js';

export class TwoPhaseMutationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly work: StoreWorkDrain;

  constructor(closingMessage: string) { this.work = new StoreWorkDrain(closingMessage); }

  run<T>(commit: () => Promise<T>): Promise<T> {
    return this.work.run(() => this.enqueue(commit));
  }

  runConcurrent<T>(work: () => Promise<T>): Promise<T> {
    return this.work.run(work);
  }

  runPrepared<P, T>(prepare: () => Promise<P>, commit: (prepared: P) => Promise<T>): Promise<T> {
    return this.work.run(() => prepare().then(prepared => this.enqueue(() => commit(prepared))));
  }

  async drain(): Promise<void> {
    await this.work.drain();
    await this.tail;
  }

  close(finalize: () => Promise<void>): Promise<void> {
    return this.work.close(async () => { await this.tail; await finalize(); });
  }

  private enqueue<T>(commit: () => Promise<T>): Promise<T> {
    const task = this.tail.then(commit, commit);
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }
}
