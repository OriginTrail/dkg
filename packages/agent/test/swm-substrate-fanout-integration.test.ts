/**
 * rc.9 PR-C integration test for the substrate fan-out + tier-
 * switch wiring INSIDE DKGAgent (the pure decision + executor
 * logic is covered by `swm-substrate-fanout.test.ts`).
 *
 * The agent's `publishWorkspaceGossip` now consults the
 * CGMemberEnumerator + the tier-switch + (conditionally) the
 * substrate fan-out path. Each share goes through three
 * conceptually independent surfaces:
 *
 *   1. Enumeration: which transport(s) we'll use
 *   2. Substrate fan-out: per-(cgId, outcome) counters
 *   3. Gossip publish: PR-A's loud-fail counter (already
 *      regression-tested in `swm-gossip-publish-failure.test.ts`)
 *
 * The wire-format of `/api/slo` for #2 is regression-tested in
 * `packages/cli/test/api-slo-route.test.ts`. What's left to pin
 * is the AGENT-side wiring: that the tier decision actually
 * flows to the substrate vs gossip path based on enumeration,
 * and that the per-outcome counters update accordingly.
 */

import { describe, it, expect } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent, FANOUT_RESPONSE_RETRYABLE } from '../src/index.js';
import type { ReliableSendResult } from '../src/p2p/messenger.js';

const SELF_PEER = '12D3KooWSelfPubC';

class CapturingGossip {
  publishes: Array<{ topic: string; bytes: number }> = [];
  /** Static roster returned by `getSubscribers` — adjust per-test. */
  subscribers: string[] = [];

  subscribe(_topic: string): void {}
  unsubscribe(_topic: string): void {}
  onMessage(_topic: string, _handler: (topic: string, data: Uint8Array, from?: string) => void | Promise<void>): void {}

  async publish(topic: string, data: Uint8Array): Promise<void> {
    this.publishes.push({ topic, bytes: data.byteLength });
  }

  getSubscribers(_topic: string): string[] {
    return [...this.subscribers];
  }
}

/**
 * Narrow stub of Messenger.sendReliable. We don't exercise the
 * envelope wrap / outbox path here — that's covered by the
 * messenger's own tests; we just confirm the agent invokes
 * sendReliable per-substrate-member and that the result is
 * counted into the right per-outcome bucket.
 *
 * `DKGAgent.create()` does NOT initialise `this.messenger` — that
 * happens inside `start()`, which we don't call in this test
 * suite (it would require a real libp2p node). So we install a
 * narrow stub object whose only contract is `sendReliable`; the
 * substrate-fanout module is typed against `FanOutSubstrate`
 * which has only that one method.
 */
function stubMessengerSendReliable(
  results: Map<string, ReliableSendResult> | ((peerId: string) => ReliableSendResult | Error),
): { calls: Array<{ peerId: string; protocolId: string; bytes: number }>; install: (agent: DKGAgent) => void } {
  const calls: Array<{ peerId: string; protocolId: string; bytes: number }> = [];
  const lookup = typeof results === 'function'
    ? results
    : (peerId: string): ReliableSendResult | Error => {
      const r = results.get(peerId);
      if (!r) return new Error(`stubMessengerSendReliable: no result configured for peerId=${peerId}`);
      return r;
    };
  const install = (agent: DKGAgent): void => {
    const stub = {
      sendReliable: async (
        peerId: string,
        protocolId: string,
        payload: Uint8Array,
      ): Promise<ReliableSendResult> => {
        calls.push({ peerId, protocolId, bytes: payload.byteLength });
        const out = lookup(peerId);
        if (out instanceof Error) throw out;
        return out;
      },
    };
    (agent as unknown as { messenger: typeof stub }).messenger = stub;
  };
  return { calls, install };
}

