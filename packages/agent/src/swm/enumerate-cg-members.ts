/**
 * SWM Reliable Fan-out — runtime CG member enumeration (rc.9 PR-B,
 * Step 1a of the plan).
 *
 * Discovers the recipient set for a SWM share at fan-out time, with
 * a single uniform API across the three CG membership models that
 * coexist on rc.9 testnet:
 *
 *   - **curated** — CG has an on-chain (or local-meta-mirrored)
 *     allowlist of peer IDs. Resolved via `getContextGraphAllowedPeers`,
 *     which returns a non-null array of allowed peerIds. Source label:
 *     `'allowlist'`.
 *
 *   - **public** — anyone can subscribe. There is NO authoritative
 *     roster (publishing the allowlist on-chain for every drive-by
 *     subscriber would be a cost regression the RFC explicitly avoids
 *     — see RFC-003 §4.4 "Member enumeration misalignment"). The
 *     best-effort substitute is the live GossipSub subscriber set as
 *     observed via the heartbeat + peer-exchange protocol. Source
 *     label: `'topic-subscribers'`.
 *
 *   - **legacy / unknown** — neither an allowlist nor any live
 *     subscribers. Returns an empty member set with source `'none'`
 *     so the caller can fall back to gossip-only delivery (or skip
 *     the substrate top-up entirely). This is the bootstrap state for
 *     a freshly-created CG before any peer has joined the mesh.
 *
 * The enumerator is intentionally NOT a hot-path component. Each
 * `enumerate(cgId)` call may trigger a SPARQL query against the
 * meta graph (for the allowlist resolution) — non-trivial but not
 * prohibitive. The 60s in-memory cache absorbs the burst pattern
 * typical for SWM share workloads (a burst of N shares to the same
 * CG within seconds shares a single enumeration result).
 *
 * Cache TTL chosen to balance:
 *   - **freshness** — when a curator updates the allowlist or a
 *     subscriber joins/leaves, the change becomes visible to the
 *     fan-out path within at most TTL milliseconds.
 *   - **work** — N shares to the same CG within TTL only pay one
 *     SPARQL query + one `getSubscribers` call.
 *
 * Callers that need explicit invalidation (e.g. PR-C after a
 * substrate top-up consistently fails for a member) can call
 * `invalidate(cgId)`.
 */

export type CGMemberSource = 'allowlist' | 'topic-subscribers' | 'none';

export interface CGMemberEnumeration {
  /** Which discovery path produced {@link members}. */
  source: CGMemberSource;
  /**
   * Peer IDs of the recipient set, with self excluded. Order is not
   * guaranteed (depends on SPARQL result ordering or GossipSub's
   * internal peer set iteration). Caller MUST de-duplicate if it
   * combines results across calls.
   */
  members: string[];
}

