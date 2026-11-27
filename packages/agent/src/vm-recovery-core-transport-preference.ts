import type { VmReconcilePublicCoreHolderCredit } from './dkg-agent-types.js';

interface PreferenceIdentity {
  readonly token: symbol;
  readonly onChainCgId: string;
  readonly peerId: string;
  readonly connectionKey: string;
  readonly expiresAt: number;
}

/** Transport hints never establish asset presence, absence or authorization. */
export type CoreTransportPreference = PreferenceIdentity & (
  | { readonly kind: 'ordering-only'; readonly scope?: VmReconcilePublicCoreHolderCredit }
  | { readonly kind: 'reusable-holder'; readonly scope: VmReconcilePublicCoreHolderCredit }
);

interface PreferenceHost {
  now(): number;
  connectionKey(peerId: string): string | null;
  supportsCore(peerId: string): boolean;
  holderReuseEnabled(): boolean;
  captureScope(localCgId: string, candidatePeerIds: readonly string[]): VmReconcilePublicCoreHolderCredit | undefined;
  scopeIsCurrent(localCgId: string, scope: VmReconcilePublicCoreHolderCredit): boolean;
}

export interface CoreTransportPreferenceAttempt {
  readonly localCgId: string;
  readonly onChainCgId: string;
  readonly experimentalHolderReuse: boolean;
  readonly expectedToken: symbol | null | undefined;
  readonly preference: CoreTransportPreference | undefined;
  readonly scope: VmReconcilePublicCoreHolderCredit | undefined;
}

/** Owns affinity storage and every transition across awaited recovery work. */
export class VmRecoveryCoreTransportPreferencePolicy {
  private readonly entries = new Map<string, CoreTransportPreference>();

  constructor(
    private readonly host: PreferenceHost,
    private readonly limits: { readonly ttlMs: number; readonly maxEntries: number },
  ) {}

  preferredPeer(localCgId: string, onChainCgId: string, eligiblePeerIds: readonly string[]): string | undefined {
    const entry = this.entries.get(localCgId);
    if (!entry) return undefined;
    if (entry.onChainCgId !== onChainCgId || !this.transportIsCurrent(entry)
      || (entry.kind === 'ordering-only' && entry.scope !== undefined
        && (!this.host.holderReuseEnabled() || !this.host.scopeIsCurrent(localCgId, entry.scope)))) {
      this.entries.delete(localCgId);
      return undefined;
    }
    if (!eligiblePeerIds.includes(entry.peerId)) return undefined;
    this.entries.delete(localCgId);
    this.entries.set(localCgId, entry);
    return entry.peerId;
  }

  capture(localCgId: string, onChainCgId: string, candidatePeerIds: readonly string[]): CoreTransportPreferenceAttempt {
    const experimentalHolderReuse = this.host.holderReuseEnabled();
    const preference = this.entries.get(localCgId);
    return {
      localCgId, onChainCgId, experimentalHolderReuse, preference,
      expectedToken: experimentalHolderReuse ? preference?.token ?? null : undefined,
      scope: experimentalHolderReuse ? this.host.captureScope(localCgId, candidatePeerIds) : undefined,
    };
  }

  canReuse(attempt: CoreTransportPreferenceAttempt, peerId: string, eligiblePeerIds: readonly string[]): boolean {
    const entry = attempt.preference;
    if (!attempt.experimentalHolderReuse || entry?.peerId !== peerId || entry.kind !== 'reusable-holder') return false;
    if (this.entries.get(attempt.localCgId)?.token === entry.token
      && this.preferredPeer(attempt.localCgId, attempt.onChainCgId, eligiblePeerIds) === peerId
      && this.entries.get(attempt.localCgId)?.token === entry.token
      && this.host.scopeIsCurrent(attempt.localCgId, entry.scope)) return true;
    this.revoke(attempt, peerId);
    return false;
  }

  revalidateReuse(attempt: CoreTransportPreferenceAttempt, peerId: string, admittedConnectionKey: string | null): boolean {
    const entry = attempt.preference;
    const valid = entry?.kind === 'reusable-holder'
      && entry.peerId === peerId
      && this.entries.get(attempt.localCgId)?.token === entry.token
      && admittedConnectionKey === entry.connectionKey
      && this.transportIsCurrent(entry)
      && this.host.scopeIsCurrent(attempt.localCgId, entry.scope);
    if (!valid) this.revoke(attempt, peerId);
    return valid;
  }

