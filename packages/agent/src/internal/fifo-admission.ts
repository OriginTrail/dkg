// SPDX-License-Identifier: Apache-2.0

export interface FIFOAdmissionEvent {
  stage: 'queued' | 'acquired' | 'cancelled' | 'released';
  waitMs: number;
  workMs: number;
  active: number;
  queued: number;
}

type Observer = (event: FIFOAdmissionEvent) => void;
type Waiter = { grant(reserved?: boolean): void; cancel(): void };

/** Each FIFO instance owns physical work settlement and an independent capacity budget. */
export class FIFOAdmission {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly limit: () => number, private readonly now = () => performance.now(),
    private readonly cancelledMessage = 'FIFO admission cancelled') {}

  async run<T>(work: () => Promise<T>, signal?: AbortSignal, observe?: Observer): Promise<T> {
    signal?.throwIfAborted();
    const queuedAt = this.now();
    let acquiredAt = queuedAt;
    const emit = (stage: FIFOAdmissionEvent['stage']) => {
      // Diagnostics must never change admission, work, or release behavior.
      try { observe?.({ stage, waitMs: Math.max(0, (stage === 'queued' || stage === 'cancelled' ? this.now() : acquiredAt) - queuedAt),
        workMs: stage === 'released' ? Math.max(0, this.now() - acquiredAt) : 0,
        active: this.active, queued: this.queue.length }); } catch { /* observer is best effort */ }
    };
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: (reserved = false) => {
          signal?.removeEventListener('abort', waiter.cancel);
          if (!reserved) this.active++;
          acquiredAt = this.now();
          emit('acquired');
          resolve();
        },
        cancel: () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal?.removeEventListener('abort', waiter.cancel);
          emit('cancelled');
          reject(signal?.reason ?? new Error(this.cancelledMessage));
        },
      };
      if (this.active < this.limit()) {
        // Reserve before observing queue entry: an observer can re-enter run().
        this.active++;
        emit('queued');
        waiter.grant(true);
      } else {
        this.queue.push(waiter);
        signal?.addEventListener('abort', waiter.cancel, { once: true });
        emit('queued');
      }
    });
    try {
      signal?.throwIfAborted();
      const result = await work();
      signal?.throwIfAborted();
      return result;
    } finally {
      this.active--;
      // Transfer before notifying observers, which may synchronously re-enter.
      this.queue.shift()?.grant();
      emit('released');
    }
  }
}
