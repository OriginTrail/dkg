import type { StorageACKProtocol } from '@origintrail-official/dkg-core';
import type { LocalStorageAckHeadExpectation } from '@origintrail-official/dkg-publisher';
import { LocalStorageACKTransport } from './local-storage-ack-transport.js';
import type { StorageACKEndpoint } from './storage-ack-endpoint.js';

export type StorageACKRegistrationOptions = {
  repairWallets?: boolean;
  allowChainReresolution?: boolean;
};

type RegistrationPhase = 'initial' | 'retry' | 'failover';
export type RegistrationOutcome =
  | { readonly kind: 'registered'; readonly endpoint: StorageACKEndpoint; readonly owner?: object }
  | { readonly kind: 'retryable' }
  | { readonly kind: 'disabled' };

export interface StorageACKRegistrationPlan {
  attempt: (options: StorageACKRegistrationOptions, phase: RegistrationPhase) => Promise<RegistrationOutcome>;
  retryDelayMs: number;
  isStarted: () => boolean;
  onRetryScheduled: () => void;
  onError: (phase: RegistrationPhase, error: unknown) => void;
}

class RetiredRegistrationSession extends Error {}

/** One session owns its endpoint, retry timer, failover, and in-flight attempts. */
export class StorageACKRegistrationSession {
  private active = true;
  private plan: StorageACKRegistrationPlan | undefined;
  private currentEndpoint: StorageACKEndpoint | null = null;
  private currentOwner: object | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryInFlight = false;
  private failoverInFlight = false;
  private readonly attempts = new Set<Promise<unknown>>();

  get endpoint(): StorageACKEndpoint | null { return this.currentEndpoint; }
  isCurrent(): boolean { return this.active; }

  /** Fence both sides of each asynchronous registration step. */
  async runStep<T>(work: () => Promise<T>): Promise<T> {
    if (!this.active) throw new RetiredRegistrationSession();
    const value = await work();
    if (!this.active) throw new RetiredRegistrationSession();
    return value;
  }

  private track<T>(attempt: Promise<T>): Promise<T> {
    this.attempts.add(attempt);
    void attempt.then(
      () => { this.attempts.delete(attempt); },
      () => { this.attempts.delete(attempt); },
    );
    return attempt;
  }

  private clearRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Fixture installation; production attempts install from their result. */
  install(endpoint: StorageACKEndpoint, owner: object = endpoint): boolean {
    if (!this.active || this.currentEndpoint !== null) {
      endpoint.dispose();
      return false;
    }
    this.currentEndpoint = endpoint;
    this.currentOwner = owner;
    this.clearRetry();
    return true;
  }

  private scheduleRetry(options: StorageACKRegistrationOptions): void {
    if (!this.plan || !this.active || this.retryTimer || this.currentEndpoint) return;
    const plan = this.plan;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.active || !plan.isStarted() || this.currentEndpoint || this.retryInFlight) return;
      this.retryInFlight = true;
      void this.track(Promise.resolve().then(() => this.runAttempt(options, 'retry'))).finally(() => {
        this.retryInFlight = false;
      });
    }, plan.retryDelayMs);
    this.retryTimer.unref?.();
    plan.onRetryScheduled();
  }

  private async runAttempt(options: StorageACKRegistrationOptions, phase: RegistrationPhase): Promise<void> {
    const plan = this.plan;
    if (!plan || !this.active) return;
    try {
      const outcome = await plan.attempt(options, phase);
      if (outcome.kind === 'registered') {
        this.install(outcome.endpoint, outcome.owner);
      } else if (outcome.kind === 'retryable' && this.active) {
        this.scheduleRetry(phase === 'initial' ? { allowChainReresolution: true } : options);
      }
    } catch (error) {
      if (error instanceof RetiredRegistrationSession || !this.active) return;
      plan.onError(phase, error);
      this.scheduleRetry(phase === 'initial' ? { allowChainReresolution: true } : options);
    }
  }

  start(plan: StorageACKRegistrationPlan): Promise<void> {
    if (this.plan) throw new Error('StorageACK registration session already started');
    if (!this.active) throw new Error('StorageACK registration session retired');
    this.plan = plan;
    return this.track(this.runAttempt({}, 'initial'));
  }

  signerLost(owner: object): boolean {
    if (!this.plan || !this.active || this.currentOwner !== owner || !this.currentEndpoint || this.failoverInFlight) return false;
    this.failoverInFlight = true;
    const endpoint = this.currentEndpoint;
    this.currentEndpoint = null;
    this.currentOwner = null;
    endpoint.dispose();
    void this.track(Promise.resolve().then(() => this.runAttempt({ repairWallets: false }, 'failover'))).finally(() => {
      this.failoverInFlight = false;
    });
    return true;
  }

  stopRetry(): void { this.clearRetry(); }

  retire(): void {
    if (!this.active) return;
    this.active = false;
    this.clearRetry();
    this.currentEndpoint?.dispose();
    this.currentEndpoint = null;
    this.currentOwner = null;
  }

  async drain(): Promise<void> { await Promise.allSettled(this.attempts); }
}

/** Runtime swaps registration sessions and owns local transport generations. */
export class StorageACKRegistrationRuntime {
  private currentSession: StorageACKRegistrationSession | null = null;
  private readonly retiredSessions = new Set<StorageACKRegistrationSession>();
  private readonly retiredTransports = new Set<LocalStorageACKTransport>();
  private localTransport = new LocalStorageACKTransport();

  get endpoint(): StorageACKEndpoint | null { return this.currentSession?.endpoint ?? null; }
  get registered(): boolean { return this.endpoint !== null; }

  begin(): StorageACKRegistrationSession {
    if (this.currentSession) {
      this.currentSession.retire();
      this.retiredSessions.add(this.currentSession);
    }
    this.localTransport.close();
    this.retiredTransports.add(this.localTransport);
    this.localTransport = new LocalStorageACKTransport();
    this.currentSession = new StorageACKRegistrationSession();
    return this.currentSession;
  }

  clearRetry(): void { this.currentSession?.stopRetry(); }

  /** A sender captures its transport lifetime so old factories stay closed after restart. */
  createLocalSender(): (
    peerId: string, protocol: StorageACKProtocol, data: Uint8Array, timeoutMs: number,
    expectedHead?: LocalStorageAckHeadExpectation,
  ) => Promise<Uint8Array> {
    const transport = this.localTransport;
    const session = this.currentSession;
    return (peerId, protocol, data, timeoutMs, expectedHead) => {
      if (transport !== this.localTransport || session !== this.currentSession || !session?.isCurrent()) {
        throw new Error('Local StorageACK transport is closed for a retired agent lifetime');
      }
      const endpoint = session.endpoint;
      if (!endpoint) throw new Error('Local StorageACK handler is not registered');
      return transport.send(endpoint, peerId, protocol, data, timeoutMs, expectedHead);
    };
  }

  /** Fence all ACK work immediately, then join physical work before store teardown. */
  async closeAndDrain(): Promise<void> {
    if (this.currentSession) {
      this.currentSession.retire();
      this.retiredSessions.add(this.currentSession);
      this.currentSession = null;
    }
    this.localTransport.close();
    const sessions = [...this.retiredSessions];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(sessions.map((session) => session.drain())),
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
    this.retiredSessions.clear();
    await Promise.all([
      this.localTransport.drain(),
      ...[...this.retiredTransports].map((transport) => transport.drain()),
    ]);
    this.retiredTransports.clear();
  }
}
