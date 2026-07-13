/**
 * Issue #872 / Codex review round 2, finding B regression tests for
 * `DKGAgent.getContextGraphOnChainPolicy`.
 *
 * The bug: the method's local fallback used to read
 * `dkg:publishPolicy` / `dkg:accessPolicy` triples that
 * `createContextGraph` writes BEFORE on-chain
 * registration. For a CG still in the local-only `unregistered`
 * state those triples reflect the creator's intent, not an on-chain
 * commitment — but the daemon's import-artifact read relaxation
 * (`/api/knowledge-assets/import-artifact/{resolve,read-markdown}`) treats
 * a `{accessPolicy:0, publishPolicy:1}` answer as authoritative.
 * The combination meant the owner-guard could be bypassed on a CG
 * the curator hadn't actually committed to making public yet.
 *
 * Fix: gate the local access-policy fallback on
 * `isContextGraphRegistered` and never treat the creator's stored
 * `publishPolicy` as authorization-positive; publish policy must
 * come from a fresh cache or a chain RPC revalidation.
 *
 * These tests bind `DKGAgent.prototype.getContextGraphOnChainPolicy`
 * to a minimal stub (same pattern as `dkg-agent-diagnostics.test.ts`)
 * so the assertions stay focused on the gating logic and don't drag
 * in libp2p / chain / storage initialisation.
 */
