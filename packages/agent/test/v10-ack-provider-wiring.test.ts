/**
 * PR #716 audit cluster **C** — agent-side wiring of the structured
 * ACK identity verifier introduced in PR #711.
 *
 * Where the wiring lives:
 *   `packages/agent/src/dkg-agent.ts:19161-19236` (`createV10ACKProvider`).
 *
 * The agent's job is to translate the chain adapter's verifier shape
 * into the `ACKCollector` deps shape. Two non-trivial pieces:
 *
 *   1. `verifyIdentityDetailed` — wired only when the chain adapter
 *      implements `verifyACKIdentityDetailed`. The closure wraps the
 *      adapter call in a `try/catch` and translates a thrown error
 *      into `{ valid: false, reason: 'rpc-error' }`. Without this
 *      translation, a flaky / rate-limited / filter-expired RPC
 *      surfaces in the ACK log as a definitive key-not-registered
 *      rejection — exactly the 90-minute diagnostic dead-end PR #711
 *      was opened to fix.
 *
 *   2. `verifyIdentity` (legacy boolean) — kept as a fallback for
 *      adapters that don't (yet) implement the structured method.
 *      The legacy wrapper also try/catches and swallows to `false`
 *      to preserve the pre-PR-#711 contract.
 *
 * Existing coverage:
 *   - `packages/publisher/test/v10-ack-edge-cases.test.ts` covers
 *     the **collector-side** consumption of these deps (3 tests on
 *     `verifyIdentityDetailed`).
 *   - The **agent-side wiring** that produces those deps had ZERO
 *     direct coverage — a refactor that drops the `rpc-error`
 *     translation or stops wiring the detailed verifier would
 *     re-introduce the pre-PR-#711 diagnostic conflation silently.
 *
 * This file pins the agent-side closures by intercepting the
 * `ACKCollector` constructor (via `vi.mock`) so we can capture the
 * exact deps the agent hands it, then invoking those deps with
 * controlled chain behaviours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
// Codex review feedback: the chain package exports the verifier
// result type as `VerifyACKIdentityResult`; `ACKVerifyResult` is the
// publisher-side mirror (same shape, different export site).
import type { VerifyACKIdentityResult } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';

/**
 * Capture every `ACKCollector` constructor call so each test can
 * inspect the exact deps the agent wired. Cleared in `beforeEach`.
 */
const capturedAckCollectorDeps: unknown[] = [];

vi.mock('@origintrail-official/dkg-publisher', async () => {
  const actual = await vi.importActual<typeof import('@origintrail-official/dkg-publisher')>(
    '@origintrail-official/dkg-publisher',
  );
  return {
    ...actual,
    // #1404: production ACK collectors are built through the centralized
    // `createProductionACKCollector` factory (which injects the readiness-gate
    // timeout — see `createProductionACKCollector`'s own coverage in
    // `v10-ack-edge-cases.test.ts`). Intercept the FACTORY, not `ACKCollector`,
    // so we capture (a) the exact deps the agent hands the production boundary
    // and (b) PROOF that both providers actually route through that boundary — a
    // bare `new ACKCollector(...)` that skipped the readiness opt-in would leave
    // `capturedAckCollectorDeps` empty and fail the "routes through factory"
    // assertions below. We don't need real collector behaviour here — the agent
    // only constructs it; `collect()/collectUpdate()` run on publish, not wired.
    createProductionACKCollector: (deps: unknown) => {
      capturedAckCollectorDeps.push(deps);
      return {
        async collect(): Promise<never> {
          throw new Error('capture stub collect() should not be invoked in wiring tests');
        },
        async collectUpdate(): Promise<never> {
          throw new Error('capture stub collectUpdate() should not be invoked in wiring tests');
        },
      };
    },
  };
});

/**
 * Shape the agent passes to the (now-mocked) `ACKCollector`
 * constructor. We only assert on the two verifier callbacks here.
 */
interface ACKCollectorDepsCapture {
  verifyIdentity?: (recoveredAddress: string, identityId: bigint) => Promise<boolean>;
  verifyIdentityDetailed?: (
    recoveredAddress: string,
    identityId: bigint,
  ) => Promise<VerifyACKIdentityResult>;
}

