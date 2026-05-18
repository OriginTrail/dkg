import { describe, it, expect } from 'vitest';
import {
  createCGMemberEnumerator,
  type CGMemberEnumeratorDeps,
} from '../src/swm/enumerate-cg-members.js';

const SELF = '12D3KooWSelf';

function makeDeps(overrides: Partial<CGMemberEnumeratorDeps>): CGMemberEnumeratorDeps {
  return {
    getContextGraphAllowedPeers: async () => null,
    // Default: NOT private. The dedicated "private CG without
    // allowlist" describe-block below overrides this to true to
    // exercise the fail-closed branch (codex review on #571 bug #1).
    isPrivateContextGraph: async () => false,
    getTopicSubscribers: () => [],
    topicForCG: (cgId) => `dkg/context-graph/${cgId}/shared-memory`,
    getSelfPeerId: () => SELF,
    ...overrides,
  };
}

describe('createCGMemberEnumerator: curated CG (allowlist source)', () => {
  it('returns allowlist members and excludes self', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => ['peerA', 'peerB', SELF, 'peerC'],
    }));

    const result = await enumerator.enumerate('cg-curated-1');

    expect(result.source).toBe('allowlist');
    expect(result.members.sort()).toEqual(['peerA', 'peerB', 'peerC']);
  });

  it('preserves source=allowlist even when allowlist is empty', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => [],
      getTopicSubscribers: () => ['shouldNotAppearPeer'],
    }));

    const result = await enumerator.enumerate('cg-curated-empty');

    expect(result.source).toBe('allowlist');
    expect(result.members).toEqual([]);
  });

  it('does not consult topic subscribers when an allowlist exists', async () => {
    let subscribersCalled = 0;
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => ['peerA'],
      getTopicSubscribers: () => {
        subscribersCalled += 1;
        return ['peerB'];
      },
    }));

    await enumerator.enumerate('cg-curated-2');

    expect(subscribersCalled).toBe(0);
  });

  it('dedupes a curated allowlist that contains duplicates', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => ['peerA', 'peerA', 'peerB', 'peerA'],
    }));

    const result = await enumerator.enumerate('cg-curated-dups');

    expect(result.members.sort()).toEqual(['peerA', 'peerB']);
  });
});