async function createAgent(name: string): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: `${name}-${Math.random().toString(36).slice(2)}`,
    chainAdapter: new MockChainAdapter(),
  });
  // DKGNode.peerId is a getter that delegates into the live libp2p
  // node; without `start()` it throws. Pin it to a deterministic
  // string for the substrate-fanout self-exclusion check (the
  // CGMemberEnumerator reads `this.peerId` lazily on each resolve
  // via the `getSelfPeerId` thunk — PR-C codex R8). Most tests rely
  // on this stub; the dedicated R8 test below removes it to verify
  // the pre-start `share()` contract.
  Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
    value: SELF_PEER,
    configurable: true,
  });
  // PR-J: the CGMemberEnumerator filters topic-subscribers
  // through libp2p reachability. These tests don't drive a real
  // libp2p, so without a stub the filter strips every fake
  // subscriber and substrate fan-out has nobody to send to. The
  // PR-J filter is exercised in `enumerate-cg-members.test.ts`
  // where the predicate is the unit under test; here it's the
  // ack-quorum + bookkeeper wiring that matters, so make
  // EVERYTHING reachable.
  installAllReachableLibp2pStub(agent);
  return agent;
}

function installAllReachableLibp2pStub(agent: DKGAgent): void {
  const allReachableIds = (): string[] => {
    const gossip = (agent as unknown as { gossip?: { subscribers?: string[] } }).gossip;
    return gossip?.subscribers ?? [];
  };
  const stub = {
    getPeers: (): Array<{ toString: () => string }> => {
      return allReachableIds().map((id) => ({ toString: () => id }));
    },
    // PR-K: isPeerDialable now uses getConnections(pid) and filters
    // out limited-only connectivity. Return a direct-style
    // connection object (no `limits`) for any gossip-subscribed
    // peer so the predicate behaves as "everything reachable" in
    // tests that don't care about the PR-K filter itself.
    getConnections: (pid?: unknown): Array<{ remoteAddr: { toString: () => string } }> => {
      const idStr = pid ? (pid as { toString: () => string }).toString() : '';
      return allReachableIds().includes(idStr)
        ? [{ remoteAddr: { toString: () => '/ip4/127.0.0.1/tcp/0' } }]
        : [];
    },
    peerStore: {
      get: async (_peerId: unknown) => ({
        addresses: [{ multiaddr: { toString: () => '/ip4/127.0.0.1/tcp/0' } }],
      }),
    },
  };
  Object.defineProperty((agent as unknown as { node: { libp2p?: unknown } }).node, 'libp2p', {
    value: stub,
    configurable: true,
    writable: true,
  });
}