export interface CGMemberEnumeratorDeps {
  /**
   * Resolves a CG's peer allowlist. Returns `null` for CGs without
   * an explicit `DKG_ALLOWED_PEER` allowlist in the meta graph. A
   * `null` return does NOT by itself mean "public" — agent-gated
   * private CGs (`DKG_ALLOWED_AGENT` / `DKG_PARTICIPANT_AGENT`
   * without peer allowlist triples) also return `null` here. The
   * enumerator disambiguates via {@link isPrivateContextGraph}.
   * Returns `[]` for a curated CG whose allowlist is explicitly
   * empty (rare; surfaced as `source: 'allowlist'` with zero members
   * so callers can distinguish "curated with zero remaining members"
   * from "public CG with no subscribers").
   */
  getContextGraphAllowedPeers: (cgId: string) => Promise<string[] | null>;
  /**
   * Returns true for any private CG — peer-allowlisted, agent-gated,
   * or both. Same predicate the responder consults to gate sync /
   * SWM-share auth (see `DKGAgent.isPrivateContextGraph`), so
   * fan-out classification stays consistent with the data-plane
   * access control.
   *
   * Bug fix (codex review on #571): without this, a CG that is
   * private via `DKG_ALLOWED_AGENT` ONLY (no `DKG_ALLOWED_PEER`
   * triples) was misclassified as public — `getContextGraphAllowedPeers`
   * returns null, and the old code fell straight through to live
   * topic subscribers. That would fan out SWM shares to GossipSub
   * subscribers who are NOT actually allowed members, risking a
   * metadata leak (the encrypted payload itself is still gated by
   * the per-CG key, but the bare fact that a share exists would
   * reach unauthorized nodes). Fail closed: if the CG is private
   * but we have no enumerable peer allowlist, return `source:
   * 'none'` with empty members so the caller falls back to
   * gossip-only delivery (still safe because the receiver enforces
   * auth on the gossip path too).
   */
  isPrivateContextGraph: (cgId: string) => Promise<boolean>;
  /**
   * Best-effort snapshot of peers subscribed to {@link topic} as
   * observed via GossipSub heartbeat + peer-exchange. May be empty
   * or stale; never throws.
   */
  getTopicSubscribers: (topic: string) => string[];
  topicForCG: (cgId: string) => string;
  /**
   * Optional liveness filter for the `topic-subscribers` branch.
   * Returns true iff the peer is currently dialable from this
   * node (e.g. a live libp2p connection exists). Applied AFTER
   * `dedupAndExcludeSelf` to drop ghost subscribers that
   * GossipSub's peer-exchange / heartbeat still advertises but
   * that have since gone offline (or were never reachable).
   *
   * Bug fix (PR-J, 2026-05-18): the 2026-05-18 soak between
   * Miles and Lex surfaced `enumerated=4 attempted=4 queued=4`
   * every cycle on a public CG that had exactly one real
   * subscriber (Lex). Three of the four enumerated peers were
   * ghost entries in our local GossipSub mesh view — sendReliable
   * to each hit `no valid addresses` (recoverable) → permanent
   * outbox row, monotonically rising `queued` counter, no acks.
   * The filter drops those before substrate fan-out attempts.
   *
   * Intentionally NOT applied to the `allowlist` branch: curated
   * CGs deliberately track ALL allowlisted peers (online or not)
   * so the watchdog can fire substrate top-up when a previously
   * offline allowlistee reconnects. For `allowlist` the offline
   * peer eventually recovers via `runSyncOnConnect`; for
   * `topic-subscribers` offline subscribers are noise we can't
   * distinguish from churn, so we drop them.
   *
   * Optional so existing tests / non-substrate callers that
   * construct an enumerator without a libp2p handle keep
   * working. When omitted, the filter is a no-op and pre-PR-J
   * behaviour is preserved.
   */
  isPeerDialable?: (peerId: string) => boolean;
  /**
   * Lazy accessor for our own peer ID. Always excluded from the
   * returned member set — we don't fan-out to ourselves (the local
   * apply already happened in the caller).
   *
   * Resolved as a thunk (not a captured string) because the canonical
   * accessor on `DKGAgent` is `this.node.peerId`, which throws
   * `DKGNode not started` if libp2p hasn't booted yet. Eagerly
   * capturing it at enumerator construction time would break the
   * pre-start `share()` contract: callers that construct an agent
   * and call `share()` before `start()` (e.g. test harnesses, or
   * production code that queues writes before the node finishes
   * booting) would crash inside the fan-out planner even when the
   * share would otherwise take the gossip-only path. With a thunk,
   * any throw bubbles out of `enumerate()` and gets caught by the
   * try/catch in `DKGAgent.publishWorkspaceGossip` (PR-C codex R1
   * fallback), which falls back to gossip-only and preserves the
   * contract.
   *
   * The thunk is called fresh on every `computeMembers` invocation
   * (cache misses) — peer ID is immutable once the node is started,
   * so there's no correctness issue if it's read across multiple
   * resolves with the same node.
   */
  getSelfPeerId: () => string;
  /** Defaults to `Date.now`; override in tests for deterministic TTL. */
  now?: () => number;
  /** Defaults to 60s; override in tests or for higher-volatility CGs. */
  cacheTtlMs?: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;

export interface CGMemberEnumerator {
  /**
   * Resolve the current member set for {@link cgId}. Returns cached
   * value if within TTL, otherwise recomputes (and caches).
   */
  enumerate(cgId: string): Promise<CGMemberEnumeration>;
  /**
   * Drop the cached entry for {@link cgId} so the next `enumerate`
   * call recomputes. Safe to call for unknown cgIds (no-op).
   */
  invalidate(cgId: string): void;
  /** Test/debug helper: number of cached entries currently held. */
  size(): number;
}

export function createCGMemberEnumerator(deps: CGMemberEnumeratorDeps): CGMemberEnumerator {
  const now = deps.now ?? (() => Date.now());
  const ttl = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new Map<string, { computedAtMs: number; value: CGMemberEnumeration }>();
  // In-flight promise dedup so a burst of concurrent `enumerate(cgId)`
  // calls for the same cgId collapses onto a single resolution. Bug
  // fix (codex review on #571 round 1): without this, the burst
  // optimisation the cache TTL is supposed to provide didn't actually
  // fire for CONCURRENT bursts — every concurrent call saw a cache
  // miss (cache is populated only after the async resolution
  // finishes) and each performed its own SPARQL query +
  // `getSubscribers` call.
  const inFlight = new Map<string, Promise<CGMemberEnumeration>>();
  // Per-cgId generation counter bumped on every `invalidate(cgId)`.
  // Bug fix (codex review on #571 round 2): `invalidate()` previously
  // only cleared the resolved TTL cache, so concurrent
  // `enumerate(cgId)` callers that arrived AFTER an `invalidate()`
  // but while an earlier resolve was still in flight would join the
  // stale promise and observe the pre-invalidation roster. Even with
  // the in-flight slot also cleared in `invalidate()`, there is still
  // a write-after-invalidate race where the stale resolve's
  // `cache.set` could land after a fresh resolve had already
  // populated the cache. The generation counter is captured BEFORE
  // each resolve starts, and the resolve refuses to write to the
  // cache if the captured generation no longer matches the current
  // one — pinning the documented "fresh resolution on the next call"
  // contract end-to-end.
  const generation = new Map<string, number>();
  const currentGen = (cgId: string): number => generation.get(cgId) ?? 0;

  function isFresh(entry: { computedAtMs: number }, nowMs: number): boolean {
    return nowMs - entry.computedAtMs < ttl;
  }

  async function resolve(cgId: string, gen: number, computedAtMs: number): Promise<CGMemberEnumeration> {
    const result = await computeMembers(cgId);
    // Only commit to the TTL cache if no `invalidate(cgId)` has run
    // since this resolve started. Otherwise a stale resolve could
    // overwrite a fresher one (or pollute a freshly-cleared cache).
    if (currentGen(cgId) === gen) {
      cache.set(cgId, { computedAtMs, value: result });
    }
    return result;
  }

  async function computeMembers(cgId: string): Promise<CGMemberEnumeration> {
    const allowed = await deps.getContextGraphAllowedPeers(cgId);

    if (allowed !== null) {
      // Curated CG with explicit peer allowlist: roster is
      // authoritative. Even an empty allowlist is meaningful
      // (curator removed every member; do NOT fall through to topic
      // subscribers — that would re-admit peers the curator just
      // kicked).
      return {
        source: 'allowlist',
        members: dedupAndExcludeSelf(allowed, deps.getSelfPeerId()),
      };
    }

    // No peer allowlist exists. Disambiguate private (agent-gated)
    // from public via the same predicate the responder consults for
    // sync / SWM-share auth. Fail closed for private CGs (see
    // `isPrivateContextGraph` jsdoc on CGMemberEnumeratorDeps).
    if (await deps.isPrivateContextGraph(cgId)) {
      return { source: 'none', members: [] };
    }

    // Public CG: no on-chain roster exists by design (subscribers
    // don't pay to subscribe). Use the live GossipSub view.
    //
    // Source label is derived from the FILTERED member list, not
    // from the raw subscriber count. Bug fix (codex review on #571
    // round 2): when the only subscriber visible is `self` (common
    // when we're the first to subscribe to a public CG and no one
    // else has joined yet) or duplicates collapse away, we'd
    // otherwise return `{ source: 'topic-subscribers', members: [] }`
    // and any caller that treats `source !== 'none'` as "I have
    // remote recipients" would skip the intended fallback.
    //
    // PR-J (2026-05-18) adds a second filter pass: ghost peers
    // that GossipSub still lists as subscribers but that we
    // can't actually reach (no live connection) are dropped
    // before reporting. See the `isPeerDialable` jsdoc on
    // CGMemberEnumeratorDeps for the soak data this fixes.
    const subscribers = deps.getTopicSubscribers(deps.topicForCG(cgId));
    const deduped = dedupAndExcludeSelf(subscribers, deps.getSelfPeerId());
    const members = deps.isPeerDialable
      ? deduped.filter(deps.isPeerDialable)
      : deduped;
    return members.length === 0
      ? { source: 'none', members: [] }
      : { source: 'topic-subscribers', members };
  }

  return {
    async enumerate(cgId: string): Promise<CGMemberEnumeration> {
      const nowMs = now();
      const cached = cache.get(cgId);
      if (cached && isFresh(cached, nowMs)) {
        return cached.value;
      }

      const existing = inFlight.get(cgId);
      if (existing) return existing;

      const gen = currentGen(cgId);
      const promise = resolve(cgId, gen, nowMs).finally(() => {
        // Only release the slot if it still points to OUR promise.
        // After `invalidate()` clears `inFlight[cgId]` and a fresh
        // caller installs a new in-flight promise, we must not
        // delete that fresh entry.
        if (inFlight.get(cgId) === promise) {
          inFlight.delete(cgId);
        }
      });
      inFlight.set(cgId, promise);
      return promise;
    },

    invalidate(cgId: string): void {
      generation.set(cgId, currentGen(cgId) + 1);
      cache.delete(cgId);
      // Also drop the in-flight slot so the next `enumerate(cgId)`
      // triggers a fresh resolve instead of joining the now-stale
      // pending promise. The stale resolve's `cache.set` is gated
      // by the generation check above, so it can't pollute the cache
      // after this point.
      inFlight.delete(cgId);
    },

    size(): number {
      return cache.size;
    },
  };
}

function dedupAndExcludeSelf(peers: readonly string[], selfPeerId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of peers) {
    if (p === selfPeerId) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