describe('createCGMemberEnumerator: public CG (topic-subscribers source)', () => {
  it('falls through to topic subscribers when allowlist is null', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => null,
      getTopicSubscribers: (topic) => {
        expect(topic).toBe('dkg/context-graph/cg-public-1/shared-memory');
        return ['peerX', 'peerY'];
      },
    }));

    const result = await enumerator.enumerate('cg-public-1');

    expect(result.source).toBe('topic-subscribers');
    expect(result.members.sort()).toEqual(['peerX', 'peerY']);
  });

  it('excludes self from topic subscribers', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => null,
      getTopicSubscribers: () => [SELF, 'peerY'],
    }));

    const result = await enumerator.enumerate('cg-public-2');

    expect(result.source).toBe('topic-subscribers');
    expect(result.members).toEqual(['peerY']);
  });

  /**
   * Regression for codex review on PR #571 round 2: source label
   * MUST be derived from the FILTERED member list, not the raw
   * subscriber count. Otherwise a public CG where only `self` is
   * subscribed (common bootstrap state — we're first to subscribe,
   * no one else has joined) returns `{ source: 'topic-subscribers',
   * members: [] }`, and any caller that treats `source !== 'none'`
   * as "I have remote recipients" silently skips the gossip-only
   * fallback.
   */
  it('returns source=none when the only subscriber is self', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => null,
      getTopicSubscribers: () => [SELF],
    }));

    const result = await enumerator.enumerate('cg-public-self-only');

    expect(result).toEqual({ source: 'none', members: [] });
  });

  it('returns source=none when duplicates collapse to an empty filtered set', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => null,
      getTopicSubscribers: () => [SELF, SELF, SELF],
    }));

    const result = await enumerator.enumerate('cg-public-self-dupes');

    expect(result).toEqual({ source: 'none', members: [] });
  });

  /**
   * PR-J (2026-05-18): identify GossipSub-advertised subscribers
   * that the substrate fan-out has no realistic chance of
   * reaching, so substrate doesn't waste sends on them. Soak
   * data: the 2026-05-18 Miles<->Lex run enumerated 4
   * subscribers on a CG with one real subscriber — three were
   * ghosts in the local mesh view, every substrate send to them
   * queued forever, ackQuorum waited on acks that would never
   * arrive.
   *
   * Round 2 (codex feedback on #584):
   *   - The filter is async (real wiring consults
   *     libp2p.peerStore.get for the non-connected branch).
   *   - It's applied OUTSIDE the TTL cache (codex YELLOW round
   *     1) so a transient disconnect doesn't strand a real
   *     subscriber for up to 60s.
   *   - It populates a NEW `substrateEligibleMembers` field
   *     instead of shrinking `members` in place (codex RED #3
   *     round 2) — `members` stays as the full gossip-eligible
   *     set so ackQuorum keeps tracking everyone, and only
   *     substrate fan-out consults the filtered subset.
   */
  describe('isPeerDialable filter (PR-J)', () => {
    it('populates substrateEligibleMembers with the dialable subset, leaves members unfiltered', async () => {
      const enumerator = createCGMemberEnumerator(makeDeps({
        getContextGraphAllowedPeers: async () => null,
        getTopicSubscribers: () => ['liveA', 'ghostB', 'liveC', 'ghostD'],
        isPeerDialable: (peerId) => peerId.startsWith('live'),
      }));

      const result = await enumerator.enumerate('cg-public-ghosts');

      expect(result.source).toBe('topic-subscribers');
      expect(result.members.sort()).toEqual(['ghostB', 'ghostD', 'liveA', 'liveC']);
      expect(result.substrateEligibleMembers?.sort()).toEqual(['liveA', 'liveC']);
    });

    it('supports an async (Promise-returning) predicate', async () => {
      const enumerator = createCGMemberEnumerator(makeDeps({
        getContextGraphAllowedPeers: async () => null,
        getTopicSubscribers: () => ['liveA', 'ghostB', 'throwC', 'liveD'],
        isPeerDialable: async (peerId) => {
          if (peerId === 'throwC') throw new Error('peerStore cold cache miss');
          return peerId.startsWith('live');
        },
      }));

      const result = await enumerator.enumerate('cg-public-async');

      expect(result.source).toBe('topic-subscribers');
      expect(result.members.length).toBe(4);
      expect(result.substrateEligibleMembers?.sort()).toEqual(['liveA', 'liveD']);
    });

    /**
     * Codex RED #3 (round 2): even when EVERY subscriber fails
     * the dialability filter, `members` MUST stay populated so
     * ackQuorum tracks all of them. The pre-round-2 design
     * collapsed `source` to `'none'` and emptied `members` in
     * this case, silently disabling the watchdog for shares
     * fanning out to a gossip-only-reachable subscriber set.
     */
    it('keeps members populated and source=topic-subscribers even when nobody is dialable', async () => {
      const enumerator = createCGMemberEnumerator(makeDeps({
        getContextGraphAllowedPeers: async () => null,
        getTopicSubscribers: () => ['ghostA', 'ghostB'],
        isPeerDialable: () => false,
      }));

      const result = await enumerator.enumerate('cg-public-all-ghosts');

      expect(result.source).toBe('topic-subscribers');
      expect(result.members.sort()).toEqual(['ghostA', 'ghostB']);
      expect(result.substrateEligibleMembers).toEqual([]);
    });

    it('does NOT populate substrateEligibleMembers for the allowlist branch', async () => {
      let isPeerDialableCalled = 0;
      const enumerator = createCGMemberEnumerator(makeDeps({
        getContextGraphAllowedPeers: async () => ['peerA', 'peerB'],
        isPeerDialable: () => {
          isPeerDialableCalled += 1;
          return false;
        },
      }));

      const result = await enumerator.enumerate('cg-curated-with-offline');

      expect(result.source).toBe('allowlist');
      expect(result.members.sort()).toEqual(['peerA', 'peerB']);
      expect(result.substrateEligibleMembers).toBeUndefined();
      expect(isPeerDialableCalled).toBe(0);
    });

    it('treats missing isPeerDialable as a no-op (pre-PR-J behaviour)', async () => {
      const enumerator = createCGMemberEnumerator(makeDeps({
        getContextGraphAllowedPeers: async () => null,
        getTopicSubscribers: () => ['peerA', 'peerB'],
      }));

      const result = await enumerator.enumerate('cg-public-no-filter');

      expect(result.source).toBe('topic-subscribers');
      expect(result.members.sort()).toEqual(['peerA', 'peerB']);
      expect(result.substrateEligibleMembers).toBeUndefined();
    });

    it('filter is applied AFTER dedupAndExcludeSelf', async () => {
      const seenByFilter: string[] = [];
      const enumerator = createCGMemberEnumerator(makeDeps({
        getContextGraphAllowedPeers: async () => null,
        getTopicSubscribers: () => [SELF, 'peerA', 'peerA', SELF, 'peerB'],
        isPeerDialable: (peerId) => {
          seenByFilter.push(peerId);
          return peerId !== 'peerB';
        },
      }));

      const result = await enumerator.enumerate('cg-public-filter-order');

      expect(result.source).toBe('topic-subscribers');
      expect(result.members.sort()).toEqual(['peerA', 'peerB']);
      expect(result.substrateEligibleMembers).toEqual(['peerA']);
      expect(seenByFilter.sort()).toEqual(['peerA', 'peerB']);
    });

    /**
     * Codex YELLOW regression on #584 round 1: the liveness
     * filter is applied OUTSIDE the 60s TTL cache. A subscriber
     * that goes from non-dialable → dialable → non-dialable
     * across three successive calls must surface that pattern,
     * even when the underlying subscriber snapshot is cached.
     */
    it('filter result reflects current state on every call (not cached)', async () => {
      let isDialable = false;
      const enumerator = createCGMemberEnumerator(makeDeps({
        getContextGraphAllowedPeers: async () => null,
        getTopicSubscribers: () => ['peerA'],
        isPeerDialable: () => isDialable,
      }));

      const r1 = await enumerator.enumerate('cg-public-cache');
      expect(r1.substrateEligibleMembers).toEqual([]);
      expect(r1.members).toEqual(['peerA']);

      isDialable = true;
      const r2 = await enumerator.enumerate('cg-public-cache');
      expect(r2.substrateEligibleMembers).toEqual(['peerA']);

      isDialable = false;
      const r3 = await enumerator.enumerate('cg-public-cache');
      expect(r3.substrateEligibleMembers).toEqual([]);
    });

    it('cached subscriber snapshot is reused across calls (only filter re-runs)', async () => {
      let getSubscribersCalls = 0;
      let getAllowedCalls = 0;
      const enumerator = createCGMemberEnumerator(makeDeps({
        getContextGraphAllowedPeers: async () => {
          getAllowedCalls += 1;
          return null;
        },
        getTopicSubscribers: () => {
          getSubscribersCalls += 1;
          return ['peerA', 'peerB'];
        },
        isPeerDialable: () => true,
      }));

      await enumerator.enumerate('cg-public-cache-hit');
      await enumerator.enumerate('cg-public-cache-hit');
      await enumerator.enumerate('cg-public-cache-hit');

      expect(getAllowedCalls).toBe(1);
      expect(getSubscribersCalls).toBe(1);
    });
  });
});

