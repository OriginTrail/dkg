import { setTimeout as delay } from 'node:timers/promises';
import {
  isRpcRequestGovernorQueueFullError,
  withRpcRequestContext,
} from '@origintrail-official/dkg-chain';

/** One budget for transaction-free wallet bootstrap, never for runner/job recovery. */
export class PublisherStartupAdmission {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onAbort = () => this.controller.abort(this.parent?.reason);

  constructor(private readonly parent?: AbortSignal) {
    this.timer = setTimeout(() => {
      this.controller.abort(new Error('Publisher wallet bootstrap exceeded its 60000ms budget'));
    }, 60_000);
    this.timer.unref?.();
    if (parent?.aborted) this.onAbort();
    else parent?.addEventListener('abort', this.onAbort, { once: true });
  }

  async readIdentity(read: () => Promise<bigint>): Promise<bigint> {
    const signal = this.controller.signal;
    for (;;) {
      signal.throwIfAborted();
      try {
        const identity = await withRpcRequestContext({ signal }, read);
        signal.throwIfAborted();
        return identity;
      } catch (error) {
        signal.throwIfAborted();
        // Local capacity is process-wide: keep the same adapter/governor and
        // back off. Do not retry remote errors, permanent errors or job work.
        if (!isRpcRequestGovernorQueueFullError(error)) throw error;
        await delay(1_000, undefined, { signal });
      }
    }
  }

  assertActive(): void {
    this.controller.signal.throwIfAborted();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.parent?.removeEventListener('abort', this.onAbort);
    // Do not abort a successful bootstrap: Hub pollers created during init
    // inherit its async context and must remain usable after handoff.
  }
}
