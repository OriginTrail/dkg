/**
 * rc.9 PR-D integration test for the SwmAckQuorum wiring inside
 * DKGAgent. The component itself is covered by
 * `swm-ack-quorum.test.ts`; this file pins the AGENT-side wiring:
 *
 *   1. `share()` registers tracking when preconditions hold
 *      (shareOperationId set, gossip leg active, substrateMembers
 *      non-empty).
 *   2. PROTOCOL_SWM_SHARE_ACK arrivals route into
 *      `swmAckQuorum.onAck()` and count toward quorum.
 *   3. Pre-acked substrate peers (PR-C delivered set) feed
 *      `preAckedFromSubstrate` so a hybrid share that already met
 *      quorum via substrate doesn't fight a watchdog race.
 *   4. The gossip-applied path of `SharedMemoryHandler.handle()`
 *      emits a SwmShareAck back to the publisher.
 *   5. `getSwmAckQuorumStats()` returns pristine zeroes before any
 *      share, and reflects the right counters after.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  PROTOCOL_SWM_UPDATE,
  PROTOCOL_SWM_SHARE_ACK,
  encodeSwmShareAck,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import type { ReliableSendResult } from '../src/p2p/messenger.js';

const SELF_PEER = '12D3KooWSelfPubD';

class CapturingGossip {
  publishes: Array<{ topic: string; bytes: number }> = [];
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

interface SendReliableCall {
  /**
   * Which messenger method was invoked. rc.9 PR-D codex
   * follow-up #D8: pre-D8 we only tracked `messageId` and
   * relied on it being `undefined` to infer "this was a
   * `sendToPeer` call, not `sendReliable`" — but the
   * production `maybeEmitSwmShareAck` doesn't pass
   * `opts.messageId` to `sendReliable` either, so a
   * regression that re-routed acks back through `sendReliable`
   * would have passed the test. Tracking the method name
   * explicitly fixes the assertion's signal-to-noise.
   */
  method: 'sendReliable' | 'sendToPeer';
  peerId: string;
  protocolId: string;
  bytes: number;
  messageId?: string;
}

/**
 * Stub `messenger.sendReliable` with two extras over the PR-C
 * integration helper:
 *   - Capture `messageId` (we assert top-up uses the documented
 *     `swm-topup-` prefix).
 *   - Default to a successful delivery if the lookup returns
 *     undefined, so ack-quorum top-up calls don't blow up just
 *     because the test only configured the initial fan-out
 *     responses.
 */