/**
 * Regression for the first codex finding on PR #571: `null` from
 * `getContextGraphAllowedPeers` does NOT mean "public". A CG can be
 * private via `DKG_ALLOWED_AGENT` / `DKG_PARTICIPANT_AGENT` without
 * any peer-allowlist triples, and falling through to live topic
 * subscribers for those CGs would fan SWM shares out to GossipSub
 * subscribers who are not actually allowed members. The fix
 * disambiguates via the same `isPrivateContextGraph` predicate the
 * responder uses for sync / SWM-share auth — fail closed for any
 * private CG that lacks an enumerable peer roster.
 */
describe('createCGMemberEnumerator: private CG WITHOUT peer allowlist (agent-gated)', () => {
  it('returns source=none and empty members, ignoring topic subscribers', async () => {
    let subscribersCalled = 0;
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => null,
      isPrivateContextGraph: async () => true,
      getTopicSubscribers: () => {
        subscribersCalled += 1;
        return ['nonMemberWhoHappensToSubscribe'];
      },
    }));

    const result = await enumerator.enumerate('cg-agent-gated');

    expect(result).toEqual({ source: 'none', members: [] });
    // The whole point of fail-closed: even though there ARE live
    // topic subscribers, we MUST NOT consult them for private CGs
    // without a peer allowlist (would risk fan-out to non-members).
    expect(subscribersCalled).toBe(0);
  });

  it('still uses the allowlist when one exists (private + peer-allowlisted)', async () => {
    // Sanity check: a private CG that DOES have a peer allowlist
    // (e.g. curated by both `DKG_ALLOWED_PEER` and `DKG_ALLOWED_AGENT`)
    // takes the normal allowlist path and never consults
    // `isPrivateContextGraph`.
    let isPrivateCalled = 0;
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => ['peerA', 'peerB'],
      isPrivateContextGraph: async () => {
        isPrivateCalled += 1;
        return true;
      },
    }));

    const result = await enumerator.enumerate('cg-private-with-allowlist');

    expect(result.source).toBe('allowlist');
    expect(result.members.sort()).toEqual(['peerA', 'peerB']);
    expect(isPrivateCalled).toBe(0);
  });
});