  revoke(attempt: CoreTransportPreferenceAttempt, peerId: string): void {
    const entry = this.entries.get(attempt.localCgId);
    if (entry?.peerId === peerId
      && (attempt.expectedToken === undefined || entry.token === attempt.expectedToken)) {
      this.entries.delete(attempt.localCgId);
    }
  }

  settle(attempt: CoreTransportPreferenceAttempt, result: {
    readonly peerId: string;
    readonly connectionKey: string | null;
    readonly completelyVerified: boolean;
    readonly publicAccessVerified: boolean | undefined;
    readonly reusedHolder: boolean;
    readonly carriedHolder: boolean;
  }): { readonly yield: boolean; readonly holderCreditPresent: boolean } {
    const { peerId, connectionKey, completelyVerified, publicAccessVerified, reusedHolder, carriedHolder } = result;
    let remembered = false;
    if (!completelyVerified) {
      this.revoke(attempt, peerId);
    } else if (publicAccessVerified === true) {
      remembered = this.remember(attempt.localCgId, attempt.onChainCgId, peerId, connectionKey,
        attempt.scope ? { scope: attempt.scope, expectedToken: attempt.expectedToken ?? null, kind: 'reusable-holder' } : undefined);
      if (!remembered && attempt.experimentalHolderReuse) this.revoke(attempt, peerId);
    } else if (attempt.experimentalHolderReuse && attempt.scope) {
      remembered = this.remember(attempt.localCgId, attempt.onChainCgId, peerId, connectionKey,
        { scope: attempt.scope, expectedToken: attempt.expectedToken ?? null, kind: 'ordering-only' });
      if (!remembered) this.revoke(attempt, peerId);
    } else if (reusedHolder) {
      this.revoke(attempt, peerId);
    }
    const current = this.entries.get(attempt.localCgId);
    return {
      yield: completelyVerified && reusedHolder && (
        (publicAccessVerified === true && (remembered || carriedHolder))
        || (attempt.experimentalHolderReuse && this.host.supportsCore(peerId))
      ),
      holderCreditPresent: current?.peerId === peerId && current.kind === 'reusable-holder',
    };
  }

  remember(localCgId: string, onChainCgId: string, peerId: string, connectionKey: string | null,
    proof?: { readonly scope: VmReconcilePublicCoreHolderCredit; readonly expectedToken: symbol | null;
      readonly kind: 'ordering-only' | 'reusable-holder' }): boolean {
    if (connectionKey === null || !this.host.supportsCore(peerId)
      || this.host.connectionKey(peerId) !== connectionKey) return false;
    const previous = this.entries.get(localCgId);
    if (proof && ((previous?.token ?? null) !== proof.expectedToken
      || !this.host.scopeIsCurrent(localCgId, proof.scope)
      || (proof.kind === 'ordering-only' && proof.expectedToken !== null
        && previous!.expiresAt <= this.host.now()))) return false;
    const identity: PreferenceIdentity = {
      token: Symbol(localCgId), onChainCgId, peerId, connectionKey,
      expiresAt: this.host.now() + this.limits.ttlMs,
    };
    this.entries.delete(localCgId);
    this.entries.set(localCgId, proof?.kind === 'reusable-holder'
      ? { ...identity, kind: 'reusable-holder', scope: proof.scope }
      : { ...identity, kind: 'ordering-only', ...(proof ? { scope: proof.scope } : {}) });
    while (this.entries.size > this.limits.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return true;
  }

  forgetContextGraph(localCgId: string): void { this.entries.delete(localCgId); }
  forgetPeer(peerId: string): void {
    for (const [localCgId, entry] of this.entries) {
      if (entry.peerId === peerId) this.entries.delete(localCgId);
    }
  }
  clear(): void { this.entries.clear(); }

  private transportIsCurrent(entry: CoreTransportPreference): boolean {
    return entry.expiresAt > this.host.now() && this.host.supportsCore(entry.peerId)
      && this.host.connectionKey(entry.peerId) === entry.connectionKey;
  }
}
