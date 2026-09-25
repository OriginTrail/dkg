import { isStorageACKProtocol } from '@origintrail-official/dkg-core';
import type { StorageACKEndpoint } from './storage-ack-endpoint.js';
import type { LocalStorageAckHeadExpectation } from '@origintrail-official/dkg-publisher';
import { runBoundedOperation } from '../bounded-operation.js';

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
    expectedHead?: LocalStorageAckHeadExpectation,
  ): Promise<Uint8Array> {
    if (this.closed) throw new Error('Local StorageACK transport is closed');
    if (!isStorageACKProtocol(protocol)) throw new Error(`Unsupported StorageACK protocol: ${protocol}`);
    const controller = new AbortController();
    this.controllers.add(controller);
    const predecessor = this.tail;
    let physicalWork: Promise<Uint8Array> | undefined;
    const result = runBoundedOperation(async (signal) => {
      await predecessor;
      signal.throwIfAborted();
      const response = Promise.resolve(endpoint.dispatch(protocol, data, peerId, signal, expectedHead, (work) => {
        physicalWork = work;
      }));
      // Simple endpoints have no separate deadline. Production endpoints
      // register the inner handler promise before returning their response.
      physicalWork ??= response;
      return response;
    }, { timeoutMs, label: 'Local StorageACK request', signal: controller.signal });
    // The caller receives the deadline result, while the FIFO keeps ownership
    // until the handler itself settles, even after timeout or shutdown abort.
    this.tail = predecessor.then(async () => {
      await result.catch(() => {});
      await physicalWork?.then(() => {}, () => {});
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
