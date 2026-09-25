import type { StorageACKProtocol } from '@origintrail-official/dkg-core';
import { LocalStorageACKTransport } from './local-storage-ack-transport.js';
import type { StorageACKEndpoint } from './storage-ack-endpoint.js';

export type StorageACKRegistrationOptions = {
  repairWallets?: boolean;
  allowChainReresolution?: boolean;
};

type RegistrationOutcome = 'registered' | 'retryable' | 'disabled';
type RegistrationPhase = 'initial' | 'retry' | 'failover';

export interface StorageACKRegistrationPlan {
  attempt: (options: StorageACKRegistrationOptions, phase: RegistrationPhase) => Promise<RegistrationOutcome>;
  retryDelayMs: number;
  isStarted: () => boolean;
  onRetryScheduled: () => void;
  onError: (phase: RegistrationPhase, error: unknown) => void;
}

export interface StorageACKRegistrationSession {
  isCurrent(): boolean;
  install(endpoint: StorageACKEndpoint): boolean;
  signerLost(owner: StorageACKEndpoint): boolean;
  start(plan: StorageACKRegistrationPlan): Promise<void>;
}

/** Owns the ACK registration state machine and local transport for one agent. */
export class StorageACKRegistrationRuntime {
  private generation = 0;
  private currentEndpoint: StorageACKEndpoint | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryInFlight = false;
  private failoverInFlight = false;
  private readonly attempts = new Set<Promise<unknown>>();
  private readonly retiredTransports = new Set<LocalStorageACKTransport>();
  private localTransport = new LocalStorageACKTransport();

  get endpoint(): StorageACKEndpoint | null { return this.currentEndpoint; }
  get registered(): boolean { return this.currentEndpoint !== null; }

  /** A session fences every attempt and owns initial, retry, and signer-loss transitions. */
  begin(): StorageACKRegistrationSession {
    const generation = ++this.generation;
    this.clearRetry();
    this.currentEndpoint?.dispose();
    this.currentEndpoint = null;
    this.localTransport.close();
    this.retiredTransports.add(this.localTransport);
    this.localTransport = new LocalStorageACKTransport();
    let plan: StorageACKRegistrationPlan | undefined;
    const isCurrent = () => this.generation === generation;
    const track = <T>(attempt: Promise<T>): Promise<T> => {
      this.attempts.add(attempt);
      void attempt.then(
        () => { this.attempts.delete(attempt); },
        () => { this.attempts.delete(attempt); },
      );
      return attempt;
    };
    const scheduleRetry = (options: StorageACKRegistrationOptions): void => {
      if (!plan || !isCurrent() || this.retryTimer || this.registered) return;
      const activePlan = plan;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!isCurrent() || !activePlan.isStarted() || this.registered || this.retryInFlight) return;
        this.retryInFlight = true;
        void track(Promise.resolve().then(() => runAttempt(options, 'retry'))).then(
          () => { this.retryInFlight = false; },
          () => { this.retryInFlight = false; },
        );
      }, activePlan.retryDelayMs);
      this.retryTimer.unref?.();
      activePlan.onRetryScheduled();
    };
    const runAttempt = async (options: StorageACKRegistrationOptions, phase: RegistrationPhase): Promise<void> => {
      if (!plan || !isCurrent()) return;
      try {
        const result = await plan.attempt(options, phase);
        if (result === 'retryable') {
          scheduleRetry(phase === 'initial' ? { allowChainReresolution: true } : options);
        }
      } catch (error) {
        plan.onError(phase, error);
        scheduleRetry(phase === 'initial' ? { allowChainReresolution: true } : options);
      }
    };
    return {
      isCurrent,
      install: (endpoint) => {
        if (!isCurrent() || this.currentEndpoint !== null) {
          endpoint.dispose();
          return false;
        }
        this.currentEndpoint = endpoint;
        this.clearRetry();
        return true;
      },
      signerLost: (owner) => {
        if (!plan || !isCurrent() || this.currentEndpoint !== owner || this.failoverInFlight) return false;
        this.failoverInFlight = true;
        this.currentEndpoint = null;
        owner.dispose();
        void track(Promise.resolve().then(() => runAttempt({ repairWallets: false }, 'failover'))).then(
          () => { this.failoverInFlight = false; },
          () => { this.failoverInFlight = false; },
        );
        return true;
      },
      start: (registrationPlan) => {
        if (plan) throw new Error('StorageACK registration session already started');
        plan = registrationPlan;
        return track(runAttempt({}, 'initial'));
      },
    };
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
    const generation = this.generation;
    return (peerId, protocol, data, timeoutMs) => {
      if (generation !== this.generation) throw new Error('Local StorageACK transport is closed for a retired agent lifetime');
      const endpoint = this.currentEndpoint;
      if (!endpoint) throw new Error('Local StorageACK handler is not registered');
      return transport.send(endpoint, peerId, protocol, data, timeoutMs);
    };
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
    this.failoverInFlight = false;
    await Promise.all([
      this.localTransport.drain(),
      ...[...this.retiredTransports].map((transport) => transport.drain()),
    ]);
    this.retiredTransports.clear();
  }
}