import { describe, it, expect, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';

// Hand-rolled call recorder (replaces vitest spy factories): wraps an
// implementation, records every argument tuple on `.calls`, and returns
// the implementation's result. `vi` is retained ONLY for the
// fake-timer clock control in the round-4 timeout test (legitimate
// deterministic time, not a behavior mock).
function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

interface ChainStub {
  getContextGraphAccessPolicy?: (id: bigint) => Promise<number>;
  getContextGraphPublishPolicy?: (id: bigint) => Promise<{
    publishPolicy: number;
    publishAuthority: string;
  }>;
}

interface AgentStub {
  onChainAccessPolicyCache: Map<string, number>;
  onChainPublishPolicyCache: Map<string, number>;
  /**
   * Codex review on #872 — companion timestamp map for {@link onChainPublishPolicyCache}.
   * `getContextGraphOnChainPolicy` reads it to gate stale entries
   * (`now - fetchedAt > ON_CHAIN_PUBLISH_POLICY_CACHE_TTL_MS` ⇒
   * miss). Tests that pre-populate the publishPolicy cache to model
   * a fresh chain-event seed must also bump the timestamp here, or
   * the cache-hit path will fall through to the chain-RPC fallback.
   */
  onChainPublishPolicyCacheUpdatedAt: Map<string, number>;
  subscribedContextGraphs: Map<string, { onChainId?: string }>;
  getContextGraphOnChainId: (id: string) => Promise<string | null>;
  isContextGraphRegistered: (id: string) => Promise<boolean>;
  getStoredContextGraphRegistrationOptions: (id: string) => Promise<{
    publishPolicy?: number;
    publishAuthorityAccountId?: bigint;
  }>;
  readLocalAccessPolicyEnum: (id: string) => Promise<number | undefined>;
  chain?: ChainStub;
  log: { warn: (ctx: unknown, msg: string) => void };
}

function makeStub(overrides: Partial<AgentStub> = {}): AgentStub {
  return {
    onChainAccessPolicyCache: new Map(),
    onChainPublishPolicyCache: new Map(),
    onChainPublishPolicyCacheUpdatedAt: new Map(),
    subscribedContextGraphs: new Map(),
    getContextGraphOnChainId: recorder(async () => null),
    isContextGraphRegistered: recorder(async () => false),
    getStoredContextGraphRegistrationOptions: recorder(async () => ({})),
    readLocalAccessPolicyEnum: recorder(async () => undefined),
    chain: undefined,
    log: { warn: recorder(() => undefined) },
    ...overrides,
  };
}

async function callPolicy(stub: AgentStub, contextGraphId: string) {
  return (DKGAgent.prototype as any).getContextGraphOnChainPolicy.call(stub, contextGraphId);
}

interface AckCurationStub {
  onChainAccessPolicyCache: Map<string, number>;
  isPrivateContextGraph: (id: string) => Promise<boolean>;
  chain: ChainStub;
  log: { warn: (ctx: unknown, msg: string) => void };
}

function makeAckCurationStub(overrides: Partial<AckCurationStub> = {}): AckCurationStub {
  return {
    onChainAccessPolicyCache: new Map(),
    isPrivateContextGraph: recorder(async () => false),
    chain: {},
    log: { warn: recorder(() => undefined) },
    ...overrides,
  };
}

async function callAckCuration(stub: AckCurationStub, contextGraphId: string) {
  return (DKGAgent.prototype as any).resolveCgCurationForAck.call(stub, contextGraphId);
}

describe('DKGAgent.resolveCgCurationForAck', () => {
  it.each([
    [1, true],
    [0, false],
  ] as const)('treats cached policy %i as authoritative before local or chain reads', async (policy, expected) => {
    const localRead = recorder(async () => { throw new Error('local read must not run'); });
    const chainRead = recorder(async () => 1);
    const stub = makeAckCurationStub({
      onChainAccessPolicyCache: new Map([['101', policy]]),
      isPrivateContextGraph: localRead,
      chain: { getContextGraphAccessPolicy: chainRead },
    });

    await expect(callAckCuration(stub, '101')).resolves.toBe(expected);
    expect(localRead.calls).toEqual([]);
    expect(chainRead.calls).toEqual([]);
  });

  it('uses a curated local projection as the cache-miss shortcut', async () => {
    const localRead = recorder(async () => true);
    const chainRead = recorder(async () => 0);
    const stub = makeAckCurationStub({
      isPrivateContextGraph: localRead,
      chain: { getContextGraphAccessPolicy: chainRead },
    });

    await expect(callAckCuration(stub, '102')).resolves.toBe(true);
    expect(localRead.calls).toEqual([['102']]);
    expect(chainRead.calls).toEqual([]);
    expect(stub.onChainAccessPolicyCache.has('102')).toBe(false);
  });

  it.each([
    [0, false],
    [1, true],
  ] as const)('falls back to chain policy %i and caches it after a local miss', async (policy, expected) => {
    const localRead = recorder(async () => false);
    const chainRead = recorder(async () => policy);
    const stub = makeAckCurationStub({
      isPrivateContextGraph: localRead,
      chain: { getContextGraphAccessPolicy: chainRead },
    });

    await expect(callAckCuration(stub, '103')).resolves.toBe(expected);
    expect(localRead.calls).toEqual([['103']]);
    expect(chainRead.calls).toEqual([[103n]]);
    expect(stub.onChainAccessPolicyCache.get('103')).toBe(policy);
  });

  it('continues to the chain when the local projection read fails', async () => {
    const localRead = recorder(async () => { throw new Error('store busy'); });
    const chainRead = recorder(async () => 1);
    const stub = makeAckCurationStub({
      isPrivateContextGraph: localRead,
      chain: { getContextGraphAccessPolicy: chainRead },
    });

    await expect(callAckCuration(stub, '104')).resolves.toBe(true);
    expect(chainRead.calls).toEqual([[104n]]);
  });

  it('returns unknown for unsupported, malformed, non-positive, or invalid chain answers', async () => {
    const unsupported = makeAckCurationStub();
    await expect(callAckCuration(unsupported, '105')).resolves.toBeNull();

    const parseGuardRead = recorder(async () => 1);
    const malformed = makeAckCurationStub({ chain: { getContextGraphAccessPolicy: parseGuardRead } });
    await expect(callAckCuration(malformed, 'not-a-number')).resolves.toBeNull();
    await expect(callAckCuration(malformed, '0')).resolves.toBeNull();
    expect(parseGuardRead.calls).toEqual([]);

    const invalidRead = recorder(async () => 2);
    const invalid = makeAckCurationStub({ chain: { getContextGraphAccessPolicy: invalidRead } });
    await expect(callAckCuration(invalid, '106')).resolves.toBeNull();
    expect(invalid.onChainAccessPolicyCache.has('106')).toBe(false);
  });

  it('returns unknown and preserves the ACK fail-closed warning when the chain read fails', async () => {
    const chainRead = recorder(async () => { throw new Error('rpc unavailable'); });
    const warn = recorder((_ctx: unknown, _message: string) => undefined);
    const stub = makeAckCurationStub({
      chain: { getContextGraphAccessPolicy: chainRead },
      log: { warn },
    });

    await expect(callAckCuration(stub, '107')).resolves.toBeNull();
    expect(warn.calls).toEqual([[
      expect.objectContaining({ operationId: expect.any(String) }),
      'isCgCurated: chain.getContextGraphAccessPolicy(107) failed — treating as UNKNOWN (fail-closed at handler): rpc unavailable',
    ]]);
    expect(stub.onChainAccessPolicyCache.has('107')).toBe(false);
  });
});

describe('DKGAgent.getContextGraphOnChainPolicy', () => {
  // Cache-hit path: chain-event-populated entries answer immediately
  // without consulting registration status or local triples.
  it('returns cached on-chain policies when both enums are present', async () => {
    const stub = makeStub({
      onChainAccessPolicyCache: new Map([['cg-1', 0]]),
      onChainPublishPolicyCache: new Map([['cg-1', 1]]),
      // Codex review on #872 — bump the publishPolicy freshness
      // timestamp so the TTL gate (`ON_CHAIN_PUBLISH_POLICY_CACHE_TTL_MS`)
      // treats this entry as still-fresh and the cache-hit path runs.
      onChainPublishPolicyCacheUpdatedAt: new Map([['cg-1', Date.now()]]),
    });
    const result = await callPolicy(stub, 'cg-1');
    expect(result).toEqual({ accessPolicy: 0, publishPolicy: 1 });
    // Cache hit short-circuits before registration status / local
    // fallback — neither stub should have been invoked.
    expect((stub.isContextGraphRegistered as any).calls).toEqual([]);
    expect((stub.getStoredContextGraphRegistrationOptions as any).calls).toEqual([]);
    expect((stub.readLocalAccessPolicyEnum as any).calls).toEqual([]);
  });

  // Round 2, finding B: the regression test. A CG that exists
  // locally (with public + open create-time triples) but has NOT
  // been confirmed on-chain must NOT contribute a positive policy
  // answer via the local fallback — that would let the daemon's
  // read relaxation bypass the owner guard on a CG the curator
  // hasn't actually committed to making public yet.
  it('returns {} when on-chain caches miss AND the CG is not registered (#872 Codex round 2 finding B)', async () => {
    const stub = makeStub({
      isContextGraphRegistered: recorder(async () => false),
      // These stubs would return public + open if the fallback ran —
      // the gating must short-circuit BEFORE calling them. Assert the
      // recorded calls to prove the gate fired.
      getStoredContextGraphRegistrationOptions: recorder(async () => ({ publishPolicy: 1 })),
      readLocalAccessPolicyEnum: recorder(async () => 0),
    });
    const result = await callPolicy(stub, 'cg-unregistered');
    expect(result).toEqual({});
    expect((stub.isContextGraphRegistered as any).calls.at(-1)).toEqual(['cg-unregistered']);
    expect((stub.getStoredContextGraphRegistrationOptions as any).calls).toEqual([]);
    expect((stub.readLocalAccessPolicyEnum as any).calls).toEqual([]);
  });

  // Companion: when the CG IS registered, the local fallback can
  // still fill accessPolicy, but publishPolicy is revalidated from
  // chain. The stored create-time publishPolicy is intentionally
  // ignored because `updatePublishPolicy` does not update that
  // local triple.
  it('uses local accessPolicy and chain publishPolicy when the CG is registered but caches are cold', async () => {
    const getContextGraphPublishPolicy = recorder(async () => ({
      publishPolicy: 1,
      publishAuthority: '0x0000000000000000000000000000000000000000',
    }));
    const stub = makeStub({
      subscribedContextGraphs: new Map([['cg-registered', { onChainId: '9' }]]),
      isContextGraphRegistered: recorder(async () => true),
      getStoredContextGraphRegistrationOptions: recorder(async () => ({ publishPolicy: 1 })),
      readLocalAccessPolicyEnum: recorder(async () => 0),
      chain: { getContextGraphPublishPolicy },
    });
    const result = await callPolicy(stub, 'cg-registered');
    expect(result).toEqual({ accessPolicy: 0, publishPolicy: 1 });
    expect((stub.isContextGraphRegistered as any).calls.at(-1)).toEqual(['cg-registered']);
    expect((stub.getStoredContextGraphRegistrationOptions as any).calls).toEqual([]);
    expect((stub.readLocalAccessPolicyEnum as any).calls.at(-1)).toEqual(['cg-registered']);
    expect(getContextGraphPublishPolicy.calls.at(-1)).toEqual([9n]);
  });

  // Defensive: `isContextGraphRegistered` failing (e.g. SPARQL
  // store transient error) must NOT unlock the fallback. We
  // catch-and-treat-as-false in the production code so the gate
  // remains closed even when the registration probe itself errors.
  it('treats isContextGraphRegistered() rejections as not-registered', async () => {
    const stub = makeStub({
      isContextGraphRegistered: recorder(async () => { throw new Error('store unavailable'); }),
      getStoredContextGraphRegistrationOptions: recorder(async () => ({ publishPolicy: 1 })),
      readLocalAccessPolicyEnum: recorder(async () => 0),
    });
    const result = await callPolicy(stub, 'cg-probe-failed');
    expect(result).toEqual({});
    expect((stub.getStoredContextGraphRegistrationOptions as any).calls).toEqual([]);
    expect((stub.readLocalAccessPolicyEnum as any).calls).toEqual([]);
  });

  // Mixed cache hit: when only accessPolicy is cached AND the CG is
  // registered, the missing publishPolicy is still revalidated from
  // chain rather than filled from the creator's stored options.
  it('uses chain RPC for a missing publishPolicy even when accessPolicy is cached', async () => {
    const getContextGraphPublishPolicy = recorder(async () => ({
      publishPolicy: 1,
      publishAuthority: '0x0000000000000000000000000000000000000000',
    }));
    const stub = makeStub({
      subscribedContextGraphs: new Map([['cg-2', { onChainId: '10' }]]),
      onChainAccessPolicyCache: new Map([['cg-2', 0]]),
      onChainPublishPolicyCache: new Map(),
      isContextGraphRegistered: recorder(async () => true),
      getStoredContextGraphRegistrationOptions: recorder(async () => ({ publishPolicy: 1 })),
      readLocalAccessPolicyEnum: recorder(async () => 0),
      chain: { getContextGraphPublishPolicy },
    });
    const result = await callPolicy(stub, 'cg-2');
    expect(result).toEqual({ accessPolicy: 0, publishPolicy: 1 });
    expect((stub.getStoredContextGraphRegistrationOptions as any).calls).toEqual([]);
    expect(getContextGraphPublishPolicy.calls.at(-1)).toEqual([10n]);
  });

  // Round 3, the regression test. Non-creator peers never receive
  // the `dkg:publishPolicy` triple — it's only written to local
  // `_meta` by the creator's `createContextGraph` call. After a
  // daemon restart, the in-memory chain-event cache is empty too,
  // so the only durable answer for `publishPolicy` is the chain
  // itself. The fallback runs `chain.getContextGraphPublishPolicy`
  // (and `getContextGraphAccessPolicy` for parity) when the CG is
  // confirmed registered, populates the cache, and returns the
  // chain values.
  it('falls back to chain RPC when a registered CG has no local publishPolicy (non-creator peer) (#872 Codex round 3)', async () => {
    const getContextGraphPublishPolicy = recorder(async () => ({
      publishPolicy: 1,
      publishAuthority: '0x0000000000000000000000000000000000000000',
    }));
    const getContextGraphAccessPolicy = recorder(async () => 0);
    const stub = makeStub({
      // Subscribed CG — cleartext id maps to a numeric on-chain id.
      // The fallback must look up that mapping (creators get it
      // from `subscribedContextGraphs`; non-creator peers via the
      // local ontology triple read by `getContextGraphOnChainId`).
      subscribedContextGraphs: new Map([['cg-public-open', { onChainId: '42' }]]),
      isContextGraphRegistered: recorder(async () => true),
      // Non-creator peer: no creator-written local triples.
      getStoredContextGraphRegistrationOptions: recorder(async () => ({})),
      readLocalAccessPolicyEnum: recorder(async () => undefined),
      chain: { getContextGraphPublishPolicy, getContextGraphAccessPolicy },
    });
    const result = await callPolicy(stub, 'cg-public-open');
    expect(result).toEqual({ accessPolicy: 0, publishPolicy: 1 });
    expect(getContextGraphPublishPolicy.calls.at(-1)).toEqual([42n]);
    expect(getContextGraphAccessPolicy.calls.at(-1)).toEqual([42n]);
    // Cache populated under the numeric on-chain id so subsequent
    // calls don't re-RPC.
    expect(stub.onChainPublishPolicyCache.get('42')).toBe(1);
    expect(stub.onChainAccessPolicyCache.get('42')).toBe(0);
  });

  // Round 3, defensive: chain RPC failure must not throw out of
  // `getContextGraphOnChainPolicy`. The function logs a warning
  // and leaves the field undefined; the daemon route then falls
  // back to the strict guard (fail-closed).
  it('treats chain.getContextGraphPublishPolicy() rejections as unknown and logs a warning', async () => {
    const getContextGraphPublishPolicy = recorder(async () => { throw new Error('rpc unavailable'); });
    const stub = makeStub({
      subscribedContextGraphs: new Map([['cg-rpc-fail', { onChainId: '7' }]]),
      isContextGraphRegistered: recorder(async () => true),
      // accessPolicy IS available locally (open-CG ontology
      // triple); only publishPolicy needs the chain.
      readLocalAccessPolicyEnum: recorder(async () => 0),
      chain: { getContextGraphPublishPolicy },
    });
    const result = await callPolicy(stub, 'cg-rpc-fail');
    expect(result).toEqual({ accessPolicy: 0 });
    expect(getContextGraphPublishPolicy.calls.at(-1)).toEqual([7n]);
    expect((stub.log.warn as any).calls.at(-1)).toEqual([
      expect.objectContaining({ operationId: expect.any(String) }),
      expect.stringMatching(/chain\.getContextGraphPublishPolicy\(7\) failed/),
    ]);
    // Cache MUST NOT be populated with an undefined value.
    expect(stub.onChainPublishPolicyCache.has('7')).toBe(false);
  });

  // Round 3 cross-check with round 2's gate. The unregistered case
  // MUST NOT hit the chain — the fail-closed return short-circuits
  // before any RPC. This pins the creator's pre-register state where
  // `createContextGraph` has written local-intent triples but
  // `registerContextGraph` has NOT yet been called, so neither the
  // status flag nor an on-chain id exists locally.
  it('does NOT make a chain RPC call when the CG is unregistered AND no on-chain id is known (round 2 gate still holds)', async () => {
    const getContextGraphPublishPolicy = recorder(async () => ({
      publishPolicy: 1,
      publishAuthority: '0x0000000000000000000000000000000000000000',
    }));
    const getContextGraphAccessPolicy = recorder(async () => 0);
    const stub = makeStub({
      // No on-chain id — `createContextGraph` has run but
      // `registerContextGraph` has not, so the chain hasn't assigned
      // a numeric id yet.
      subscribedContextGraphs: new Map(),
      isContextGraphRegistered: recorder(async () => false),
      getContextGraphOnChainId: recorder(async () => null),
      chain: { getContextGraphPublishPolicy, getContextGraphAccessPolicy },
    });
    const result = await callPolicy(stub, 'cg-unregistered');
    expect(result).toEqual({});
    expect(getContextGraphPublishPolicy.calls).toEqual([]);
    expect(getContextGraphAccessPolicy.calls).toEqual([]);
  });

  // Round 6 (Codex on #879, line 15487, 2026-06-01): the round-2
  // gate keyed on `dkg:registrationStatus = "registered"`, which
  // ONLY the creator's `registerContextGraph` writes — non-creator
  // peers bootstrap CG metadata via `ensureContextGraphLocally` with
  // status="unregistered" and never flip it. After a daemon restart
  // the in-memory chain-event cache is empty, the status check
  // returns false, and the original gate fail-closed for legitimate
  // public+open CGs even though the on-chain id is known. The fix
  // accepts a non-zero numeric `onChainId` from
  // `subscribedContextGraphs` (or the local ontology triple) as
  // proof of an on-chain commitment, so the chain-RPC fallback can
  // run for these peers.
  it('falls through to the chain RPC fallback when status is "unregistered" but onChainId is known (#879 Codex round 6)', async () => {
    const getContextGraphPublishPolicy = recorder(async () => ({
      publishPolicy: 1,
      publishAuthority: '0x0000000000000000000000000000000000000000',
    }));
    const getContextGraphAccessPolicy = recorder(async () => 0);
    const stub = makeStub({
      // Replicated CG: subscribed via chain event, so we have the
      // on-chain id, but `registrationStatus` was never flipped to
      // "registered" because that flag is creator-only.
      subscribedContextGraphs: new Map([['cg-replicated', { onChainId: '77' }]]),
      isContextGraphRegistered: recorder(async () => false),
      // Non-creator peer: no local creator-written triples.
      getStoredContextGraphRegistrationOptions: recorder(async () => ({})),
      readLocalAccessPolicyEnum: recorder(async () => undefined),
      chain: { getContextGraphPublishPolicy, getContextGraphAccessPolicy },
    });
    const result = await callPolicy(stub, 'cg-replicated');
    expect(result).toEqual({ accessPolicy: 0, publishPolicy: 1 });
    expect(getContextGraphPublishPolicy.calls.at(-1)).toEqual([77n]);
    expect(getContextGraphAccessPolicy.calls.at(-1)).toEqual([77n]);
  });

  // Round 6 negative: a CG with NEITHER status="registered" NOR a
  // known on-chain id stays fail-closed. This is the
  // create-without-register state on the creator's own node — no
  // chain commitment exists, so the local-intent triples must NOT
  // contribute a positive policy answer.
  it('still fails closed when neither status nor onChainId proves an on-chain commitment (#879 Codex round 6 negative)', async () => {
    const stub = makeStub({
      // No `subscribedContextGraphs` entry, no ontology triple.
      subscribedContextGraphs: new Map(),
      getContextGraphOnChainId: recorder(async () => null),
      isContextGraphRegistered: recorder(async () => false),
      // These would return public+open if the gate let them run.
      getStoredContextGraphRegistrationOptions: recorder(async () => ({ publishPolicy: 1 })),
      readLocalAccessPolicyEnum: recorder(async () => 0),
    });
    const result = await callPolicy(stub, 'cg-create-only');
    expect(result).toEqual({});
    expect((stub.getStoredContextGraphRegistrationOptions as any).calls).toEqual([]);
    expect((stub.readLocalAccessPolicyEnum as any).calls).toEqual([]);
  });

  // Codex review on #879 — creator-written `publishPolicy` in
  // `_meta` is create-time state; `updatePublishPolicy` does not
  // refresh it. Even on the creator path, a cached/stored "open"
  // value must not keep relaxing the import-artifact owner guard
  // after the curator flips the CG to curated on-chain.
  it('ignores stored publishPolicy and revalidates from chain even on the creator path', async () => {
    const getContextGraphPublishPolicy = recorder(async () => ({
      publishPolicy: 0,
      publishAuthority: '0x0000000000000000000000000000000000000000',
    }));
    const getContextGraphAccessPolicy = recorder(async () => 0);
    const stub = makeStub({
      subscribedContextGraphs: new Map([['cg-creator', { onChainId: '11' }]]),
      isContextGraphRegistered: recorder(async () => true),
      getStoredContextGraphRegistrationOptions: recorder(async () => ({ publishPolicy: 1 })),
      readLocalAccessPolicyEnum: recorder(async () => 0),
      chain: { getContextGraphPublishPolicy, getContextGraphAccessPolicy },
    });
    const result = await callPolicy(stub, 'cg-creator');
    expect(result).toEqual({ accessPolicy: 0, publishPolicy: 0 });
    expect((stub.getStoredContextGraphRegistrationOptions as any).calls).toEqual([]);
    expect(getContextGraphPublishPolicy.calls.at(-1)).toEqual([11n]);
    expect(getContextGraphAccessPolicy.calls).toEqual([]);
  });

  // Round 4 — the regression test for the daemon-ready hang. If
  // the configured chain RPC stack is exhausted (every endpoint
  // returning 429 / hanging on connect / unreachable), the
  // fallback RPC call would block indefinitely waiting for the
  // chain client to give up. That's catastrophic on the daemon-
  // ready path (the CLI-7 `register exhausts configured chain RPC
  // endpoints` test exceeds its 45s readiness budget). The fix is
  // a bounded 2.5s per-call timeout inside the fallback: the race
  // returns `TIMEOUT_SENTINEL`, the policy field is left
  // undefined, a warning is logged, and the caller fails-closed.
  it('returns undefined (with warning) when the chain-RPC fallback exceeds the bounded timeout (#872 Codex round 4)', async () => {
    vi.useFakeTimers();
    try {
      // Promise that never resolves — emulates an RPC stack that
      // hasn't given up yet because every endpoint is 429-ing.
      const neverResolves = new Promise<{ publishPolicy: number; publishAuthority: string }>(() => {});
      const getContextGraphPublishPolicy = recorder(() => neverResolves);
      const stub = makeStub({
        subscribedContextGraphs: new Map([['cg-slow-rpc', { onChainId: '13' }]]),
        isContextGraphRegistered: recorder(async () => true),
        // accessPolicy answered locally so the test isolates the
        // publishPolicy timeout path.
        readLocalAccessPolicyEnum: recorder(async () => 0),
        chain: { getContextGraphPublishPolicy },
      });
      const promise = callPolicy(stub, 'cg-slow-rpc');
      // Drain microtasks (so the fallback is awaiting the race)
      // and then trip the 2.5s timer.
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await promise;
      expect(result).toEqual({ accessPolicy: 0 });
      expect(getContextGraphPublishPolicy.calls.at(-1)).toEqual([13n]);
      expect((stub.log.warn as any).calls.at(-1)).toEqual([
        expect.objectContaining({ operationId: expect.any(String) }),
        expect.stringMatching(/getContextGraphPublishPolicy\(13\) timed out after 2500ms/),
      ]);
      // Cache MUST NOT be populated with an undefined / partial answer.
      expect(stub.onChainPublishPolicyCache.has('13')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex review on #872 — `publishPolicy` is mutable on-chain
  // (`PublishPolicyUpdated`), but the cache is only seeded by the
  // `ContextGraphCreated` event. Without a freshness gate, a stale
  // `1` survives until daemon restart and keeps relaxing the
  // import-artifact owner guard after a curator flips a CG from
  // open → curated. Pin the TTL behaviour: a cache entry older than
  // `ON_CHAIN_PUBLISH_POLICY_CACHE_TTL_MS` is treated as miss and
  // the chain-RPC fallback re-verifies (and overwrites the cache
  // with the fresh value). Same pattern works for stale `0` entries
  // — both directions re-verify.
  it('treats publishPolicy cache entries older than the TTL as stale and falls through to chain RPC', async () => {
    const TTL_MS = 60_000;
    const STALE_AGE_MS = TTL_MS + 1_000;
    const getContextGraphPublishPolicy = recorder(async () => ({
      publishPolicy: 0, // the curator just flipped open → curated
      publishAuthority: '0x0000000000000000000000000000000000000000',
    }));
    const getContextGraphAccessPolicy = recorder(async () => 0);
    const stub = makeStub({
      subscribedContextGraphs: new Map([['cg-stale', { onChainId: '55' }]]),
      // Cached value says "1" (open), seeded by an old
      // `ContextGraphCreated` event before the curator flipped policy.
      onChainPublishPolicyCache: new Map([['cg-stale', 1]]),
      onChainPublishPolicyCacheUpdatedAt: new Map([['cg-stale', Date.now() - STALE_AGE_MS]]),
      onChainAccessPolicyCache: new Map([['cg-stale', 0]]),
      isContextGraphRegistered: recorder(async () => true),
      getStoredContextGraphRegistrationOptions: recorder(async () => ({ publishPolicy: 1 })),
      chain: { getContextGraphPublishPolicy, getContextGraphAccessPolicy },
    });
    const result = await callPolicy(stub, 'cg-stale');
    // Stale "1" was discarded; chain re-verify returned "0" (curated).
    expect(result).toEqual({ accessPolicy: 0, publishPolicy: 0 });
    expect((stub.getStoredContextGraphRegistrationOptions as any).calls).toEqual([]);
    expect(getContextGraphPublishPolicy.calls.at(-1)).toEqual([55n]);
    // Cache overwritten with the fresh chain answer keyed on
    // numericOnChainId; freshness timestamp also bumped so the
    // next read inside the TTL window is a fast cache-hit.
    expect(stub.onChainPublishPolicyCache.get('55')).toBe(0);
    const newTs = stub.onChainPublishPolicyCacheUpdatedAt.get('55') ?? 0;
    expect(Date.now() - newTs).toBeLessThan(1_000);
  });

  // Branimir review on #1239 — the host-mode self-signed admission gate
  // (`isConfirmedPublicForHostMode`) is a SECURITY-POSITIVE consumer of the
  // cached `publishPolicy`, so it passes a SHORT `publishPolicyMaxCacheAgeMs`
  // (~5s) instead of the general 60s TTL. The follow-on goal (per the re-review)
  // is BOTH directions at once: within the short window the cache is trusted so
  // the chain RPC is rate-capped to ~1 per window per CG (no eth_call per
  // envelope), and PAST it the chain re-verifies so an open→curated downgrade is
  // caught within seconds (not up to 60s).
  it('publishPolicyMaxCacheAgeMs: within-window cache is trusted (no RPC); a beyond-window entry re-verifies on-chain (Branimir #1239 follow-on)', async () => {
    const getPolicy = (stub: any, cg: string, maxAgeMs: number) =>
      (DKGAgent.prototype as any).getContextGraphOnChainPolicy.call(stub, cg, { publishPolicyMaxCacheAgeMs: maxAgeMs });

    // (a) FRESH entry (age 0) within a 5s window → cached "1" used, NO RPC.
    const freshRpc = recorder(async () => ({ publishPolicy: 0, publishAuthority: '0x0000000000000000000000000000000000000000' }));
    const fresh = makeStub({
      subscribedContextGraphs: new Map([['cg-w', { onChainId: '88' }]]),
      onChainPublishPolicyCache: new Map([['cg-w', 1]]),
      onChainPublishPolicyCacheUpdatedAt: new Map([['cg-w', Date.now()]]),
      onChainAccessPolicyCache: new Map([['cg-w', 0]]),
      isContextGraphRegistered: recorder(async () => true),
      chain: { getContextGraphPublishPolicy: freshRpc },
    });
    expect(await getPolicy(fresh, 'cg-w', 5_000)).toEqual({ accessPolicy: 0, publishPolicy: 1 });
    expect(freshRpc.calls).toEqual([]); // rate-capped: no eth_call within the window

    // (b) entry OLDER than the 5s window (6s) → bypassed, chain RPC re-verifies → "0".
    const staleRpc = recorder(async () => ({ publishPolicy: 0, publishAuthority: '0x0000000000000000000000000000000000000000' }));
    const stale = makeStub({
      subscribedContextGraphs: new Map([['cg-w', { onChainId: '88' }]]),
      onChainPublishPolicyCache: new Map([['cg-w', 1]]),
      onChainPublishPolicyCacheUpdatedAt: new Map([['cg-w', Date.now() - 6_000]]),
      onChainAccessPolicyCache: new Map([['cg-w', 0]]),
      isContextGraphRegistered: recorder(async () => true),
      chain: { getContextGraphPublishPolicy: staleRpc },
    });
    expect(await getPolicy(stale, 'cg-w', 5_000)).toEqual({ accessPolicy: 0, publishPolicy: 0 });
    expect(staleRpc.calls.at(-1)).toEqual([88n]);

    // (c) the SAME 6s-old entry is still FRESH under the default 60s TTL — the
    // short window is a per-caller tightening, not a global behaviour change.
    const defaultRpc = recorder(async () => ({ publishPolicy: 0, publishAuthority: '0x0000000000000000000000000000000000000000' }));
    const def = makeStub({
      subscribedContextGraphs: new Map([['cg-w', { onChainId: '88' }]]),
      onChainPublishPolicyCache: new Map([['cg-w', 1]]),
      onChainPublishPolicyCacheUpdatedAt: new Map([['cg-w', Date.now() - 6_000]]),
      onChainAccessPolicyCache: new Map([['cg-w', 0]]),
      isContextGraphRegistered: recorder(async () => true),
      chain: { getContextGraphPublishPolicy: defaultRpc },
    });
    expect(await callPolicy(def, 'cg-w')).toEqual({ accessPolicy: 0, publishPolicy: 1 });
    expect(defaultRpc.calls).toEqual([]); // 6s < 60s default TTL → cache hit, no RPC
  });

  // Round 3 — degenerate state: registered locally but the on-chain
  // id resolution fails (e.g. corrupted ontology graph). We can't
  // RPC without a numeric id, so we return whatever local triples
  // gave us and let the caller fail-closed.
  it('returns whatever local triples gave us when registered but on-chain id cannot be resolved', async () => {
    // Never invoked in this path (the gate returns before any RPC);
    // the impl shape just satisfies the `chain` type contract.
    const getContextGraphPublishPolicy = recorder(async () => ({
      publishPolicy: 0,
      publishAuthority: '0x0000000000000000000000000000000000000000',
    }));
    const stub = makeStub({
      // No subscribed entry, and the SPARQL lookup returns null too.
      subscribedContextGraphs: new Map(),
      getContextGraphOnChainId: recorder(async () => null),
      isContextGraphRegistered: recorder(async () => true),
      readLocalAccessPolicyEnum: recorder(async () => 0),
      chain: { getContextGraphPublishPolicy },
    });
    const result = await callPolicy(stub, 'cg-no-onchain-id');
    expect(result).toEqual({ accessPolicy: 0 });
    expect(getContextGraphPublishPolicy.calls).toEqual([]);
  });
});
