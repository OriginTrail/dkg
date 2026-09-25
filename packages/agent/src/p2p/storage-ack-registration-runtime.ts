import type { StorageACKProtocol } from '@origintrail-official/dkg-core';
import { LocalStorageACKTransport } from './local-storage-ack-transport.js';
import type { StorageACKEndpoint } from './storage-ack-endpoint.js';

/** Owns the ACK endpoint, retry work, failover, and local sends for one agent. */
export class StorageACKRegistrationRuntime {
  private generation = 0;
  private currentEndpoint: StorageACKEndpoint | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryInFlight = false;
  private failoverInFlight = false;
  private readonly attempts = new Set<Promise<unknown>>();
  private localTransport = new LocalStorageACKTransport();

  get endpoint(): StorageACKEndpoint | null { return this.currentEndpoint; }
  get registered(): boolean { return this.currentEndpoint !== null; }

  begin(): number {
    this.generation++;
    this.localTransport = new LocalStorageACKTransport();
    return this.generation;
  }

  isCurrent(generation: number): boolean { return this.generation === generation; }

  track<T>(attempt: Promise<T>): Promise<T> {
    this.attempts.add(attempt);
    void attempt.then(
      () => { this.attempts.delete(attempt); },
      () => { this.attempts.delete(attempt); },
    );
    return attempt;
  }

  installIfCurrent(generation: number, endpoint: StorageACKEndpoint): boolean {
    if (!this.isCurrent(generation) || this.currentEndpoint !== null) {
      endpoint.dispose();
      return false;
    }
    this.currentEndpoint = endpoint;
    this.clearRetry();
    return true;
  }

  handleSignerLoss(generation: number, owner: StorageACKEndpoint, retry: () => Promise<void>): boolean {
    if (!this.isCurrent(generation) || this.currentEndpoint !== owner || this.failoverInFlight) return false;
    this.failoverInFlight = true;
    this.currentEndpoint = null;
    owner.dispose();
    void this.track(Promise.resolve().then(retry)).then(
      () => { this.failoverInFlight = false; },
      () => { this.failoverInFlight = false; },
    );
    return true;
  }

  scheduleRetry(generation: number, delayMs: number, isStarted: () => boolean, retry: () => Promise<void>): boolean {
    if (!this.isCurrent(generation) || this.retryTimer || this.registered) return false;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.isCurrent(generation) || !isStarted() || this.registered || this.retryInFlight) return;
      this.retryInFlight = true;
      void this.track(Promise.resolve().then(retry)).then(
        () => { this.retryInFlight = false; },
        () => { this.retryInFlight = false; },
      );
    }, delayMs);
    this.retryTimer.unref?.();
    return true;
  }

  clearRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** A sender captures its transport lifetime so old factories stay closed after restart. */
  createLocalSender(): (
    peerId: string, protocol: StorageACKProtocol, data: Uint8Array, timeoutMs: number,
  ) => Promise<Uint8Array> {
    const transport = this.localTransport;
    return (peerId, protocol, data, timeoutMs) => {
      const endpoint = this.currentEndpoint;
      if (!endpoint) throw new Error('Local StorageACK handler is not registered');
      return transport.send(endpoint, peerId, protocol, data, timeoutMs);
    };
  }

  /** Test compatibility for focused transport fixtures. Production installs through installIfCurrent. */
  replaceEndpointForTest(endpoint: StorageACKEndpoint | null): void {
    this.currentEndpoint = endpoint;
  }

  /** Fence all ACK work immediately, then join physical work before store teardown. */
  async closeAndDrain(): Promise<void> {
    this.generation++;
    this.localTransport.close();
    this.clearRetry();
    this.currentEndpoint?.dispose();
    this.currentEndpoint = null;
    const attempts = [...this.attempts];
    if (attempts.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(attempts),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error('StorageACK registration did not retire within 5000ms; teardown blocked')),
              5_000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    this.retryInFlight = false;
    await this.localTransport.drain();
  }
}
