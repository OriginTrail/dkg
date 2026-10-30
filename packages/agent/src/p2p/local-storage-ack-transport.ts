import { runBoundedOperation } from '../bounded-operation.js';
import type { LocalStorageACKExecution } from './storage-ack-endpoint.js';

export type LocalStorageACKWork = (signal: AbortSignal) => LocalStorageACKExecution;

export class LocalStorageACKDrainTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Local StorageACK work did not retire within ${timeoutMs}ms; store teardown blocked`);
    this.name = 'LocalStorageACKDrainTimeoutError';
  }
}

/** Owns self-ACK FIFO work, send deadlines, and shutdown cancellation. */
export class LocalStorageACKTransport {
  private tail: Promise<void> = Promise.resolve();
  private readonly controllers = new Set<AbortController>();
  private closed = false;

  async send(
    work: LocalStorageACKWork,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    if (this.closed) throw new Error('Local StorageACK transport is closed');
    const controller = new AbortController();
    this.controllers.add(controller);
    const predecessor = this.tail;
    let execution: LocalStorageACKExecution | undefined;
    const result = runBoundedOperation(async (signal) => {
      await predecessor;
      signal.throwIfAborted();
      execution = work(signal);
      return execution.response;
    }, { timeoutMs, label: 'Local StorageACK request', signal: controller.signal });
    // The caller receives the deadline result, while the FIFO keeps ownership
    // until the handler itself settles, even after timeout or shutdown abort.
    this.tail = predecessor.then(async () => {
      await result.catch(() => {});
      await execution?.completion.then(() => {}, () => {});
    }).finally(() => {
      this.controllers.delete(controller);
    });
    return result;
  }

  /** Fence new sends and abort active or queued requests immediately. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.controllers) {
      controller.abort(new Error('Local StorageACK transport is stopping'));
    }
  }

  /** Fail closed: never allow store teardown while physical handler work remains. */
  async drain(timeoutMs = 5_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.tail,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new LocalStorageACKDrainTimeoutError(timeoutMs)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