describe('createCGMemberEnumerator: legacy / unknown CG (none source)', () => {
  it('returns source=none and empty members when no allowlist + no subscribers', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => null,
      getTopicSubscribers: () => [],
    }));

    const result = await enumerator.enumerate('cg-bootstrap');

    expect(result).toEqual({ source: 'none', members: [] });
  });
});

describe('createCGMemberEnumerator: TTL cache', () => {
  it('returns cached value within TTL without re-calling deps', async () => {
    let allowedCalls = 0;
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => {
        allowedCalls += 1;
        return ['peerA'];
      },
    }));

    await enumerator.enumerate('cg-cached');
    await enumerator.enumerate('cg-cached');
    await enumerator.enumerate('cg-cached');

    expect(allowedCalls).toBe(1);
  });

  it('recomputes after TTL elapses', async () => {
    let allowedCalls = 0;
    let nowMs = 1_000_000;
    const enumerator = createCGMemberEnumerator(makeDeps({
      now: () => nowMs,
      cacheTtlMs: 1000,
      getContextGraphAllowedPeers: async () => {
        allowedCalls += 1;
        return ['peerA'];
      },
    }));

    await enumerator.enumerate('cg-ttl');
    nowMs += 500;
    await enumerator.enumerate('cg-ttl');
    expect(allowedCalls).toBe(1);

    nowMs += 600;
    await enumerator.enumerate('cg-ttl');
    expect(allowedCalls).toBe(2);
  });

  it('isolates cache per cgId', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async (cgId) => {
        if (cgId === 'cg-1') return ['peerA'];
        if (cgId === 'cg-2') return ['peerB'];
        return null;
      },
    }));

    const a = await enumerator.enumerate('cg-1');
    const b = await enumerator.enumerate('cg-2');

    expect(a.members).toEqual(['peerA']);
    expect(b.members).toEqual(['peerB']);
    expect(enumerator.size()).toBe(2);
  });

  it('invalidate() forces a fresh resolution on the next call', async () => {
    let nthCall = 0;
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => {
        nthCall += 1;
        return nthCall === 1 ? ['peerOld'] : ['peerNew'];
      },
    }));

    const first = await enumerator.enumerate('cg-invalidate');
    expect(first.members).toEqual(['peerOld']);

    const cached = await enumerator.enumerate('cg-invalidate');
    expect(cached.members).toEqual(['peerOld']);

    enumerator.invalidate('cg-invalidate');
    const refreshed = await enumerator.enumerate('cg-invalidate');
    expect(refreshed.members).toEqual(['peerNew']);
  });

  it('invalidate() on an unknown cgId is a no-op', () => {
    const enumerator = createCGMemberEnumerator(makeDeps({}));
    expect(() => enumerator.invalidate('never-seen')).not.toThrow();
  });

  /**
   * Regression for the second codex finding on PR #571: the cache
   * is populated only after the async resolution finishes, so a
   * burst of CONCURRENT enumerate() calls for the same cgId would
   * each see a cache miss and each perform their own SPARQL +
   * `getSubscribers` lookup. The fix caches an in-flight promise
   * keyed by cgId so the burst collapses onto a single resolution.
   *
   * Stalls `getContextGraphAllowedPeers` on a manually-resolved
   * promise so a deterministic burst of 5 concurrent enumerate()s
   * can be observed before any resolution completes.
   */
  it('collapses a CONCURRENT burst of enumerate() calls onto one resolution (in-flight dedup)', async () => {
    let allowedCalls = 0;
    let resolveAllowedPeers!: (peers: string[]) => void;
    const allowedPeersPromise = new Promise<string[]>((res) => {
      resolveAllowedPeers = res;
    });

    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => {
        allowedCalls += 1;
        return allowedPeersPromise;
      },
    }));

    // Fire 5 concurrent enumerate() calls BEFORE the dep's promise
    // settles. Pre-fix: all 5 missed the cache → 5 invocations of
    // `getContextGraphAllowedPeers`. Post-fix: only the first
    // invocation runs; the other 4 join the same in-flight promise.
    const pending = Promise.all([
      enumerator.enumerate('cg-burst'),
      enumerator.enumerate('cg-burst'),
      enumerator.enumerate('cg-burst'),
      enumerator.enumerate('cg-burst'),
      enumerator.enumerate('cg-burst'),
    ]);

    // Allow the microtask queue to drain so all 5 enumerate() calls
    // have actually run their cache-miss + register-in-flight steps
    // before we release the dep promise.
    await new Promise<void>((res) => setImmediate(res));

    expect(allowedCalls).toBe(1);

    resolveAllowedPeers(['peerA', 'peerB']);
    const results = await pending;

    // All 5 callers observe the same result.
    for (const r of results) {
      expect(r.source).toBe('allowlist');
      expect(r.members.sort()).toEqual(['peerA', 'peerB']);
    }
    expect(allowedCalls).toBe(1);

    // After the in-flight promise settles, subsequent calls within
    // TTL hit the normal cache (no additional dep invocations).
    await enumerator.enumerate('cg-burst');
    expect(allowedCalls).toBe(1);
  });

  /**
   * Regression for codex review on PR #571 round 2: `invalidate()`
   * MUST also drop the in-flight slot AND prevent the stale resolve
   * from polluting the cache. Otherwise:
   *   - the next `enumerate(cgId)` joins the still-pending stale
   *     promise and returns the pre-invalidation roster (visible
   *     bug, breaks documented "fresh resolution on the next call"
   *     contract);
   *   - even after clearing the in-flight slot, the stale resolve's
   *     `cache.set` could still land after a fresher resolve had
   *     populated the cache (subtle bug, would cause sporadic
   *     stale reads on TTL hits).
   *
   * The generation counter pinning the stale resolve out of the
   * cache covers both.
   */
  it('invalidate() during an in-flight resolve forces the NEXT enumerate to start a fresh resolve', async () => {
    let allowedCalls = 0;
    let resolveSlow!: (peers: string[]) => void;
    const slowAnswers: Array<Promise<string[]>> = [];
    slowAnswers.push(new Promise<string[]>((res) => { resolveSlow = res; }));

    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => {
        allowedCalls += 1;
        if (allowedCalls === 1) return slowAnswers[0];
        return ['peerNew'];
      },
    }));

    const firstCall = enumerator.enumerate('cg-invalidate-race');
    // First call is now in flight, blocked on slowAnswers[0]. Drain
    // microtasks so the in-flight slot is installed.
    await new Promise<void>((res) => setImmediate(res));
    expect(allowedCalls).toBe(1);

    enumerator.invalidate('cg-invalidate-race');

    // Second call MUST NOT join the stale promise; it MUST start a
    // fresh resolve. Pre-fix it would join `firstCall`.
    const secondCall = enumerator.enumerate('cg-invalidate-race');
    await new Promise<void>((res) => setImmediate(res));
    expect(allowedCalls).toBe(2);

    // Resolve the original (stale) promise. Its result MUST NOT
    // overwrite the cache populated by the fresh resolve. The first
    // caller still gets the pre-invalidation value (it asked before
    // invalidate ran — that's the contract).
    resolveSlow(['peerStale']);

    const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);
    expect(firstResult.members).toEqual(['peerStale']);
    expect(secondResult.members).toEqual(['peerNew']);

    // The cache MUST hold the fresh resolve's value, not the stale
    // one. Verify by a TTL-hit call: it must reflect `peerNew`.
    const third = await enumerator.enumerate('cg-invalidate-race');
    expect(third.members).toEqual(['peerNew']);
    expect(allowedCalls).toBe(2);
  });

  it('releases the in-flight slot on resolution so post-TTL recompute can re-enter', async () => {
    // Confirms the `finally` cleanup. If the in-flight slot leaked,
    // the second burst (after TTL elapses + cache eviction) would
    // either join a stale resolved promise or never fire the dep
    // again, depending on the bug shape.
    let allowedCalls = 0;
    let nowMs = 1_000_000;
    const enumerator = createCGMemberEnumerator(makeDeps({
      now: () => nowMs,
      cacheTtlMs: 100,
      getContextGraphAllowedPeers: async () => {
        allowedCalls += 1;
        return ['peerA'];
      },
    }));

    await enumerator.enumerate('cg-leak-check');
    expect(allowedCalls).toBe(1);

    // Advance past TTL, fire another burst — dep should be invoked
    // exactly once more (the in-flight slot from the first call
    // must have been released).
    nowMs += 200;
    await Promise.all([
      enumerator.enumerate('cg-leak-check'),
      enumerator.enumerate('cg-leak-check'),
    ]);
    expect(allowedCalls).toBe(2);
  });
});

