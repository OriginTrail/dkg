import { isStorageACKProtocol } from './storage-ack-protocols.js';
import type { StorageACKEndpoint } from './storage-ack-endpoint.js';

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
    endpoint: StorageACKEndpoint,
    peerId: string,
    protocol: string,
    data: Uint8Array,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    if (this.closed) throw new Error('Local StorageACK transport is closed');
    if (!isStorageACKProtocol(protocol)) throw new Error(`Unsupported StorageACK protocol: ${protocol}`);
    const controller = new AbortController();
    this.controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Local StorageACK request timed out after ${timeoutMs}ms`);
        controller.abort(error);
        reject(error);
      }, Math.max(0, timeoutMs));
      timer.unref?.();
    });
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error('Local StorageACK request aborted'));
      }, { once: true });
    });
    const work = this.tail.then(() => {
      controller.signal.throwIfAborted();
      return endpoint.dispatch(protocol, data, peerId, controller.signal);
    });
    this.tail = work.then(() => {}, () => {}).finally(() => {
      this.controllers.delete(controller);
    });
    try {
      return await Promise.race([work, timeout, cancelled]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