/**
 * Reach into the agent's `private createV10ACKProvider(cgId)` so the
 * ACK collector is actually constructed and its deps are captured.
 *
 * Also stub the two start-time fields (`router`, `gossip`) the
 * `createV10ACKProvider` guard checks — without a real `start()` they
 * are `undefined`/null, and the function would short-circuit at the
 * very first `if (!this.router || !this.gossip) return undefined;`
 * without ever constructing an `ACKCollector`.
 */
interface ProviderInternals {
  createV10ACKProvider(cgId: string): unknown;
  createV10UpdateACKProvider(cgId: string): unknown;
  router: unknown;
  gossip: unknown;
  chain: MockChainAdapter & {
    verifyACKIdentity?: (recoveredAddress: string, identityId: bigint) => Promise<boolean>;
    verifyACKIdentityDetailed?: (
      recoveredAddress: string,
      identityId: bigint,
    ) => Promise<VerifyACKIdentityResult>;
  };
  node: { libp2p: { getPeers(): unknown[] } };
  // #1404 readiness-passthrough coverage reaches the peer-classification state
  // so it can prove the wired `getReadinessCorePeers` returns confirmed cores
  // ONLY (never the padded dial pool).
  knownCorePeerIds: Set<string>;
  lastKnownRequiredACKs?: number;
}

/**
 * Deps shape the two ACK providers hand the (mocked) production factory. The
 * two peer selectors are the #1404 readiness-gate contract: `getReadinessCorePeers`
 * must return confirmed cores only, while `getConnectedCorePeers` may pad.
 */
interface PeerSelectorDepsCapture {
  getConnectedCorePeers?: () => string[];
  getReadinessCorePeers?: () => string[];
}

/**
 * Seed the fake libp2p peer list plus the confirmed-core subset, and force the
 * dial pool to PAD (confirmed cores below a high quorum) so the readiness probe
 * and the padded dial pool are provably distinct lists.
 */
function seedPeers(internals: ProviderInternals, allPeerIds: string[], corePeerIds: string[]): void {
  (internals as { node: { libp2p: { getPeers(): unknown[] } } }).node = {
    libp2p: { getPeers: () => allPeerIds.map((id) => ({ toString: () => id })) },
  };
  for (const id of corePeerIds) internals.knownCorePeerIds.add(id);
  internals.lastKnownRequiredACKs = 10;
}

async function bootProviderAgent(): Promise<{ agent: DKGAgent; internals: ProviderInternals }> {
  const chain = new MockChainAdapter();
  const agent = await DKGAgent.create({
    name: 'ACKProviderWiringTest',
    chainAdapter: chain,
  });
  const internals = agent as unknown as ProviderInternals;
  // The guards at the top of `createV10ACKProvider` only check
  // truthiness, not type. Pass empty objects so the function reaches
  // the `new ACKCollector(...)` call site.
  internals.router = {};
  internals.gossip = { publish: async () => undefined };
  // Unconditionally override `node` — the real `DKGNode` getter
  // throws on access before `start()` is called, so even the
  // existence check `!internals.node.libp2p` blows up. Provide a
  // structurally-typed stub that satisfies the `getConnectedCorePeers`
  // callback's `this.node.libp2p.getPeers()` call without spinning
  // libp2p.
  (internals as { node: { libp2p: { getPeers(): unknown[] } } }).node = {
    libp2p: { getPeers: () => [] },
  };
  return { agent, internals };
}