describe('createCGMemberEnumerator: source label transitions', () => {
  it('reflects the live source whenever recompute fires (post-TTL)', async () => {
    let nowMs = 1_000_000;
    let allowed: string[] | null = ['peerCurated'];
    const enumerator = createCGMemberEnumerator(makeDeps({
      now: () => nowMs,
      cacheTtlMs: 100,
      getContextGraphAllowedPeers: async () => allowed,
      getTopicSubscribers: () => ['peerOpen'],
    }));

    const first = await enumerator.enumerate('cg-transition');
    expect(first.source).toBe('allowlist');

    allowed = null;
    nowMs += 200;

    const second = await enumerator.enumerate('cg-transition');
    expect(second.source).toBe('topic-subscribers');
    expect(second.members).toEqual(['peerOpen']);
  });
});

/**
 * PR-C codex R8: `getSelfPeerId` is a thunk (not a captured
 * string) so that any throw inside the canonical accessor
 * (`DKGAgent.peerId` → `DKGNode.peerId` → throws `DKGNode not
 * started` before libp2p boots) doesn't fire at enumerator
 * construction time. Construction MUST be safe even when the
 * thunk would throw — only the actual `enumerate()` call should
 * exercise it, where the throw bubbles into
 * `publishWorkspaceGossip`'s R1 try/catch (gossip-only fallback).
 */