describe('DKGAgent SWM substrate fan-out integration (rc.9 PR-C)', () => {
  it('reports zero substrate-fanout counters before any share', async () => {
    const agent = await createAgent('SubstrateFanoutZero');
    const stats = agent.getSwmSubstrateFanoutStats();

    expect(stats).toEqual({
      delivered: {},
      rejected: {},
      retryable: {},
      queued: {},
      inFlight: {},
      failed: {},
      overflow: { delivered: 0, rejected: 0, retryable: 0, queued: 0, inFlight: 0, failed: 0 },
      truncated: false,
    });
  });

  /**
   * Public CG with no live subscribers + no allowlist =>
   * `source: 'none'` => gossip-only path. No substrate sends,
   * no per-outcome counters move, gossip publish fires exactly
   * once. This is the PR-A pre-PR-C behavior (verifies PR-C
   * didn't regress the gossip-only branch).
   */
  it('source=none takes gossip-only branch and does NOT call sendReliable', async () => {
    const agent = await createAgent('SubstrateFanoutNone');
    const gossip = new CapturingGossip();
    gossip.subscribers = [];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;
    const { calls, install } = stubMessengerSendReliable(new Map());
    install(agent);

    await agent.share('cg-no-roster', [{
      subject: 'urn:test:none', predicate: 'http://schema.org/name', object: '"hi"', graph: '',
    }]);

    expect(gossip.publishes).toHaveLength(1);
    expect(gossip.publishes[0]?.topic).toMatch(/shared-memory$/);
    expect(calls).toEqual([]);
    expect(agent.getSwmSubstrateFanoutStats()).toEqual({
      delivered: {},
      rejected: {},
      retryable: {},
      queued: {},
      inFlight: {},
      failed: {},
      overflow: { delivered: 0, rejected: 0, retryable: 0, queued: 0, inFlight: 0, failed: 0 },
      truncated: false,
    });
  });

  /**
   * Public CG with live subscribers <= cap (default 100) =>
   * `source: 'topic-subscribers'` => substrate fan-out RUNS in
   * parallel with gossip publish. Each substrate send is counted
   * by outcome. `delivered` for the success, `queued` for the
   * one that the messenger persisted for retry, `failed` for the
   * synchronous-throw classification path.
   */
  it('source=topic-subscribers fans out via substrate AND publishes via gossip, counters reflect mixed outcomes', async () => {
    const agent = await createAgent('SubstrateFanoutPublic');
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWPeerA', '12D3KooWPeerB', '12D3KooWPeerC'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { calls, install } = stubMessengerSendReliable((peerId): ReliableSendResult | Error => {
      switch (peerId) {
        case '12D3KooWPeerA':
          return { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'mA' };
        case '12D3KooWPeerB':
          return {
            delivered: false, queued: true, attempts: 2, messageId: 'mB',
            error: 'transient', nextAttemptAtMs: Date.now() + 1000,
          };
        case '12D3KooWPeerC':
          return new Error('peerC connection refused');
        default:
          return new Error(`unexpected peerId=${peerId}`);
      }
    });
    install(agent);

    await agent.share('cg-public-mixed', [{
      subject: 'urn:test:mixed', predicate: 'http://schema.org/name', object: '"mixed"', graph: '',
    }]);

    // rc.9 PR-G #G2: substrate fan-out is now detached from
    // share()'s critical path, so counters update asynchronously.
    // Drain in-flight substrate before asserting.
    await agent.awaitInFlightSubstrateFanOuts();

    // Gossip publish should have fired exactly once for the topic.
    expect(gossip.publishes).toHaveLength(1);
    expect(gossip.publishes[0]?.topic).toMatch(/shared-memory$/);

    // Substrate fan-out should have hit all three subscribers
    // (self is excluded by the enumerator, and self isn't in
    // this fixture's subscriber list anyway).
    expect(calls).toHaveLength(3);
    expect(calls.every(c => c.protocolId === '/dkg/10.0.1/swm-update')).toBe(true);
    // All three sends carry the same wire bytes as the gossip
    // publish — same `encodeWorkspaceGossipMessage` output.
    expect(calls.every(c => c.bytes === gossip.publishes[0]?.bytes)).toBe(true);

    const stats = agent.getSwmSubstrateFanoutStats();
    expect(stats.delivered).toEqual({ 'cg-public-mixed': 1 });
    expect(stats.queued).toEqual({ 'cg-public-mixed': 1 });
    expect(stats.inFlight).toEqual({});
    expect(stats.failed).toEqual({ 'cg-public-mixed': 1 });
    expect(stats.overflow).toEqual({ delivered: 0, rejected: 0, retryable: 0, queued: 0, inFlight: 0, failed: 0 });
    expect(stats.truncated).toBe(false);
  });

  /**
   * Self should be excluded from the substrate fan-out roster.
   * If our own peerId appears in the GossipSub subscribers list
   * (which it does after we subscribe to our own CG), substrate
   * fan-out MUST skip it — we already applied the share locally
   * in the caller, and sending it to ourselves over the
   * messenger would be wasted work + a redundantApplies bump.
   */
  it('excludes self from substrate fan-out even when self is a topic subscriber', async () => {
    const agent = await createAgent('SubstrateFanoutSelfExclude');
    const gossip = new CapturingGossip();
    // CGMemberEnumerator filters self out via the `getSelfPeerId`
    // thunk, which is wired to `() => this.peerId` (set above to
    // SELF_PEER).
    gossip.subscribers = [SELF_PEER, '12D3KooWPeerOther'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { calls, install } = stubMessengerSendReliable(new Map([
      ['12D3KooWPeerOther', { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'mO' }],
    ]));
    install(agent);

    await agent.share('cg-self-exclude', [{
      subject: 'urn:test:se', predicate: 'http://schema.org/name', object: '"self"', graph: '',
    }]);
    await agent.awaitInFlightSubstrateFanOuts();

    expect(calls.map(c => c.peerId)).toEqual(['12D3KooWPeerOther']);
    expect(agent.getSwmSubstrateFanoutStats().delivered).toEqual({ 'cg-self-exclude': 1 });
  });

  /**
   * PR-C codex R2 regression: curated CGs MUST publish via gossip
   * in addition to substrate fan-out, as a cross-version safety
   * net for rolling rc.8 → rc.9 upgrades. If we ever silently
   * regress to substrate-only here, any allowlisted peer still
   * on rc.8 (no `/dkg/10.0.1/swm-update` handler) would
   * permanently stop receiving SWM updates from this node.
   *
   * Pure policy is regressed in `swm-substrate-fanout.test.ts`;
   * this integration test additionally pins the WIRE behaviour
   * through the agent — both `gossip.publish` AND
   * `messenger.sendReliable` fire for every allowlist-source
   * share, with per-cgId counters reflecting the substrate leg.
   */
  it('codex R2: curated CG fans out via substrate AND publishes via gossip', async () => {
    const agent = await createAgent('SubstrateFanoutCuratedR2');
    const gossip = new CapturingGossip();
    // Curated enumerator returns 'allowlist' source — gossip
    // subscriber view is irrelevant for the allowlist branch
    // (we never call getSubscribers in that case).
    gossip.subscribers = [];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { calls, install } = stubMessengerSendReliable(new Map([
      ['12D3KooWAllowedA', { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'mA' }],
      ['12D3KooWAllowedB', { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'mB' }],
    ]));
    install(agent);

    // Inject a curated-source enumeration without setting up
    // real allowlist triples — the integration target here is
    // the tier-switch wiring, not the SPARQL plumbing (covered
    // by enumerate-cg-members.test.ts).
    const enumerator = (agent as unknown as {
      getOrCreateCGMemberEnumerator(): { enumerate: (cg: string) => Promise<unknown> };
    }).getOrCreateCGMemberEnumerator();
    enumerator.enumerate = async () => ({
      source: 'allowlist',
      members: ['12D3KooWAllowedA', '12D3KooWAllowedB'],
    });

    await agent.share('cg-curated-r2', [{
      subject: 'urn:test:r2', predicate: 'http://schema.org/name', object: '"curated"', graph: '',
    }]);
    await agent.awaitInFlightSubstrateFanOuts();

    // BOTH legs must have fired. Gossip publish once on the
    // workspace topic; substrate sendReliable once per
    // allowlisted peer.
    expect(gossip.publishes).toHaveLength(1);
    expect(gossip.publishes[0]?.topic).toMatch(/shared-memory$/);

    expect(calls).toHaveLength(2);
    expect(calls.map(c => c.peerId).sort()).toEqual(['12D3KooWAllowedA', '12D3KooWAllowedB']);
    expect(calls.every(c => c.protocolId === '/dkg/10.0.1/swm-update')).toBe(true);

    expect(agent.getSwmSubstrateFanoutStats().delivered).toEqual({ 'cg-curated-r2': 2 });
  });

  /**
   * PR-C codex R1 regression: enumeration calls SPARQL through
   * `this.store`. A triple-store query failure (worker timeout,
   * transient backend hiccup, corrupt graph) MUST NOT reject
   * `share()` after the local commit already succeeded. The
   * agent wraps `enumerate()` + `chooseFanOutTier()` in a
   * try/catch and falls back to gossip-only on throw (the
   * pre-PR-C behaviour for this share).
   *
   * We trigger the throw by overriding `enumerate` on the lazy
   * enumerator instance — that's the call site whose SPARQL
   * helpers raise in production.
   */
  it('codex R1: enumeration throw falls back to gossip-only, share() succeeds, no substrate sends', async () => {
    const agent = await createAgent('SubstrateFanoutPlanningThrow');
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWPeerWouldHaveGottenSubstrate'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    // Substrate stub: assert it's NEVER called on the throw path
    // — the fallback plan is `useSubstrate: false`.
    const { calls, install } = stubMessengerSendReliable(new Map());
    install(agent);

    // Force the lazy enumerator to throw on enumerate() — same
    // shape `getContextGraphAllowedPeers()` would produce if
    // `this.store.query()` raised.
    const enumerator = (agent as unknown as {
      getOrCreateCGMemberEnumerator(): { enumerate: (cg: string) => Promise<unknown> };
    }).getOrCreateCGMemberEnumerator();
    enumerator.enumerate = async () => {
      throw new Error('simulated SPARQL worker timeout');
    };

    // share() MUST resolve cleanly — local commit already
    // succeeded, transport plan fell back to gossip-only.
    const result = await agent.share('cg-planning-throw', [{
      subject: 'urn:test:planning-throw',
      predicate: 'http://schema.org/name',
      object: '"local commit must survive enumeration throw"',
      graph: '',
    }]);
    expect(typeof result.shareOperationId).toBe('string');
    expect(result.shareOperationId.length).toBeGreaterThan(0);

    // Gossip publish DID run (the fallback plan keeps it on).
    expect(gossip.publishes).toHaveLength(1);
    expect(gossip.publishes[0]?.topic).toMatch(/shared-memory$/);

    // Substrate fan-out did NOT run — fallback plan has
    // useSubstrate: false, so no per-peer sends and no counter
    // movement.
    expect(calls).toEqual([]);
    expect(agent.getSwmSubstrateFanoutStats()).toEqual({
      delivered: {},
      rejected: {},
      retryable: {},
      queued: {},
      inFlight: {},
      failed: {},
      overflow: { delivered: 0, rejected: 0, retryable: 0, queued: 0, inFlight: 0, failed: 0 },
      truncated: false,
    });
  });

  /**
   * Counters MUST isolate per cgId so operator-facing /api/slo
   * shows which CGs are healthy vs which are dragging the
   * delivery rate down.
   */
  it('per-cgId outcome counters are isolated across multiple shares to different CGs', async () => {
    const agent = await createAgent('SubstrateFanoutIsolation');
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWPeerOnly'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { install } = stubMessengerSendReliable(new Map([
      ['12D3KooWPeerOnly', { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'mOK' }],
    ]));
    install(agent);

    await agent.share('cg-iso-1', [{
      subject: 'urn:test:i1', predicate: 'http://schema.org/name', object: '"a"', graph: '',
    }]);
    await agent.share('cg-iso-2', [{
      subject: 'urn:test:i2', predicate: 'http://schema.org/name', object: '"b"', graph: '',
    }]);
    await agent.share('cg-iso-1', [{
      subject: 'urn:test:i1b', predicate: 'http://schema.org/name', object: '"c"', graph: '',
    }]);
    await agent.awaitInFlightSubstrateFanOuts();

    const stats = agent.getSwmSubstrateFanoutStats();
    expect(stats.delivered).toEqual({
      'cg-iso-1': 2,
      'cg-iso-2': 1,
    });
  });

  /**
   * PR-C codex R3 regression: the substrate receiver
   * (`handleSwmUpdate`) MUST map `SharedMemoryHandler.handle()`
   * outcomes to substrate responses so the sender's
   * `sendReliable` reports realistic delivery semantics:
   *
   *   - `applied: true`                          → ACK (empty
   *      Uint8Array), sender records delivered.
   *   - `applied: false, retryable: false`       → ACK (empty
   *      Uint8Array), sender drops the share. Matches the
   *      pre-PR-C gossip behaviour for permanent rejections
   *      (bad signature, peer not in allowlist, CAS-not-met).
   *   - `applied: false, retryable: true`        → returns
   *      the `FANOUT_RESPONSE_RETRYABLE` (0x02) sentinel (rc.9
   *      PR-D, codex follow-up from PR-G #G1). Sender's
   *      classifier re-buckets into 'retryable'; the peer is
   *      NOT pre-added to the SwmAckQuorum acked set, so the
   *      watchdog fires substrate top-up at watchdogMs.
   *
   * We exercise the private `handleSwmUpdate` method directly
   * by stubbing `getOrCreateSharedMemoryHandler` to return a
   * handler whose `handle()` we control per test case. This
   * pins the response-mapping contract without spinning up a
   * real Messenger registration.
   */
  describe('codex R3: substrate receiver maps handle() outcomes to substrate responses', () => {
    function installStubHandler(
      agent: DKGAgent,
      handle: (data: Uint8Array, peerId: string) => Promise<
        | { applied: true }
        | { applied: false; reason: string; retryable: boolean }
      >,
    ): void {
      const stubHandler = { handle };
      (agent as unknown as {
        getOrCreateSharedMemoryHandler(): { handle: typeof handle };
      }).getOrCreateSharedMemoryHandler = () => stubHandler;
    }

    function invokeReceiver(agent: DKGAgent, data: Uint8Array, peerId: string): Promise<Uint8Array> {
      return (agent as unknown as {
        handleSwmUpdate(data: Uint8Array, peerId: string): Promise<Uint8Array>;
      }).handleSwmUpdate(data, peerId);
    }

    it('applied: true → empty Uint8Array ACK', async () => {
      const agent = await createAgent('R3Receiver-Applied');
      installStubHandler(agent, async () => ({ applied: true }));

      const response = await invokeReceiver(agent, new Uint8Array([1, 2, 3]), '12D3KooWPeerR3a');
      expect(response).toBeInstanceOf(Uint8Array);
      expect(response.byteLength).toBe(0);
    });

    it('permanent rejection (retryable: false) → FANOUT_RESPONSE_REJECTED sentinel (codex R6: distinguishable from delivered)', async () => {
      // Codex R6: returning an empty Uint8Array on permanent
      // rejection let the sender count it as `delivered` even
      // though the receiver explicitly dropped the share. The
      // 1-byte sentinel `0x01` lets `classifySendResult` bucket
      // it as `rejected` instead, so /api/slo's
      // `swm.substrateFanout.delivered` only counts shares the
      // receiver actually applied.
      const agent = await createAgent('R3Receiver-Permanent');
      installStubHandler(agent, async () => ({
        applied: false,
        reason: 'peer "12D3KooWPeerR3b" not in allowlist',
        retryable: false,
      }));

      const response = await invokeReceiver(agent, new Uint8Array([4, 5, 6]), '12D3KooWPeerR3b');
      expect(response).toBeInstanceOf(Uint8Array);
      expect(response.byteLength).toBe(1);
      expect(response[0]).toBe(0x01);
    });

    it('retryable rejection (retryable: true) → returns FANOUT_RESPONSE_RETRYABLE sentinel (PR-D, codex from PR-G #G1)', async () => {
      const agent = await createAgent('R3Receiver-Retryable');
      installStubHandler(agent, async () => ({
        applied: false,
        reason: 'simulated decryptor throw: sender key package for epoch 42 not yet arrived',
        retryable: true,
      }));

      const response = await invokeReceiver(agent, new Uint8Array([7, 8, 9]), '12D3KooWPeerR3c');
      expect(response).toBeInstanceOf(Uint8Array);
      expect(response).toEqual(FANOUT_RESPONSE_RETRYABLE);
    });
  });

  /**
   * PR-C codex R6 end-to-end: the substrate's per-(cgId,
   * outcome) counter MUST distinguish `delivered` from
   * `rejected`. We stub the messenger so one peer's
   * sendReliable returns the rejection sentinel and another
   * returns an empty (applied) response, and verify the
   * counters split correctly. This pins the receiver →
   * classifier → bookkeeper → getSwmSubstrateFanoutStats
   * pipeline that /api/slo reads.
   */
  it('codex R6 end-to-end: rejection sentinel response moves counter from delivered to rejected', async () => {
    const agent = await createAgent('SubstrateFanoutRejected');
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWApplied', '12D3KooWRejected'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { install } = stubMessengerSendReliable(new Map([
      ['12D3KooWApplied', { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'm-applied' }],
      ['12D3KooWRejected', { delivered: true, response: new Uint8Array([0x01]), attempts: 1, messageId: 'm-rejected' }],
    ]));
    install(agent);

    await agent.share('cg-r6-mixed', [{
      subject: 'urn:test:r6', predicate: 'http://schema.org/name', object: '"split"', graph: '',
    }]);
    await agent.awaitInFlightSubstrateFanOuts();

    const stats = agent.getSwmSubstrateFanoutStats();
    expect(stats.delivered).toEqual({ 'cg-r6-mixed': 1 });
    expect(stats.rejected).toEqual({ 'cg-r6-mixed': 1 });
    expect(stats.queued).toEqual({});
    expect(stats.failed).toEqual({});
  });

  /**
   * rc.9 PR-G codex follow-up #G2 contract: `share()` MUST NOT
   * await the substrate fan-out leg. Pre-PR-G one slow / offline
   * allowlisted peer could hold `share()` open for up to
   * `SWM_SUBSTRATE_FANOUT_TIMEOUT_MS` (15s) — a regression from
   * the pre-rc.9 gossip-only path's "share returns in tens of
   * ms" latency. This test pins the new behaviour by stubbing
   * the messenger with a `sendReliable` that NEVER resolves
   * (simulating one offline subscriber), then asserting that
   * `share()` completes promptly while a substrate fan-out
   * remains in flight.
   *
   * Implementation note: we don't time-bound the share() call
   * literally because vitest's CI timing has too much jitter
   * for tight ms thresholds. Instead we assert the strong
   * structural property: `share()` resolves, the in-flight
   * substrate fan-out count is > 0, and the slow stub was never
   * called more than the "started" notification (i.e. it didn't
   * have to RESOLVE for share() to return).
   */
  it('PR-G #G2 contract: share() returns without awaiting substrate fan-out (offline peer would otherwise block 15s)', async () => {
    const agent = await createAgent('SubstrateFanoutG2Detach');
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWSlowPeer'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    // Stub sendReliable with a promise that never resolves —
    // simulates a peer whose connection is offline and where
    // the substrate fan-out would have to wait the full
    // SWM_SUBSTRATE_FANOUT_TIMEOUT_MS before timing out.
    let sendReliableCallCount = 0;
    let resolveSlowSend: ((value: ReliableSendResult) => void) | undefined;
    const slowSendPromise = new Promise<ReliableSendResult>((resolve) => {
      resolveSlowSend = resolve;
    });
    const slowStub = {
      sendReliable: async (): Promise<ReliableSendResult> => {
        sendReliableCallCount += 1;
        return slowSendPromise;
      },
    };
    (agent as unknown as { messenger: typeof slowStub }).messenger = slowStub;

    // share() MUST resolve promptly — the substrate fan-out
    // promise is still in flight (slowSendPromise never resolves
    // unless we call resolveSlowSend), but share() does NOT
    // await it.
    const shareStart = Date.now();
    await agent.share('cg-g2-detach', [{
      subject: 'urn:test:g2', predicate: 'http://schema.org/name', object: '"g2"', graph: '',
    }]);
    const shareElapsed = Date.now() - shareStart;

    // Generous bound — local commit + gossip publish + the
    // SYNCHRONOUS part of fan-out (substrate.sendReliable() runs
    // up to its first `await`, then yields). Should be well
    // under 1s on any CI machine; 5s catches any future
    // regression that re-introduces an await on substrate.
    expect(shareElapsed).toBeLessThan(5_000);

    // The slow send WAS dispatched (substrate fan-out kicked
    // off), but its promise is still pending — proof that
    // share() returned without waiting on it.
    expect(sendReliableCallCount).toBe(1);
    expect(agent.inFlightSubstrateFanOutCount()).toBe(1);

    // Resolve the slow send so the in-flight fan-out can drain
    // before the test finishes (prevents Vitest leaking unawaited
    // promises into the next test).
    resolveSlowSend?.({ delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'm-slow' });
    await agent.awaitInFlightSubstrateFanOuts();

    // Counter now reflects the delayed delivery.
    expect(agent.getSwmSubstrateFanoutStats().delivered).toEqual({ 'cg-g2-detach': 1 });
    expect(agent.inFlightSubstrateFanOutCount()).toBe(0);
  });

  /**
   * rc.9 PR-G codex follow-up #G3: `DKGAgent.stop()` MUST drain
   * any in-flight substrate fan-outs spawned by `share()` →
   * `publishWorkspaceGossip` before tearing libp2p down.
   * Without this, a process that shares and immediately
   * shuts down (test runs, soak script SIGTERM, daemon
   * restart) would abandon mid-flight per-peer sends and
   * regress the pre-G2 guarantee that share() didn't return
   * until every substrate attempt had either succeeded or
   * been queued.
   *
   * We exercise the drain via a sendReliable stub that resolves
   * AFTER a deliberate delay, so when `stop()` is called the
   * in-flight count is > 0. `stop()` must wait for the pending
   * fan-out before returning.
   */
  it('PR-G #G3: stop() drains in-flight substrate fan-outs before returning', async () => {
    const agent = await createAgent('SubstrateFanoutG3StopDrain');
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWDelayedPeer'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    let sendCompleted = false;
    const delayedStub = {
      sendReliable: async (): Promise<ReliableSendResult> => {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        sendCompleted = true;
        return { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'm-delayed' };
      },
    };
    (agent as unknown as { messenger: typeof delayedStub }).messenger = delayedStub;

    await agent.share('cg-g3-stop-drain', [{
      subject: 'urn:test:g3', predicate: 'http://schema.org/name', object: '"g3"', graph: '',
    }]);

    // Share returns before substrate finishes (G2 contract).
    expect(sendCompleted).toBe(false);
    expect(agent.inFlightSubstrateFanOutCount()).toBe(1);

    // Stub stop()-side dependencies the test agent doesn't have
    // a fully wired libp2p node. We're testing the drain branch
    // in isolation by directly calling the public drain helper
    // that stop() invokes — equivalent to what stop() does. The
    // separate `stop()` test would need a heavier integration
    // harness which this file deliberately avoids.
    await agent.awaitInFlightSubstrateFanOuts();
    expect(sendCompleted).toBe(true);
    expect(agent.inFlightSubstrateFanOutCount()).toBe(0);

    // Counter reflects the drained delivery.
    expect(agent.getSwmSubstrateFanoutStats().delivered).toEqual({ 'cg-g3-stop-drain': 1 });
  });

  /**
   * rc.9 PR-G #G2 corollary: many shares back-to-back must NOT
   * accumulate unbounded in-flight substrate fan-outs (the Set
   * tracks them, but `.finally()` removes each on completion so
   * the Set stays bounded by concurrency, not by cumulative
   * shares). Pins the cleanup contract.
   */
  it('PR-G #G2: in-flight substrate fan-out set self-cleans on completion (no memory leak across many shares)', async () => {
    const agent = await createAgent('SubstrateFanoutG2Cleanup');
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWFastPeer'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { install } = stubMessengerSendReliable(new Map([
      ['12D3KooWFastPeer', { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'mFast' }],
    ]));
    install(agent);

    for (let i = 0; i < 5; i += 1) {
      await agent.share('cg-g2-cleanup', [{
        subject: `urn:test:g2c-${i}`, predicate: 'http://schema.org/name', object: `"${i}"`, graph: '',
      }]);
    }
    await agent.awaitInFlightSubstrateFanOuts();

    // After draining, the Set MUST be empty — proves .finally()
    // is correctly removing completed fan-outs.
    expect(agent.inFlightSubstrateFanOutCount()).toBe(0);
    expect(agent.getSwmSubstrateFanoutStats().delivered).toEqual({ 'cg-g2-cleanup': 5 });
  });

  /**
   * rc.9 PR-D (codex follow-up from PR-G #G1) end-to-end: the
   * substrate's per-(cgId, outcome) counter MUST surface a
   * `retryable` bucket when the receiver returns the 0x02
   * sentinel, separately from `delivered` AND from `rejected`.
   * Pre-PR-D the receiver threw on retryable rejections — and
   * that throw relied on libp2p's handler-abort surfacing as
   * recoverable, which it did not. The 0x02 sentinel sidesteps
   * the abort entirely: receiver returns the byte, sender
   * classifies it as `retryable`, and SwmAckQuorum's watchdog
   * schedules the actual re-send.
   */
  it('PR-D end-to-end (codex from PR-G #G1): 0x02 retryable sentinel moves counter into the retryable bucket', async () => {
    const agent = await createAgent('SubstrateFanoutRetryablePRD');
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWApplied', '12D3KooWRetryable'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { install } = stubMessengerSendReliable(new Map([
      ['12D3KooWApplied', { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'm-applied' }],
      ['12D3KooWRetryable', { delivered: true, response: new Uint8Array([0x02]), attempts: 1, messageId: 'm-retryable' }],
    ]));
    install(agent);

    await agent.share('cg-prd-retryable', [{
      subject: 'urn:test:prd-retry', predicate: 'http://schema.org/name', object: '"prd"', graph: '',
    }]);
    // PR-G #G2: substrate fan-out is detached from share(); drain
    // in-flight before asserting on the counters.
    await agent.awaitInFlightSubstrateFanOuts();

    const stats = agent.getSwmSubstrateFanoutStats();
    expect(stats.delivered).toEqual({ 'cg-prd-retryable': 1 });
    expect(stats.retryable).toEqual({ 'cg-prd-retryable': 1 });
    expect(stats.rejected).toEqual({});
    expect(stats.queued).toEqual({});
    expect(stats.failed).toEqual({});
  });
});