describe('DKGAgent.createV10ACKProvider — structured ACK verifier wiring (PR #711)', () => {
  let agent: DKGAgent | null = null;

  beforeEach(() => {
    capturedAckCollectorDeps.length = 0;
  });

  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
    vi.restoreAllMocks();
  });

  it('chain exposes verifyACKIdentityDetailed: agent wires verifyIdentityDetailed AND translates thrown errors to {valid: false, reason: "rpc-error"}', async () => {
    const boot = await bootProviderAgent();
    agent = boot.agent;
    const internals = boot.internals;

    // Make the chain's structured verifier THROW — the pre-PR-#711
    // contract was that the agent's try/catch returned `false`,
    // which the collector logged as the same "not registered"
    // string as a definitive identity rejection. PR #711's fix is
    // that the agent translates the throw into the dedicated
    // `'rpc-error'` reason so operators can act on it.
    internals.chain.verifyACKIdentityDetailed = async (): Promise<VerifyACKIdentityResult> => {
      throw new Error('synthetic RPC outage — filter expired');
    };

    internals.createV10ACKProvider('test-cg');

    expect(capturedAckCollectorDeps).toHaveLength(1);
    const deps = capturedAckCollectorDeps[0] as ACKCollectorDepsCapture;
    expect(deps.verifyIdentityDetailed).toBeTypeOf('function');

    const verdict = await deps.verifyIdentityDetailed!(
      '0xabCDeF0123456789abcDef0123456789AbCdef01',
      42n,
    );
    expect(verdict).toEqual({ valid: false, reason: 'rpc-error' });
  });

  it('chain exposes verifyACKIdentityDetailed: agent forwards a definitive {valid: false, reason: "key-not-registered"} verdict UNCHANGED', async () => {
    // The wrapper must not corrupt definitive verdicts — only
    // translate THROWS into rpc-error. If a refactor accidentally
    // started squashing reason fields to undefined, operators would
    // lose the ability to act on the specific failure mode.
    const boot = await bootProviderAgent();
    agent = boot.agent;
    const internals = boot.internals;

    internals.chain.verifyACKIdentityDetailed = async (): Promise<VerifyACKIdentityResult> => ({
      valid: false,
      reason: 'key-not-registered' as const,
    });

    internals.createV10ACKProvider('test-cg');

    const deps = capturedAckCollectorDeps[0] as ACKCollectorDepsCapture;
    const verdict = await deps.verifyIdentityDetailed!(
      '0xabCDeF0123456789abcDef0123456789AbCdef01',
      42n,
    );
    expect(verdict).toEqual({ valid: false, reason: 'key-not-registered' });
  });

  it('chain exposes only the boolean verifyACKIdentity (no structured method): agent wires verifyIdentity, leaves verifyIdentityDetailed undefined; the legacy wrapper swallows throws to false', async () => {
    // Backward-compat path. The collector falls back to its legacy
    // log line "Signer X not registered for identity Y" when only
    // the boolean callback is provided, so the wiring difference
    // is observable end-to-end.
    const boot = await bootProviderAgent();
    agent = boot.agent;
    const internals = boot.internals;

    // Strip the structured method so the `typeof === 'function'`
    // guard reads false and the agent skips wiring it.
    (internals.chain as { verifyACKIdentityDetailed?: unknown }).verifyACKIdentityDetailed =
      undefined;
    // Make the boolean verifier throw, so we can assert the legacy
    // wrapper translates the throw to `false` rather than letting
    // it propagate.
    internals.chain.verifyACKIdentity = async (): Promise<boolean> => {
      throw new Error('synthetic RPC outage on legacy path');
    };

    internals.createV10ACKProvider('test-cg');

    const deps = capturedAckCollectorDeps[0] as ACKCollectorDepsCapture;
    expect(deps.verifyIdentityDetailed).toBeUndefined();
    expect(deps.verifyIdentity).toBeTypeOf('function');

    const verdict = await deps.verifyIdentity!(
      '0xabCDeF0123456789abcDef0123456789AbCdef01',
      42n,
    );
    expect(verdict).toBe(false);
  });

  // #1404 — the readiness gate only protects production if the provider wiring
  // actually opts in. These pin that BOTH the daemon publish provider and the
  // daemon UPDATE provider construct their collector through the centralized
  // `createProductionACKCollector` factory (which injects
  // `DEFAULT_CORE_PEER_READINESS_TIMEOUT_MS` — proven separately in
  // `v10-ack-edge-cases.test.ts`). If either provider regressed to a bare
  // `new ACKCollector(...)`, it would silently keep the legacy one-shot snapshot
  // and `capturedAckCollectorDeps` would stay empty here — a red test, not false
  // confidence.
  it('createV10ACKProvider constructs its collector through the centralized production factory (readiness opt-in cannot be skipped)', async () => {
    const boot = await bootProviderAgent();
    agent = boot.agent;

    boot.internals.createV10ACKProvider('test-cg');

    expect(capturedAckCollectorDeps).toHaveLength(1);
    // The production boundary owns the readiness timeout, so the agent must NOT
    // pass its own (that would re-introduce the hand-copied constant this
    // centralization removed); it hands the factory the transport + verifier deps
    // and the factory injects the gate.
    const deps = capturedAckCollectorDeps[0] as ACKCollectorDepsCapture & {
      corePeerReadinessTimeoutMs?: number;
      getConnectedCorePeers?: () => string[];
    };
    expect(deps.getConnectedCorePeers).toBeTypeOf('function');
    expect(deps.corePeerReadinessTimeoutMs).toBeUndefined();
  });

  it('createV10UpdateACKProvider ALSO constructs its collector through the centralized production factory (readiness opt-in cannot be skipped)', async () => {
    const boot = await bootProviderAgent();
    agent = boot.agent;

    const provider = boot.internals.createV10UpdateACKProvider('test-cg');

    // Provider must be produced (guards satisfied by MockChainAdapter) AND it
    // must have gone through the factory.
    expect(provider).toBeTypeOf('function');
    expect(capturedAckCollectorDeps).toHaveLength(1);
    const deps = capturedAckCollectorDeps[0] as ACKCollectorDepsCapture;
    // The update provider wires the same structured verifier + rpc-error
    // translation as the publish provider.
    expect(deps.verifyIdentityDetailed).toBeTypeOf('function');
  });

  it('createV10UpdateACKProvider translates a thrown chain verifier into {valid: false, reason: "rpc-error"} (same contract as publish)', async () => {
    const boot = await bootProviderAgent();
    agent = boot.agent;
    const internals = boot.internals;

    internals.chain.verifyACKIdentityDetailed = async (): Promise<VerifyACKIdentityResult> => {
      throw new Error('synthetic RPC outage on update path — filter expired');
    };

    internals.createV10UpdateACKProvider('test-cg');

    const deps = capturedAckCollectorDeps[0] as ACKCollectorDepsCapture;
    const verdict = await deps.verifyIdentityDetailed!(
      '0xabCDeF0123456789abcDef0123456789AbCdef01',
      42n,
    );
    expect(verdict).toEqual({ valid: false, reason: 'rpc-error' });
  });

  // #1404 — the readiness gate only protects a real publish if the wired
  // `getReadinessCorePeers` returns confirmed cores ONLY. The prior tests proved
  // the collector is built through the factory and that `getConnectedCorePeers`
  // exists; they never proved the SEPARATE readiness probe excludes the padded
  // dial pool. If the agent regressed to `getReadinessCorePeers: () =>
  // this.getACKCandidatePeers()` (or dropped the callback so the collector fell
  // back to the padded pool), a connected edge peer would leak into readiness
  // and disarm the wait — the exact #1404 failure — while every other test here
  // stayed green. These pin the confirmed-core-only contract for BOTH providers.
  it('createV10ACKProvider wires getReadinessCorePeers returning confirmed cores ONLY (padded dial pool excluded)', async () => {
    const boot = await bootProviderAgent();
    agent = boot.agent;
    // 2 confirmed cores + 1 connected edge; quorum forced high so the dial pool pads.
    seedPeers(boot.internals, ['core-a', 'core-b', 'edge-c'], ['core-a', 'core-b']);

    boot.internals.createV10ACKProvider('test-cg');

    expect(capturedAckCollectorDeps).toHaveLength(1);
    const deps = capturedAckCollectorDeps[0] as PeerSelectorDepsCapture;
    expect(deps.getReadinessCorePeers).toBeTypeOf('function');
    // Readiness = confirmed cores ONLY.
    expect(new Set(deps.getReadinessCorePeers!())).toEqual(new Set(['core-a', 'core-b']));
    expect(deps.getReadinessCorePeers!()).not.toContain('edge-c');
    // The padded dial pool DOES include the edge — proving the two selectors are
    // distinct lists, so this test fails if readiness silently reuses the pool.
    expect(deps.getConnectedCorePeers!()).toContain('edge-c');
  });

  it('createV10UpdateACKProvider ALSO wires getReadinessCorePeers returning confirmed cores ONLY', async () => {
    const boot = await bootProviderAgent();
    agent = boot.agent;
    seedPeers(boot.internals, ['core-a', 'core-b', 'edge-c'], ['core-a', 'core-b']);

    boot.internals.createV10UpdateACKProvider('test-cg');

    expect(capturedAckCollectorDeps).toHaveLength(1);
    const deps = capturedAckCollectorDeps[0] as PeerSelectorDepsCapture;
    expect(deps.getReadinessCorePeers).toBeTypeOf('function');
    expect(new Set(deps.getReadinessCorePeers!())).toEqual(new Set(['core-a', 'core-b']));
    expect(deps.getReadinessCorePeers!()).not.toContain('edge-c');
    expect(deps.getConnectedCorePeers!()).toContain('edge-c');
  });
});
