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
 * GH#2648 — hard ceiling on ONE authority resolution, because it runs inside the coordinator's
 * process-wide claim lock.
 *
 * `pointRead` has no per-attempt cap when a node is configured with a single RPC provider (the
 * #894 single-RPC carve-out), so a chain read that never settles never returns. Before this scan
 * existed that read ran inside an already-claimed job's publish, outside the lock, and one hung
 * lane did not stop the other nine. Under the lock it stops ALL claiming and blocks
 * `recoverUnreplacedExpiredClaim`, which takes the same lock — with no log line and no failure
 * record, because nothing ever throws. A capped read degrades to `unknown`, which is exactly the
 * "ask again next poll" state the cache already models and deliberately does not memoize.
 */
export const PUBLISH_AUTHORITY_READ_TIMEOUT_MS = 5_000;

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
  /** Per-resolution ceiling; see {@link PUBLISH_AUTHORITY_READ_TIMEOUT_MS}. */
  readonly readTimeoutMs?: number;
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
  /** When this graph FIRST read back an empty authorized set — see {@link emptyAuthorityIsConfirmed}. */
  private readonly emptyAuthoritySeenAt = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly readTimeoutMs: number;

  constructor(private readonly dependencies: PublishAuthorityCacheDependencies) {
    this.ttlMs = dependencies.ttlMs ?? PUBLISH_AUTHORITY_CACHE_TTL_MS;
    this.readTimeoutMs = dependencies.readTimeoutMs ?? PUBLISH_AUTHORITY_READ_TIMEOUT_MS;
  }

  /**
   * Drop what this cache memoized, for one graph or for all of them.
   *
   * The production caller is the `authority_forbidden` recording path: a publish refused for
   * AUTHORITY has just disproved whatever this cache answered about that job's context graph, and
   * the answer would otherwise be reused for the rest of its TTL — routing every other job queued
   * for the same graph the same wrong way. Dropping the entry makes the next poll re-read.
   *
   * The empty-set sighting is dropped with it: the refusal proves nothing about whether the set
   * really is empty, so the confirmation in {@link emptyAuthorityIsConfirmed} starts over rather
   * than letting a stale sighting condemn the next empty read on its own.
   */
  invalidate(contextGraphName?: string): void {
    if (contextGraphName === undefined) {
      this.cached.clear();
      this.emptyAuthoritySeenAt.clear();
      return;
    }
    this.cached.delete(contextGraphName);
    this.emptyAuthoritySeenAt.delete(contextGraphName);
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
        // An empty set reaching this point has been CONFIRMED by a second read a TTL apart
        // (see {@link emptyAuthorityIsConfirmed}); an unconfirmed one arrives as 'unknown'.
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

    const started = this.readWithinDeadline(contextGraphName);
    this.inFlight.set(contextGraphName, started);
    try {
      return await started;
    } finally {
      this.inFlight.delete(contextGraphName);
    }
  }

  /**
   * Memoize an answer the read established, and return what the caller should see for it.
   *
   * The ONE write path into {@link cached}, shared by the in-time result and by a read that only
   * lands after the deadline — a late answer is still an answer, and dropping it is what made a
   * node whose resolution consistently runs a little over `readTimeoutMs` time out on every pass
   * and claim nothing, forever, with nothing thrown and no failure record.
   *
   * 'unknown' is deliberately NOT cached. It is the answer produced by a failed read, and one
   * transient failure must not pause claiming for a whole TTL — the next poll asks again.
   *
   * An EMPTY authorized set is authoritative in shape only, so it is downgraded to 'unknown'
   * until a second read confirms it — see {@link emptyAuthorityIsConfirmed}. The downgraded
   * answer IS cached, for exactly one TTL: that is what schedules the confirming read a full TTL
   * later, and it keeps the re-read off every poll in between.
   */
  private memoize(contextGraphName: string, value: ResolvedAuthority): ResolvedAuthority {
    if (value.authority.kind === 'unknown') return value;
    const now = this.dependencies.now();
    if (
      value.authority.kind === 'resolved'
      && value.authority.authorizedWalletIds.length === 0
      && !this.emptyAuthorityIsConfirmed(contextGraphName, now)
    ) {
      const deferred: ResolvedAuthority = { ...value, authority: { kind: 'unknown' } };
      this.cached.set(contextGraphName, { value: deferred, expiresAt: now + this.ttlMs });
      return deferred;
    }
    this.emptyAuthoritySeenAt.delete(contextGraphName);
    this.cached.set(contextGraphName, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  /**
   * GH#2648 — record that this graph just read back an EMPTY authorized set, and say whether a
   * previous read already did, at least one TTL ago.
   *
   * An empty set is NOT self-evidently a permanent refusal. `ContextGraphs.isAuthorizedPublisher`
   * RETURNS `false` rather than reverting whenever it cannot answer affirmatively: for
   * `contextGraphId > getLatestContextGraphId()`, for an inactive graph, and on every PCA
   * resolution failure (its own fail-closed read path). A replica a few blocks behind head right
   * after `createContextGraph` therefore hands back a perfectly successful read with an empty set
   * — indistinguishable, here, from a curated graph that admits none of this node's wallets.
   * Only a THROWN read is treated as unreadable upstream, so nothing else separates the two.
   *
   * Condemning on that first read is not a routing mistake, it is job loss: the verdict is
   * `unpublishable`, which fails the job `authority_forbidden` with `autoRetry:false`. Requiring a
   * second empty read a TTL later gives a lagging replica time to catch up, and costs a graph that
   * really is refused nothing but one extra poll before its terminal failure.
   */
  private emptyAuthorityIsConfirmed(contextGraphName: string, now: number): boolean {
    const seenAt = this.emptyAuthoritySeenAt.get(contextGraphName);
    if (seenAt === undefined) {
      this.emptyAuthoritySeenAt.set(contextGraphName, now);
      return false;
    }
    return now - seenAt >= this.ttlMs;
  }

  /**
   * Resolve, but never outlast the deadline. The underlying read is abandoned rather than
   * cancelled — there is no cancellation channel through the adapter — so the timer is cleared on
   * both paths and the loser's rejection is swallowed, leaving no unhandled rejection behind.
   *
   * Abandoned by THIS caller only: the read still memoizes whatever it eventually establishes, so
   * the next poll reads the answer out of the cache instead of starting a fresh read that will
   * time out exactly the same way.
   */
  private async readWithinDeadline(contextGraphName: string): Promise<ResolvedAuthority> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<ResolvedAuthority>((resolve) => {
      timer = setTimeout(() => resolve({ authority: { kind: 'unknown' } }), this.readTimeoutMs);
      timer.unref?.();
    });
    try {
      const read = this.read(contextGraphName).then((value) => this.memoize(contextGraphName, value));
      read.catch(() => {});
      return await Promise.race([read, expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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
