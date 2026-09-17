import type { AsyncLiftPublishAuthority } from './async-lift-publisher-types.js';

/**
 * GH#2648 — how long an AUTHORITATIVE publish-authority answer is reused.
 *
 * Every lift lane polls, so without a cache the scan would issue one
 * `ContextGraphs.isAuthorizedPublisher` read per wallet, per accepted job, per poll — and it runs
 * inside the coordinator's global claim lock, where that cost is paid serially by every lane. A
 * context graph's publish authority changes by governance action, not by the second, so a short
 * reuse window costs nothing real: a lane holding a stale "authorized" answer across a rotation
 * simply fails its publish once, terminally and legibly, instead of silently looping.
 */
export const PUBLISH_AUTHORITY_CACHE_TTL_MS = 30_000;

/**
 * What one lane should do about one accepted job, given the job's context graph authority.
 *
 * `other-wallet` and `unknown` both mean "skip", but they are NOT the same fact and must not be
 * merged: `other-wallet` says a different lane will take it (the scan moves on and the job is
 * claimed within the same poll), while `unknown` says nobody can decide yet (the job waits for
 * the authority read to succeed). Collapsing them would make a transient RPC failure
 * indistinguishable from normal per-lane routing.
 */
export type PublishAuthorityClaimVerdict =
  /** This lane's wallet may publish the job — claim it. */
  | { readonly kind: 'eligible' }
  /** Another configured wallet may publish it — leave it for that lane. */
  | { readonly kind: 'other-wallet' }
  /** Authority could not be read right now — leave the job accepted and ask again next poll. */
  | { readonly kind: 'unknown' }
  /** No configured wallet may EVER publish it — claim it only to fail it terminally. */
  | {
      readonly kind: 'unpublishable';
      readonly contextGraphId: string;
      readonly candidateWalletIds: readonly string[];
    };

export interface PublishAuthorityCacheDependencies {
  /**
   * The job request's context graph identifier is a NAME on the lift queue (the numeric on-chain
   * id is resolved from the local store later, during workspace resolution). Returning
   * `undefined` means this graph has no on-chain identity at all — a local/mock/legacy scope,
   * which no on-chain policy governs.
   */
  readonly resolveContextGraphId: (contextGraphName: string) => Promise<bigint | undefined>;
  readonly resolveAuthority: (contextGraphId: bigint) => Promise<AsyncLiftPublishAuthority>;
  readonly now: () => number;
  readonly ttlMs?: number;
}

interface ResolvedAuthority {
  readonly authority: AsyncLiftPublishAuthority;
  readonly contextGraphId?: bigint;
}

/**
 * Single-flight, TTL-bounded publish-authority reads for the async lift claim scan.
 *
 * Keyed by the context graph NAME the job request carries, so the local id resolution and the
 * chain reads it feeds share one cache entry and one in-flight promise — ten lanes waking on the
 * same poll perform one resolution between them, not ten.
 */
export class PublishAuthorityCache {
  private readonly cached = new Map<string, { value: ResolvedAuthority; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<ResolvedAuthority>>();
  private readonly ttlMs: number;

  constructor(private readonly dependencies: PublishAuthorityCacheDependencies) {
    this.ttlMs = dependencies.ttlMs ?? PUBLISH_AUTHORITY_CACHE_TTL_MS;
  }

  /** Drop every memoized answer — for an operator-visible authority change, and for tests. */
  invalidate(): void {
    this.cached.clear();
  }

  async verdictFor(
    contextGraphName: string,
    walletId: string,
  ): Promise<PublishAuthorityClaimVerdict> {
    const { authority, contextGraphId } = await this.resolve(contextGraphName);
    switch (authority.kind) {
      case 'unenforced':
        return { kind: 'eligible' };
      case 'unknown':
        return { kind: 'unknown' };
      case 'resolved': {
        if (authority.authorizedWalletIds.length === 0) {
          return {
            kind: 'unpublishable',
            contextGraphId: contextGraphId?.toString() ?? contextGraphName,
            candidateWalletIds: authority.candidateWalletIds,
          };
        }
        const target = walletId.trim().toLowerCase();
        return authority.authorizedWalletIds.some((id) => id.trim().toLowerCase() === target)
          ? { kind: 'eligible' }
          : { kind: 'other-wallet' };
      }
    }
  }

  private async resolve(contextGraphName: string): Promise<ResolvedAuthority> {
    const hit = this.cached.get(contextGraphName);
    if (hit) {
      if (hit.expiresAt > this.dependencies.now()) return hit.value;
      this.cached.delete(contextGraphName);
    }
    const pending = this.inFlight.get(contextGraphName);
    if (pending) return await pending;

    const started = this.read(contextGraphName);
    this.inFlight.set(contextGraphName, started);
    try {
      const value = await started;
      // 'unknown' is deliberately NOT cached. It is the answer produced by a failed read, and one
      // transient failure must not pause claiming for a whole TTL — the next poll asks again.
      // Authoritative answers are cached, INCLUDING the empty authorized set: that verdict fails
      // the job terminally, so re-reading it per poll would buy nothing.
      if (value.authority.kind !== 'unknown') {
        this.cached.set(contextGraphName, {
          value,
          expiresAt: this.dependencies.now() + this.ttlMs,
        });
      }
      return value;
    } finally {
      this.inFlight.delete(contextGraphName);
    }
  }

  private async read(contextGraphName: string): Promise<ResolvedAuthority> {
    try {
      const contextGraphId = await this.dependencies.resolveContextGraphId(contextGraphName);
      // No numeric on-chain id ⇒ no on-chain publish policy to enforce. This is the same
      // judgement `DKGPublisher` makes when `BigInt(contextGraphId)` does not yield a positive
      // id: descriptive SWM graph names stay on the local/tentative path.
      if (contextGraphId === undefined) return { authority: { kind: 'unenforced' } };
      return { authority: await this.dependencies.resolveAuthority(contextGraphId), contextGraphId };
    } catch {
      // A read that threw established nothing. Reporting 'unknown' holds the job in `accepted`
      // rather than letting a lane claim work it may be refused for — which, now that the
      // refusal is classified PERMANENT, would end the job instead of retrying it.
      return { authority: { kind: 'unknown' } };
    }
  }
}

/** `BigInt(value)` when it names a positive on-chain id, else `undefined`. Never throws. */
export function positiveOnChainContextGraphId(value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = BigInt(trimmed);
  return parsed > 0n ? parsed : undefined;
}
