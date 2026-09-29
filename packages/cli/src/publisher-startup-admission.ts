import { setTimeout as delay } from 'node:timers/promises';
import {
  isRpcRequestGovernorQueueFullError,
  withRpcRequestContext,
} from '@origintrail-official/dkg-chain';

/** Bounds RPC inactivity during wallet bootstrap, never runner/job recovery. */
export class PublisherStartupAdmission {
  private readonly controller = new AbortController();
  private readonly onAbort = () => this.controller.abort(this.parent?.reason);

  constructor(private readonly parent?: AbortSignal) {
    if (parent?.aborted) this.onAbort();
    else parent?.addEventListener('abort', this.onAbort, { once: true });
  }

  async readIdentity(read: () => Promise<bigint>): Promise<bigint> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    let active = true;
    const timer = setTimeout(() => {
      this.controller.abort(new Error('Publisher wallet bootstrap made no RPC progress for 60000ms'));
    }, 60_000);
    timer.unref?.();
    const onProgress = () => {
      if (active && !signal.aborted) timer.refresh();
    };
    try {
      for (;;) {
        signal.throwIfAborted();
        try {
          const identity = await withRpcRequestContext({ signal, onProgress }, read);
          signal.throwIfAborted();
          return identity;
        } catch (error) {
          signal.throwIfAborted();
          // Refusal/backoff never refreshes the inactivity clock. Successful
          // issuer RPCs may, so healthy throttled/serial wallets have no total cap.
          if (!isRpcRequestGovernorQueueFullError(error)) throw error;
          await delay(1_000, undefined, { signal });
        }
      }
    } finally {
      active = false;
      clearTimeout(timer);
    }
  }

  assertActive(): void {
    this.controller.signal.throwIfAborted();
  }

  dispose(): void {
    this.parent?.removeEventListener('abort', this.onAbort);
    // Adapter-owned background work has its own context and teardown owner.
    this.controller.abort(new Error('Publisher wallet bootstrap disposed'));
  }
}