function stubMessengerSendReliable(
  results: Map<string, ReliableSendResult> | ((peerId: string, protocolId: string, messageId?: string) => ReliableSendResult | Error),
): { calls: SendReliableCall[]; install: (agent: DKGAgent) => void } {
  const calls: SendReliableCall[] = [];
  const lookup = typeof results === 'function'
    ? results
    : (peerId: string): ReliableSendResult | Error => {
      const r = results.get(peerId);
      if (!r) {
        return {
          delivered: true,
          response: new Uint8Array(),
          attempts: 1,
          messageId: 'stub-default-ok',
        };
      }
      return r;
    };
  const install = (agent: DKGAgent): void => {
    const stub = {
      sendReliable: async (
        peerId: string,
        protocolId: string,
        payload: Uint8Array,
        opts?: { messageId?: string },
      ): Promise<ReliableSendResult> => {
        calls.push({ method: 'sendReliable', peerId, protocolId, bytes: payload.byteLength, messageId: opts?.messageId });
        const out = lookup(peerId, protocolId, opts?.messageId);
        if (out instanceof Error) throw out;
        return out;
      },
      // rc.9 PR-D codex follow-up #D1: ack emission uses
      // fire-and-forget `sendToPeer` instead of durable
      // `sendReliable`. We capture into the same `calls` array
      // (with `method: 'sendToPeer'`) so assertions can
      // distinguish the two surfaces — the `protocolId` alone
      // is not enough since the production `sendReliable` and
      // `sendToPeer` paths both have undefined `messageId` when
      // the caller doesn't pass `opts.messageId` (codex #D8).
      sendToPeer: async (
        peerId: string,
        protocolId: string,
        payload: Uint8Array,
      ): Promise<Uint8Array> => {
        calls.push({ method: 'sendToPeer', peerId, protocolId, bytes: payload.byteLength });
        return new Uint8Array();
      },
      // PR-D registers PROTOCOL_SWM_SHARE_ACK and PR-C registers
      // a deliveredResponseClassifier — stub these as no-ops so
      // DKGAgent's constructor / wiring code doesn't crash when
      // it reaches into the stubbed messenger.
      register: (_proto: string, _handler: (data: Uint8Array, from: string) => Promise<Uint8Array>): void => {},
      setResponseDeliveredClassifier: (_proto: string, _fn: (r: Uint8Array) => boolean): void => {},
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
  Object.defineProperty((agent as unknown as { node: object }).node, 'peerId', {
    value: SELF_PEER,
    configurable: true,
  });
  // PR-J: CGMemberEnumerator now filters topic-subscribers
  // through libp2p reachability (connected OR peerStore-known).
  // These tests don't drive a real libp2p — without a stub the
  // filter would strip every fake-peer subscriber and `track()`
  // would never fire. Treat ALL test peers as dialable; the
  // PR-J test that actually exercises the filter lives in
  // `enumerate-cg-members.test.ts` where it can drive the
  // predicate directly.
  installAllReachableLibp2pStub(agent);
  return agent;
}

/**
 * Install a `node.libp2p` shim that reports test peers as
 * dialable. Matches the pre-PR-J behaviour the integration tests
 * expect — they care about ack-quorum / fan-out wiring, not
 * reachability filtering. The PR-J filter is exercised in
 * `enumerate-cg-members.test.ts` where the predicate is the unit
 * under test.
 *
 * Why a lazy gossip read: PR-J round 2 (codex RED #4) routes the
 * `isPeerDialable` predicate through `peerIdFromString` before
 * `peerStore.get`. Short test peer IDs like `12D3KooWPeerA` are
 * not valid Ed25519 base58 strings, so `peerIdFromString` would
 * throw → catch → false → substrate target subset empties →
 * the whole fan-out stops. We side-step by making `getPeers()`
 * return whatever gossip.subscribers currently contains: the
 * first branch of `isPeerDialable` (`getPeers().some(...)`)
 * matches and short-circuits before peerStore is touched.
 *
 * For tests whose substrate fan-out targets peer IDs NOT in
 * gossip.subscribers (e.g. watchdog-top-up tests with custom
 * `missingPeers`), they can also push into
 * `_extraDialablePeerIds` after install.
 */
function installAllReachableLibp2pStub(agent: DKGAgent): { extraDialablePeerIds: string[] } {
  const extraDialablePeerIds: string[] = [];
  const stub = {
    getPeers: (): Array<{ toString: () => string }> => {
      const gossip = (agent as unknown as { gossip?: { subscribers?: string[] } }).gossip;
      const fromGossip = gossip?.subscribers ?? [];
      const all = [...fromGossip, ...extraDialablePeerIds];
      return all.map((id) => ({ toString: () => id }));
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
  return { extraDialablePeerIds };
}

describe('DKGAgent SwmAckQuorum integration (rc.9 PR-D)', () => {
  let createdAgents: DKGAgent[] = [];

  beforeAll(() => {
    createdAgents = [];
  });

  afterAll(async () => {
    // Stop each created agent so the 5s ack-quorum tick + any
    // other intervals it owns are cleared. The timers use
    // `.unref()` so they wouldn't block process exit, but
    // stopping is the documented contract.
    await Promise.allSettled(createdAgents.map(async (a) => {
      const maybeStop = a as unknown as { stop?: () => Promise<void> };
      if (typeof maybeStop.stop === 'function') {
        try { await maybeStop.stop(); } catch { /* test-shape stub agent */ }
      }
    }));
  });

  function register(agent: DKGAgent): DKGAgent {
    createdAgents.push(agent);
    return agent;
  }

  it('cold-start: getSwmAckQuorumStats returns pristine zeroes', async () => {
    const agent = register(await createAgent('AckQuorumCold'));
    expect(agent.getSwmAckQuorumStats()).toEqual({
      tracked: 0,
      completed: 0,
      watchdogFired: 0,
      deadlineExpired: 0,
      pending: 0,
    });
  });

  it('share() registers tracking after fan-out, substrate-delivered peers pre-ack', async () => {
    const agent = register(await createAgent('AckQuorumTrack'));
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWPeerA', '12D3KooWPeerB', '12D3KooWPeerC'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { install } = stubMessengerSendReliable(new Map([
      ['12D3KooWPeerA', { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'mA' }],
      ['12D3KooWPeerB', { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'mB' }],
      ['12D3KooWPeerC', {
        delivered: false, queued: true, attempts: 1, messageId: 'mC',
        error: 'transient', nextAttemptAtMs: Date.now() + 1000,
      }],
    ]));
    install(agent);

    await agent.share('cg-ackquorum-track', [{
      subject: 'urn:test:track', predicate: 'http://schema.org/name', object: '"hi"', graph: '',
    }]);

    const stats = agent.getSwmAckQuorumStats();
    expect(stats.tracked).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.completed).toBe(0);
  });

  it('substrate-only-delivery reaches quorum at track time (no gossip ack needed)', async () => {
    const agent = register(await createAgent('AckQuorumAllSubstrate'));
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWPeerX', '12D3KooWPeerY'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { install } = stubMessengerSendReliable(new Map([
      ['12D3KooWPeerX', { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'mX' }],
      ['12D3KooWPeerY', { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'mY' }],
    ]));
    install(agent);

    await agent.share('cg-ackquorum-all-substrate', [{
      subject: 'urn:test:all', predicate: 'http://schema.org/name', object: '"all"', graph: '',
    }]);

    const stats = agent.getSwmAckQuorumStats();
    expect(stats.tracked).toBe(1);
    expect(stats.completed).toBe(1);
    expect(stats.pending).toBe(0);
    expect(stats.watchdogFired).toBe(0);
  });

  /**
   * rc.9 PR-D codex follow-up #D7: drive a real
   * `PROTOCOL_SWM_SHARE_ACK` arrival through the production
   * handler and assert that it lands in the quorum's `acked`
   * set, then reaches the `completed` count once the threshold
   * is met. The pre-D7 version of this test only asserted
   * "one share is pending" — a regression in
   * `handleSwmShareAck()` (e.g. failing to call onAck, or
   * dropping ACKs silently) would not have been caught.
   */
  it('PROTOCOL_SWM_SHARE_ACK arrival increments acked count + completes quorum when threshold met', async () => {
    const agent = register(await createAgent('AckQuorumAckArrival'));
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWPeer1', '12D3KooWPeer2', '12D3KooWPeer3'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { install } = stubMessengerSendReliable((_peerId, _proto, _msg) => ({
      delivered: false, queued: true, attempts: 1, messageId: 'queued-' + Math.random().toString(36).slice(2),
      error: 'transient', nextAttemptAtMs: Date.now() + 1000,
    }));
    install(agent);

    const { shareOperationId } = await agent.share('cg-ackquorum-arrivals', [{
      subject: 'urn:test:arr', predicate: 'http://schema.org/name', object: '"arr"', graph: '',
    }]);
    expect(typeof shareOperationId).toBe('string');

    const stats0 = agent.getSwmAckQuorumStats();
    expect(stats0.tracked).toBe(1);
    expect(stats0.completed).toBe(0);
    expect(stats0.pending).toBe(1);

    // Drive the real handler with three real-shape ACK bytes —
    // exactly the same code path that a libp2p arrival would
    // hit. We get the handler via the same test-only getter
    // production registration uses; this test exercises
    // handleSwmShareAck → SwmAckQuorum.onAck without bypassing
    // anything.
    const ackHandler = await agent.getOrCreateSwmShareAckHandlerForTests();
    const inspect = agent.getSwmAckQuorumRecordSnapshotForTests(shareOperationId);
    expect(inspect?.acked).toEqual([]);
    expect([...(inspect?.expectedMembers ?? [])].sort()).toEqual([
      '12D3KooWPeer1', '12D3KooWPeer2', '12D3KooWPeer3',
    ]);

    await ackHandler(encodeSwmShareAck({ shareOperationId, ackPeerId: '12D3KooWPeer1' }), '12D3KooWPeer1');
    expect(agent.getSwmAckQuorumStats().completed).toBe(0);
    expect(agent.getSwmAckQuorumRecordSnapshotForTests(shareOperationId)?.acked).toEqual(['12D3KooWPeer1']);

    await ackHandler(encodeSwmShareAck({ shareOperationId, ackPeerId: '12D3KooWPeer2' }), '12D3KooWPeer2');
    expect(agent.getSwmAckQuorumStats().completed).toBe(0);

    await ackHandler(encodeSwmShareAck({ shareOperationId, ackPeerId: '12D3KooWPeer3' }), '12D3KooWPeer3');
    // 3/3 acked → quorum complete (default quorumPct is 1.0 in
    // the test config; the record is reaped on completion so
    // inspect() returns undefined).
    expect(agent.getSwmAckQuorumStats().completed).toBe(1);
    expect(agent.getSwmAckQuorumRecordSnapshotForTests(shareOperationId)).toBeUndefined();
  });

  it('share() returns shareOperationId — ack arrivals for it complete quorum', async () => {
    const agent = register(await createAgent('AckQuorumWithId'));
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWPeerQ1', '12D3KooWPeerQ2', '12D3KooWPeerQ3', '12D3KooWPeerQ4'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { install } = stubMessengerSendReliable(() => ({
      delivered: false, queued: true, attempts: 1, messageId: 'q-' + Math.random().toString(36).slice(2),
      error: 'transient', nextAttemptAtMs: Date.now() + 1000,
    }));
    install(agent);

    const { shareOperationId } = await agent.share('cg-ackquorum-byid', [{
      subject: 'urn:test:byid', predicate: 'http://schema.org/name', object: '"byid"', graph: '',
    }]);
    expect(typeof shareOperationId).toBe('string');

    const quorum = (agent as unknown as {
      getOrCreateSwmAckQuorum: () => {
        onAck: (op: string, peer: string) => void;
        stats: () => { tracked: number; completed: number; watchdogFired: number; deadlineExpired: number; pending: number };
        inspect: (op: string) => { acked: readonly string[]; expectedMembers: readonly string[]; ackPct: number } | undefined;
      };
    }).getOrCreateSwmAckQuorum();

    expect(quorum.inspect(shareOperationId)?.expectedMembers.sort())
      .toEqual(['12D3KooWPeerQ1', '12D3KooWPeerQ2', '12D3KooWPeerQ3', '12D3KooWPeerQ4']);

    quorum.onAck(shareOperationId, '12D3KooWPeerQ1');
    quorum.onAck(shareOperationId, '12D3KooWPeerQ2');
    quorum.onAck(shareOperationId, '12D3KooWPeerQ3');
    expect(quorum.stats().completed).toBe(0);

    quorum.onAck(shareOperationId, '12D3KooWPeerQ4');
    expect(quorum.stats().completed).toBe(1);
    expect(quorum.inspect(shareOperationId)).toBeUndefined();
  });

  it('legacy callers (no shareOperationId on publishWorkspaceGossip) do not register tracking', async () => {
    const agent = register(await createAgent('AckQuorumLegacy'));
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWLegacyPeer'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { install } = stubMessengerSendReliable(new Map([
      ['12D3KooWLegacyPeer', { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'mL' }],
    ]));
    install(agent);

    const internals = agent as unknown as {
      publishWorkspaceGossip: (cgId: string, msg: Uint8Array, ctx: unknown, signer: unknown) => Promise<void>;
    };
    const dummyMessage = new TextEncoder().encode('not-a-real-wire-message');
    await internals.publishWorkspaceGossip('cg-legacy-caller', dummyMessage, { operationId: 'test' }, null);

    const stats = agent.getSwmAckQuorumStats();
    expect(stats.tracked).toBe(0);
    expect(stats.pending).toBe(0);
  });

  it('SwmShareAck wire shape: handler accepts the same bytes encodeSwmShareAck produces', () => {
    const bytes = encodeSwmShareAck({
      shareOperationId: 'op-roundtrip',
      ackPeerId: '12D3KooWAckRoundtrip',
    });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(PROTOCOL_SWM_SHARE_ACK).toBe('/dkg/10.0.1/swm-share-ack');
    expect(PROTOCOL_SWM_UPDATE).toBe('/dkg/10.0.1/swm-update');
  });

  /**
   * rc.9 PR-D codex follow-up #D1: ack emission MUST use
   * fire-and-forget `sendToPeer`, NOT durable `sendReliable`.
   * Pre-D1 a publisher peer on a build without
   * PROTOCOL_SWM_SHARE_ACK registered would leave a permanently-
   * queued outbox row per received share, retrying protocol
   * negotiation forever. This test pins the call surface: the
   * ack handler exercised here calls `messenger.sendToPeer`,
   * not `messenger.sendReliable`.
   */
  it('PR-D #D1: ack emission uses sendToPeer (fire-and-forget), not sendReliable (durable)', async () => {
    const agent = register(await createAgent('AckQuorumD1FireForget'));
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWPublisher'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { calls, install } = stubMessengerSendReliable(new Map([
      ['12D3KooWPublisher', { delivered: true, response: new Uint8Array(), attempts: 1, messageId: 'm-pub' }],
    ]));
    install(agent);

    // Invoke the ack emit path directly with a synthetic
    // apply-true outcome — bypasses the gossip mesh dance and
    // pins the messenger call shape.
    const emit = (agent as unknown as {
      maybeEmitSwmShareAck: (o: { applied: true; cgId?: string; shareOperationId?: string; publisherPeerId?: string }) => Promise<void>;
    }).maybeEmitSwmShareAck.bind(agent);

    await emit({
      applied: true,
      cgId: 'cg-d1',
      shareOperationId: 'op-d1-fire-forget',
      publisherPeerId: '12D3KooWPublisher',
    });

    const ackCalls = calls.filter((c) => c.protocolId === PROTOCOL_SWM_SHARE_ACK);
    expect(ackCalls).toHaveLength(1);
    expect(ackCalls[0]?.peerId).toBe('12D3KooWPublisher');
    // rc.9 PR-D codex #D8: assert the METHOD explicitly. The
    // pre-D8 assertion checked `messageId === undefined` which
    // would have passed even if the implementation regressed
    // back to `sendReliable(peer, proto, payload, { timeoutMs })`
    // (no opts.messageId → still undefined). Tracking the
    // method name makes the assertion actually pin the
    // fire-and-forget contract.
    expect(ackCalls[0]?.method).toBe('sendToPeer');

    // Additional defense in depth: zero sendReliable calls
    // hit PROTOCOL_SWM_SHARE_ACK. Catches the regression
    // where a future change might call BOTH for some reason.
    const reliableAckCalls = calls.filter(
      (c) => c.protocolId === PROTOCOL_SWM_SHARE_ACK && c.method === 'sendReliable',
    );
    expect(reliableAckCalls).toEqual([]);
  });

  /**
   * rc.9 PR-D codex follow-up #D2: the ack handler MUST trust
   * the libp2p-authenticated `fromPeerId`, NOT the
   * self-asserted `ack.ackPeerId` in the protobuf body. Pre-D2
   * any peer that learned a `shareOperationId` could spoof
   * acks on behalf of other expected members, suppressing
   * watchdog top-up for those members.
   *
   * This test exercises the handler with a body that claims
   * peerB acked while the transport identity is peerA, and
   * asserts:
   *   1. The spoof attempt is dropped (the quorum's `acked` set
   *      gains no entry).
   *   2. Body == transport → the ack lands as expected.
   */
  it('PR-D #D2: ack handler rejects body/transport peerId mismatch (anti-spoof)', async () => {
    const agent = register(await createAgent('AckQuorumD2AntiSpoof'));
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWPeerA', '12D3KooWPeerB', '12D3KooWPeerC'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { install } = stubMessengerSendReliable(() => ({
      delivered: false, queued: true, attempts: 1, messageId: 'q-' + Math.random().toString(36).slice(2),
      error: 'transient', nextAttemptAtMs: Date.now() + 1000,
    }));
    install(agent);

    const { shareOperationId } = await agent.share('cg-d2-antispoof', [{
      subject: 'urn:test:d2', predicate: 'http://schema.org/name', object: '"d2"', graph: '',
    }]);

    const quorum = (agent as unknown as {
      getOrCreateSwmAckQuorum: () => {
        onAck: (op: string, peer: string) => void;
        inspect: (op: string) => { acked: readonly string[]; expectedMembers: readonly string[] } | undefined;
      };
    }).getOrCreateSwmAckQuorum();

    expect(quorum.inspect(shareOperationId)?.acked).toEqual([]);

    // Find the PROTOCOL_SWM_SHARE_ACK handler. We can't intercept
    // the stub's register call (PR-D registers BEFORE the stub
    // is installed), so reach into the real Messenger via the
    // production-side getter that DKGAgent exposes. Test goes
    // through the SAME handler in src/dkg-agent.ts that
    // production traffic hits — that's the whole point.
    const ackHandler = await agent.getOrCreateSwmShareAckHandlerForTests();

    // Spoof attempt: body claims peerB, transport says peerA.
    // Expected: ack DROPPED, acked set unchanged.
    const spoofBytes = encodeSwmShareAck({
      shareOperationId,
      ackPeerId: '12D3KooWPeerB',
    });
    await ackHandler(spoofBytes, '12D3KooWPeerA');
    expect(quorum.inspect(shareOperationId)?.acked).toEqual([]);

    // Honest ack: body matches transport. Expected: lands.
    const honestBytes = encodeSwmShareAck({
      shareOperationId,
      ackPeerId: '12D3KooWPeerA',
    });
    await ackHandler(honestBytes, '12D3KooWPeerA');
    expect(quorum.inspect(shareOperationId)?.acked).toEqual(['12D3KooWPeerA']);

    // Empty body ackPeerId is also accepted — back-compat with
    // a future relayed-ack path where the body field might be
    // omitted intentionally.
    const emptyBodyBytes = encodeSwmShareAck({
      shareOperationId,
      ackPeerId: '',
    });
    await ackHandler(emptyBodyBytes, '12D3KooWPeerC');
    const after = quorum.inspect(shareOperationId)?.acked ?? [];
    expect([...after].sort()).toEqual(['12D3KooWPeerA', '12D3KooWPeerC']);
  });

  /**
   * rc.9 PR-D codex follow-up #D5: the quorum tracker MUST
   * register the share BEFORE substrate + gossip publish so a
   * fast receiver's ack lands against a known shareOperationId
   * instead of getting dropped because the record doesn't
   * exist yet. Pre-D5 the order was:
   *   1. Promise.all([substrate, gossip])    ← waits for both
   *   2. quorum.track(...)                   ← registers AFTER
   * A fast receiver could ack between #1 finishing and #2
   * starting; the handler's `quorum.onAck()` would no-op
   * because the shareOperationId wasn't tracked yet, causing
   * undercounted quorum and spurious watchdog top-up.
   *
   * Easiest exercise: intercept the gossip publish so it spies
   * on whether the quorum record exists at publish time, then
   * assert the record was tracked BEFORE the publish call.
   */
  it('PR-D #D5: quorum record is registered BEFORE gossip publish (no pre-track ack drop race)', async () => {
    const agent = register(await createAgent('AckQuorumD5RaceFix'));
    let recordExistedAtPublishTime: boolean | null = null;
    let capturedShareOperationId: string | null = null;
    const spyingGossip = new CapturingGossip();
    spyingGossip.subscribers = ['12D3KooWPeerRace1', '12D3KooWPeerRace2'];
    const originalPublish = spyingGossip.publish.bind(spyingGossip);
    spyingGossip.publish = async (topic: string, data: Uint8Array): Promise<void> => {
      // Inspect the agent's quorum state right when gossip
      // publish is about to fire. By this point the production
      // code MUST have already called quorum.track() — pre-D5
      // it hadn't.
      const stats = agent.getSwmAckQuorumStats();
      recordExistedAtPublishTime = stats.tracked === 1 && stats.pending === 1;
      await originalPublish(topic, data);
    };
    (agent as unknown as { gossip: CapturingGossip }).gossip = spyingGossip;

    const { install } = stubMessengerSendReliable(() => ({
      delivered: false, queued: true, attempts: 1, messageId: 'q-' + Math.random().toString(36).slice(2),
      error: 'transient', nextAttemptAtMs: Date.now() + 1000,
    }));
    install(agent);

    const { shareOperationId } = await agent.share('cg-d5-race-fix', [{
      subject: 'urn:test:d5', predicate: 'http://schema.org/name', object: '"d5"', graph: '',
    }]);
    capturedShareOperationId = shareOperationId;

    expect(recordExistedAtPublishTime).toBe(true);
    expect(agent.getSwmAckQuorumRecordSnapshotForTests(capturedShareOperationId)).toBeDefined();
  });

  /**
   * rc.9 PR-D codex follow-up #D6: substrate top-up MUST honour
   * the `ReliableSendResult` it gets back from sendReliable —
   * a successful top-up needs to pipe through onAck so the
   * peer counts toward quorum. Pre-D6 the result was awaited
   * and discarded, so a peer the watchdog successfully topped
   * up via substrate would STAY pending until deadlineHardMs
   * (since PROTOCOL_SWM_UPDATE doesn't emit SwmShareAck).
   *
   * Direct exercise of the substrateTopUp callback baked into
   * the lazily-constructed SwmAckQuorum, with a stub messenger
   * that returns each outcome shape so we can pin the
   * classification → onAck wiring for each one.
   */
  it('PR-D #D6: substrate top-up "delivered" outcomes route through onAck (peer counts toward quorum)', async () => {
    const agent = register(await createAgent('AckQuorumD6TopUpOnAck'));
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWTopUpA', '12D3KooWTopUpB', '12D3KooWTopUpC'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    // Initial fan-out: all peers go to the outbox (queued).
    // Watchdog then fires; top-up gets distinct outcomes per
    // peer to pin the per-outcome wiring.
    const { calls, install } = stubMessengerSendReliable((peerId, _proto, _msgId) => {
      const isTopUp = _msgId?.startsWith('swm-topup-');
      if (!isTopUp) {
        return { delivered: false, queued: true, attempts: 1, messageId: 'q-init', error: 'transient', nextAttemptAtMs: Date.now() + 1000 };
      }
      if (peerId === '12D3KooWTopUpA') {
        // empty response → delivered → onAck
        return { delivered: true, response: new Uint8Array(), attempts: 1, messageId: _msgId! };
      }
      if (peerId === '12D3KooWTopUpB') {
        // 0x02 retryable → no onAck; next watchdog tick retries
        return { delivered: true, response: new Uint8Array([0x02]), attempts: 1, messageId: _msgId! };
      }
      // 0x01 rejected → no onAck (permanent)
      return { delivered: true, response: new Uint8Array([0x01]), attempts: 1, messageId: _msgId! };
    });
    install(agent);

    const { shareOperationId } = await agent.share('cg-d6-topup', [{
      subject: 'urn:test:d6', predicate: 'http://schema.org/name', object: '"d6"', graph: '',
    }]);

    // Pre-watchdog: all 3 peers still pending.
    const before = agent.getSwmAckQuorumRecordSnapshotForTests(shareOperationId);
    expect(before?.acked).toEqual([]);

    // Drive the substrateTopUp path directly via the test-only
    // helper. Bypasses the watchdog's setInterval (so the test
    // isn't real-time-flaky) and hits the EXACT method the
    // watchdog wires into createSwmAckQuorum's
    // `substrateTopUp` dep.
    await agent.invokeSwmSubstrateTopUpForTests({
      shareOperationId,
      cgId: 'cg-d6-topup',
      payload: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      missingPeers: ['12D3KooWTopUpA', '12D3KooWTopUpB', '12D3KooWTopUpC'],
    });

    // After top-up: A got `delivered` → routed through onAck;
    // B got 0x02 retryable → NOT onAck'd (will retry next
    // tick); C got 0x01 rejected → NOT onAck'd (permanent).
    const after = agent.getSwmAckQuorumRecordSnapshotForTests(shareOperationId);
    expect(after?.acked).toEqual(['12D3KooWTopUpA']);

    // Sanity: the top-up actually invoked sendReliable for all
    // three peers (with the documented swm-topup- prefix).
    const topUpCalls = calls.filter((c) => c.messageId?.startsWith('swm-topup-'));
    expect(topUpCalls.map((c) => c.peerId).sort()).toEqual([
      '12D3KooWTopUpA',
      '12D3KooWTopUpB',
      '12D3KooWTopUpC',
    ]);
  });

  /**
   * rc.9 PR-D codex follow-up #D3: the ack-quorum tracker MUST
   * also run for the gossip-only-because-too-many-subscribers
   * branch (public CG above the substrate cap). Pre-D3 the
   * track gate required `plan.substrateMembers.length > 0`,
   * which this branch intentionally empties — so the watchdog
   * was silently disabled for the dominant use case for
   * ack-driven reliability.
   *
   * Easiest deterministic exercise: temporarily clamp the
   * substrate-members cap to 1 so a CG with 3 subscribers
   * trips the gossip-only branch. Then assert that
   * `getOrCreateSwmAckQuorum().inspect(...).expectedMembers`
   * includes all 3 — not 0.
   */
  it('PR-D #D3: gossip-only-large-public CGs DO get tracked (watchdog covers them)', async () => {
    const agent = register(await createAgent('AckQuorumD3LargePublic'));
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWBig1', '12D3KooWBig2', '12D3KooWBig3'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    // Clamp the substrate cap so 3 subscribers trip the
    // gossip-only branch.
    (agent as unknown as { swmSubstrateMaxMembers: number }).swmSubstrateMaxMembers = 1;

    const { calls, install } = stubMessengerSendReliable(new Map());
    install(agent);

    const { shareOperationId } = await agent.share('cg-d3-large-public', [{
      subject: 'urn:test:d3', predicate: 'http://schema.org/name', object: '"d3"', graph: '',
    }]);

    // Substrate must NOT have been used (above the clamp).
    const updateCalls = calls.filter((c) => c.protocolId === PROTOCOL_SWM_UPDATE);
    expect(updateCalls).toEqual([]);

    // Pre-D3: this would have been undefined (track was
    // skipped because substrateMembers.length === 0).
    // Post-D3: enumeratedMembers carries the full subscriber
    // list and track() runs against it.
    const quorum = (agent as unknown as {
      getOrCreateSwmAckQuorum: () => {
        inspect: (op: string) => { expectedMembers: readonly string[]; acked: readonly string[] } | undefined;
      };
    }).getOrCreateSwmAckQuorum();

    const record = quorum.inspect(shareOperationId);
    expect(record).toBeDefined();
    expect([...(record?.expectedMembers ?? [])].sort()).toEqual([
      '12D3KooWBig1',
      '12D3KooWBig2',
      '12D3KooWBig3',
    ]);
    // No substrate sends → no pre-acked peers; everyone is
    // pending until a SwmShareAck arrives (or watchdog fires).
    expect(record?.acked).toEqual([]);
  });

  /**
   * PR-H bug 1: when substrate top-up returns the 0x02
   * retryable sentinel, the watchdog MUST be re-armed so the
   * next tick fires another top-up. Pre-PR-H `watchdogFired`
   * stayed `true` after the first fire so the record sat
   * pending until `deadlineHardMs` (5 min) even though the
   * 0x02 sentinel was an explicit "retry later" signal.
   *
   * Exercises the production callback chain via
   * `invokeSwmSubstrateTopUpForTests` (bypassing the 5s
   * setInterval so the test isn't real-time-flaky) and asserts
   * the watchdog state transitions through fire → rearm.
   */
  it('PR-H bug 1: substrate top-up with retryable outcomes re-arms the watchdog', async () => {
    const agent = register(await createAgent('AckQuorumHBug1Rearm'));
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWRetry1', '12D3KooWRetry2'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { install } = stubMessengerSendReliable((_peerId, _proto, msgId) => {
      const isTopUp = msgId?.startsWith('swm-topup-');
      if (!isTopUp) {
        return { delivered: false, queued: true, attempts: 1, messageId: 'q-init', error: 'transient', nextAttemptAtMs: Date.now() + 1000 };
      }
      return { delivered: true, response: new Uint8Array([0x02]), attempts: 1, messageId: msgId! };
    });
    install(agent);

    const { shareOperationId } = await agent.share('cg-h-bug1-rearm', [{
      subject: 'urn:test:hbug1', predicate: 'http://schema.org/name', object: '"hbug1"', graph: '',
    }]);

    const before = agent.getSwmAckQuorumRecordSnapshotForTests(shareOperationId);
    expect(before?.watchdogFired).toBe(false);
    const watchdogArmedAtInitially = before?.watchdogArmedAtMs ?? 0;

    const quorum = (agent as unknown as {
      getOrCreateSwmAckQuorum: () => { tick: (now?: number) => void };
    }).getOrCreateSwmAckQuorum();
    quorum.tick(Date.now() + 30_001);

    await agent.invokeSwmSubstrateTopUpForTests({
      shareOperationId,
      cgId: 'cg-h-bug1-rearm',
      payload: new Uint8Array([0xde, 0xad]),
      missingPeers: ['12D3KooWRetry1', '12D3KooWRetry2'],
    });

    const after = agent.getSwmAckQuorumRecordSnapshotForTests(shareOperationId);
    expect(after).toBeDefined();
    expect(after?.acked).toEqual([]);
    expect(after?.watchdogFired).toBe(false);
    expect(after?.watchdogArmedAtMs).toBeGreaterThanOrEqual(watchdogArmedAtInitially);
  });

  /**
   * PR-H round 2 (codex feedback on #582 bug 2): when the top-up
   * returns ONLY terminal outcomes (delivered + rejected), the
   * rejected peer is dropped from `expectedMembers` instead of
   * lingering and forcing another watchdog top-up. With the
   * denominator shrunk, the single ack from `Final1` now
   * represents 100% of expected (1/1) so the record completes
   * cleanly — no re-arm, no five-minute deadline wait.
   *
   * Pre-round-2 behaviour (kept here for the test name to
   * provide historical context): the rejected peer stayed in
   * `expectedMembers`, `acked = ['Final1']` was only 50%, and
   * since no peer was retryable the watchdog stayed `fired =
   * true` until `deadlineHardMs` reaped the record. The new
   * behaviour is strictly an improvement (avoids the 5-min
   * wall-clock wait for a share that already has all the acks
   * it can ever get).
   */
  it('PR-H bug 2: top-up with terminal outcomes (delivered + rejected) completes via dropPeer instead of stalling until deadline', async () => {
    const agent = register(await createAgent('AckQuorumHBug2DropPeer'));
    const gossip = new CapturingGossip();
    gossip.subscribers = ['12D3KooWFinal1', '12D3KooWFinal2'];
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { install } = stubMessengerSendReliable((peerId, _proto, msgId) => {
      const isTopUp = msgId?.startsWith('swm-topup-');
      if (!isTopUp) {
        return { delivered: false, queued: true, attempts: 1, messageId: 'q-init', error: 'transient', nextAttemptAtMs: Date.now() + 1000 };
      }
      if (peerId === '12D3KooWFinal1') return { delivered: true, response: new Uint8Array(), attempts: 1, messageId: msgId! };
      return { delivered: true, response: new Uint8Array([0x01]), attempts: 1, messageId: msgId! };
    });
    install(agent);

    const { shareOperationId } = await agent.share('cg-h-bug2-dropper', [{
      subject: 'urn:test:hbug2', predicate: 'http://schema.org/name', object: '"hbug2"', graph: '',
    }]);

    const quorum = (agent as unknown as {
      getOrCreateSwmAckQuorum: () => { tick: (now?: number) => void; stats: () => { completed: number; pending: number } };
    }).getOrCreateSwmAckQuorum();
    quorum.tick(Date.now() + 30_001);

    await agent.invokeSwmSubstrateTopUpForTests({
      shareOperationId,
      cgId: 'cg-h-bug2-dropper',
      payload: new Uint8Array([0xde, 0xad]),
      missingPeers: ['12D3KooWFinal1', '12D3KooWFinal2'],
    });

    // The record completed and was removed from tracking. Snapshot
    // returns undefined; stats show the completion counter ticked.
    const after = agent.getSwmAckQuorumRecordSnapshotForTests(shareOperationId);
    expect(after).toBeUndefined();
    expect(quorum.stats().completed).toBe(1);
    expect(quorum.stats().pending).toBe(0);
  });

  /**
   * PR-H bug 2: late substrate deliveries (peers that started
   * as queued/inFlight on the synchronous fan-out and were
   * delivered LATER by the outbox) MUST reach the quorum. The
   * fix is for receivers to emit SwmShareAck on substrate
   * apply too — symmetric with the gossip-apply path. Pre-PR-H
   * only the gossip path emitted, so outbox-delivered peers
   * never ack'd and stayed pending until deadlineHardMs even
   * though the share had actually applied.
   */
  it('PR-H bug 2: handleSwmUpdate emits SwmShareAck on substrate-applied shares (late deliveries reach quorum)', async () => {
    const agent = register(await createAgent('AckQuorumHBug2SubstrateAck'));
    const gossip = new CapturingGossip();
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { calls, install } = stubMessengerSendReliable(new Map());
    install(agent);

    const wh = (agent as unknown as {
      getOrCreateSharedMemoryHandler: () => { handle: (data: Uint8Array, from: string) => Promise<unknown> };
    }).getOrCreateSharedMemoryHandler();
    const origHandle = wh.handle.bind(wh);
    wh.handle = async () => ({
      applied: true,
      cgId: 'cg-h-bug2',
      shareOperationId: 'op-h-bug2-late-delivery',
      publisherPeerId: '12D3KooWPublisherLate',
    });

    try {
      const handler = (agent as unknown as {
        handleSwmUpdate: (data: Uint8Array, from: string) => Promise<Uint8Array>;
      }).handleSwmUpdate.bind(agent);

      const response = await handler(new Uint8Array([0x01, 0x02, 0x03]), '12D3KooWSenderForLate');
      expect(response).toEqual(new Uint8Array());

      await new Promise((r) => setTimeout(r, 5));

      const ackCalls = calls.filter((c) => c.protocolId === PROTOCOL_SWM_SHARE_ACK);
      expect(ackCalls).toHaveLength(1);
      expect(ackCalls[0]?.peerId).toBe('12D3KooWPublisherLate');
      expect(ackCalls[0]?.method).toBe('sendToPeer');
    } finally {
      wh.handle = origHandle;
    }
  });

  /**
   * PR-H bug 2 negative case: when `handleSwmUpdate` returns
   * `applied: false` (retryable OR permanent rejection), it
   * MUST NOT emit a SwmShareAck — only successful applies ack.
   */
  it('PR-H bug 2: handleSwmUpdate does NOT emit SwmShareAck on rejected (retryable or permanent) substrate shares', async () => {
    const agent = register(await createAgent('AckQuorumHBug2NoAckOnReject'));
    const gossip = new CapturingGossip();
    (agent as unknown as { gossip: CapturingGossip }).gossip = gossip;

    const { calls, install } = stubMessengerSendReliable(new Map());
    install(agent);

    const wh = (agent as unknown as {
      getOrCreateSharedMemoryHandler: () => { handle: (data: Uint8Array, from: string) => Promise<unknown> };
    }).getOrCreateSharedMemoryHandler();
    const origHandle = wh.handle.bind(wh);

    try {
      wh.handle = async () => ({ applied: false, retryable: true, reason: 'transient apply error' });
      const handler = (agent as unknown as {
        handleSwmUpdate: (data: Uint8Array, from: string) => Promise<Uint8Array>;
      }).handleSwmUpdate.bind(agent);
      const retryResp = await handler(new Uint8Array([0x01]), '12D3KooWSenderRetry');
      expect(retryResp).toEqual(new Uint8Array([0x02]));

      wh.handle = async () => ({ applied: false, retryable: false, reason: 'bad signature' });
      const rejectResp = await handler(new Uint8Array([0x02]), '12D3KooWSenderReject');
      expect(rejectResp).toEqual(new Uint8Array([0x01]));

      await new Promise((r) => setTimeout(r, 5));

      const ackCalls = calls.filter((c) => c.protocolId === PROTOCOL_SWM_SHARE_ACK);
      expect(ackCalls).toEqual([]);
    } finally {
      wh.handle = origHandle;
    }
  });
});