describe('createCGMemberEnumerator: getSelfPeerId thunk (PR-C codex R8)', () => {
  it('construction does NOT call getSelfPeerId — pre-start agents are safe to wire up', () => {
    let calls = 0;
    const enumerator = createCGMemberEnumerator(makeDeps({
      getSelfPeerId: () => {
        calls += 1;
        throw new Error('DKGNode not started');
      },
    }));

    expect(calls).toBe(0);
    expect(enumerator.size()).toBe(0);
  });

  it('throw inside getSelfPeerId propagates out of enumerate() so callers can rescue', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => ['peerA'],
      getSelfPeerId: () => {
        throw new Error('DKGNode not started');
      },
    }));

    await expect(enumerator.enumerate('cg-thunk-throws')).rejects.toThrow(/not started/);
  });

  it('thunk is called fresh on each cache-miss resolve (allows peerId to become available between calls)', async () => {
    let nowMs = 1_000_000;
    const peerIdSnapshots: (string | null)[] = [];
    let currentPeerId: string | null = null;
    const enumerator = createCGMemberEnumerator(makeDeps({
      now: () => nowMs,
      cacheTtlMs: 100,
      getContextGraphAllowedPeers: async () => ['peerA', SELF, 'peerB'],
      getSelfPeerId: () => {
        peerIdSnapshots.push(currentPeerId);
        if (currentPeerId === null) {
          throw new Error('DKGNode not started');
        }
        return currentPeerId;
      },
    }));

    await expect(enumerator.enumerate('cg-late-start')).rejects.toThrow(/not started/);
    expect(peerIdSnapshots).toEqual([null]);

    currentPeerId = SELF;
    nowMs += 200;
    const result = await enumerator.enumerate('cg-late-start');
    expect(peerIdSnapshots).toEqual([null, SELF]);
    expect(result.members.sort()).toEqual(['peerA', 'peerB']);
  });
});
