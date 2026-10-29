import { AsyncLocalStorage } from 'node:async_hooks';

/** A read plan owns one scheduler slot until every submitted read has settled.
 * Parallel decorator reads are serialized, so the plan never spends its one
 * admission on concurrent transports. Escaped callbacks cannot reuse the slot.
 */
export class QueryReadAdmission<Context> {
  private readonly current = new AsyncLocalStorage<{
    context: Context;
    closed: boolean;
    tail: Promise<unknown>;
  }>();

  get active(): boolean { return this.current.getStore() !== undefined; }

  async run<T>(context: Context, work: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error('Nested query read admission is not supported');
    const owner = { context, closed: false, tail: Promise.resolve() as Promise<unknown> };
    return this.current.run(owner, async () => {
      try {
        const result = await work();
        owner.closed = true;
        await owner.tail;
        return result;
      } catch (error) {
        owner.closed = true;
        // Drain siblings without replacing the callback's classified/wrapped error.
        // If work succeeded, the tail error above remains the primary failure.
        await owner.tail.catch(() => undefined);
        throw error;
      }
    });
  }

  read<T>(work: (context: Context) => Promise<T>): Promise<T> {
    const owner = this.current.getStore();
    if (!owner || owner.closed) return Promise.reject(new Error('Query read admission is closed'));
    const pending = owner.tail.then(() => work(owner.context));
    // Retain the first failure: later work must not dispatch after a failed read.
    owner.tail = pending;
    void pending.catch(() => undefined);
    return pending;
  }
}
