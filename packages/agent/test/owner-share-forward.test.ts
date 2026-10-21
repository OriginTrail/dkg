// SPDX-License-Identifier: Apache-2.0

/**
 * A Core passing a member's signed share on to the graph's owner, and the
 * owner's checks of the bytes (`swm/owner-share-forward.ts`): which shares go,
 * to whom, how often, what the owner refuses before it reads its state, and
 * how often it applies copies of one share.
 * The agent's wiring is in `relayed-swm-share-receive.test.ts`; the whole path
 * between nodes in `e2e-swm-relay-only-owner-via-core.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeGossipEnvelope,
  encodeGossipEnvelope,
  GOSSIP_ENVELOPE_FRESHNESS_MS,
} from '@origintrail-official/dkg-core';
import {
  checkRelayedShare,
  graphHasAllowlist,
  OWNER_FORWARD_DEDUPE_TTL_MS,
  OWNER_FORWARD_MAX_PEERS,
  OwnerShareForwarder,
  RELAYED_SHARE_APPLIED_TTL_MS,
  RELAYED_SHARE_FUTURE_SKEW_MS,
  RELAYED_SHARE_RATE_PER_MINUTE,
  RelayedShareApplies,
  RelayedShareRateLimit,
  relayedShareKey,
  shareEnvelopeKind,
  shouldForwardShareToOwner,
  type OwnerForwardAnswer,
  type OwnerForwardFacts,
  type OwnerShareForwardPorts,
} from '../src/swm/owner-share-forward.js';
import {
  AUTHOR,
  RELAYED_CG,
  REPORTS,
  STRANGER,
  encryptedPayload,
  relayedShare,
  relayedShareRequest,
  senderKeyPayload,
  signedEnvelope,
  unsignedEnvelope,
} from './_helpers/relayed-share-fixtures.js';

const MEMBER = '12D3KooWMemberThatShared';
const SELF = '12D3KooWTheCoreItself';
const OWNER_A = '12D3KooWOwnerNodeA';
const OWNER_B = '12D3KooWOwnerNodeB';
const OWNER_C = '12D3KooWOwnerNodeC';

describe('shouldForwardShareToOwner', () => {
  async function facts(overrides: Partial<OwnerForwardFacts> = {}): Promise<OwnerForwardFacts> {
    return {
      nodeRole: 'core',
      hosted: true,
      subscribed: false,
      subGraphName: REPORTS,
      shareOperationId: 'op-1',
      publisherPeerId: MEMBER,
      fromPeerId: MEMBER,
      wire: await relayedShare(),
      ...overrides,
    };
  }
  const open = { ownerIsLocal: () => false, publicWithoutAllowlist: async () => true };

  it('forwards a member\'s signed share into a named sub-graph of a public graph a Core hosts or subscribes to', async () => {
    expect(await shouldForwardShareToOwner(await facts(), open)).toBe(true);
    expect(await shouldForwardShareToOwner(await facts({ hosted: false, subscribed: true }), open)).toBe(true);
  });

  it.each([
    ['on an Edge', { nodeRole: 'edge' as const }],
    ['on a node of unknown role', { nodeRole: undefined }],
    ['for a graph the Core neither hosts nor subscribes to', { hosted: false, subscribed: false }],
    ['for a share into the root', { subGraphName: null }],
    ['for a share without an operation id', { shareOperationId: undefined }],
    ['past the first hop', { fromPeerId: '12D3KooWAnotherCore' }],
    ['for a share without a publisher', { publisherPeerId: undefined }],
  ])('never forwards %s', async (_label, overrides) => {
    expect(await shouldForwardShareToOwner(await facts(overrides), open)).toBe(false);
  });

  it('never forwards a sender-key, encrypted or unsigned share, or bytes that are no envelope', async () => {
    for (const wire of [
      await signedEnvelope(senderKeyPayload()),
      await signedEnvelope(encryptedPayload()),
      unsignedEnvelope(await relayedShareRequest()),
      new Uint8Array([1, 2, 3]),
    ]) {
      expect(await shouldForwardShareToOwner(await facts({ wire }), open)).toBe(false);
    }
  });

  it('never forwards when the owner is on this node, or the graph is private or has an allowlist; the store is read last', async () => {
    const asked: string[] = [];
    expect(await shouldForwardShareToOwner(await facts(), {
      ownerIsLocal: () => { asked.push('owner'); return true; },
      publicWithoutAllowlist: async () => { asked.push('policy'); return true; },
    })).toBe(false);
    expect(asked).toEqual(['owner']);
    expect(await shouldForwardShareToOwner(await facts(), { ownerIsLocal: () => false, publicWithoutAllowlist: async () => false })).toBe(false);
    asked.length = 0;
    expect(await shouldForwardShareToOwner(await facts({ nodeRole: 'edge' }), {
      ownerIsLocal: () => { asked.push('owner'); return false; },
      publicWithoutAllowlist: async () => { asked.push('policy'); return true; },
    })).toBe(false);
    expect(asked).toEqual([]);
  });
});

describe('shareEnvelopeKind and graphHasAllowlist', () => {
  it('names each kind of share bytes', async () => {
    expect(shareEnvelopeKind(await relayedShare())).toBe('signed-plain');
    expect(shareEnvelopeKind(await signedEnvelope(senderKeyPayload()))).toBe('sender-key');
    expect(shareEnvelopeKind(await signedEnvelope(encryptedPayload()))).toBe('encrypted');
    expect(shareEnvelopeKind(unsignedEnvelope(await relayedShareRequest()))).toBe('unsigned');
    expect(shareEnvelopeKind(await relayedShareRequest())).toBe('other');
    expect(shareEnvelopeKind(new Uint8Array([0xff, 0xff, 0xff]))).toBe('other');
  });

  it('sees a peer or an agent allowlist', () => {
    expect(graphHasAllowlist({ allowedPeers: [], allowedAgents: [] })).toBe(false);
    expect(graphHasAllowlist({ allowedPeers: ['12D3KooWPeer'], allowedAgents: [] })).toBe(true);
    expect(graphHasAllowlist({ allowedPeers: [], allowedAgents: [AUTHOR.address] })).toBe(true);
  });
});

interface Send {
  readonly peerId: string;
  readonly wire: Uint8Array;
  readonly timeoutMs: number;
}

/** A Core's forwarder with its owner lookup, connections and sends set by the test. */
function forwarderHost(options: { maxInFlight?: number; lookupTimeoutMs?: number } = {}) {
  let now = 1_000_000;
  const state = {
    owners: [OWNER_A] as readonly string[],
    connected: new Set([OWNER_A, OWNER_B, OWNER_C, MEMBER]),
    lookups: 0,
    lookupHangs: false,
    selfFails: false,
    answer: async (_peerId: string, _signal: AbortSignal): Promise<OwnerForwardAnswer> => 'applied',
  };
  const sends: Send[] = [];
  const logs: string[] = [];
  const ports: OwnerShareForwardPorts = {
    ownerPeers: async (_contextGraphId, signal) => {
      state.lookups += 1;
      if (state.lookupHangs) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('lookup aborted')), { once: true });
        });
      }
      return state.owners;
    },
    isConnected: (peerId) => state.connected.has(peerId),
    selfPeerId: () => {
      if (state.selfFails) throw new Error('peer id unavailable');
      return SELF;
    },
    send: async (peerId, wire, sendOptions) => {
      sends.push({ peerId, wire, timeoutMs: sendOptions.timeoutMs });
      return state.answer(peerId, sendOptions.signal);
    },
    logDebug: (message) => { logs.push(message); },
  };
  const forwarder = new OwnerShareForwarder(ports, { now: () => now, ...options });
  return {
    forwarder,
    state,
    sends,
    logs,
    advance: (ms: number) => { now += ms; },
  };
}

describe('OwnerShareForwarder', () => {
  const share = async (shareOperationId = 'op-1', fromPeerId = MEMBER) => ({
    contextGraphId: RELAYED_CG,
    shareOperationId,
    fromPeerId,
    wire: await relayedShare({ shareOperationId }),
  });

  it('sends the share\'s bytes, unchanged, to the owner\'s connected peer with a bounded deadline', async () => {
    const host = forwarderHost();
    const forwarded = await share();

    host.forwarder.forward(forwarded);
    await host.forwarder.settled();

    expect(host.sends.map(({ peerId }) => peerId)).toEqual([OWNER_A]);
    expect(host.sends[0]!.wire).toBe(forwarded.wire);
    expect(host.sends[0]!.timeoutMs).toBe(10_000);
    expect(host.forwarder.appliedCount(RELAYED_CG, 'op-1')).toBe(1);
  });

  it('sends to connected owner peers only, never to the sender or to itself, and to at most two', async () => {
    const host = forwarderHost();
    host.state.owners = [SELF, MEMBER, OWNER_A, OWNER_B, OWNER_C, OWNER_A];

    host.forwarder.forward(await share());
    await host.forwarder.settled();

    expect(host.sends.map(({ peerId }) => peerId).sort()).toEqual([OWNER_A, OWNER_B]);
    expect(OWNER_FORWARD_MAX_PEERS).toBe(2);
  });

  it('sends nothing, and logs it, when no owner peer is connected', async () => {
    const host = forwarderHost();
    host.state.connected = new Set([MEMBER]);

    host.forwarder.forward(await share());
    await host.forwarder.settled();

    expect(host.sends).toEqual([]);
    expect(host.logs.join('\n')).toContain('no connected owner peer');
  });

  it('sends each (graph, operation, peer) once, also when the share is applied again by another path', async () => {
    const host = forwarderHost();
    const forwarded = await share();

    host.forwarder.forward(forwarded);
    host.forwarder.forward(forwarded);
    await host.forwarder.settled();
    host.forwarder.forward(forwarded);
    await host.forwarder.settled();
    host.forwarder.forward(await share('op-2'));
    await host.forwarder.settled();

    expect(host.sends.map(({ peerId }) => peerId)).toEqual([OWNER_A, OWNER_A]);
    expect(host.forwarder.appliedCount(RELAYED_CG, 'op-1')).toBe(1);
    expect(host.forwarder.appliedCount(RELAYED_CG, 'op-2')).toBe(1);
    // The memory of a send ends after its time.
    host.advance(OWNER_FORWARD_DEDUPE_TTL_MS);
    host.forwarder.forward(forwarded);
    await host.forwarder.settled();
    expect(host.sends).toHaveLength(3);
  });

  it('remembers a refusal as a send, without counting it as applied', async () => {
    const host = forwarderHost();
    host.state.answer = async () => 'refused';
    const forwarded = await share();

    host.forwarder.forward(forwarded);
    await host.forwarder.settled();
    host.forwarder.forward(forwarded);
    await host.forwarder.settled();

    expect(host.sends).toHaveLength(1);
    expect(host.forwarder.appliedCount(RELAYED_CG, 'op-1')).toBe(0);
  });

  it('neither remembers nor retries a failed send: an owner without the protocol gets one attempt, logged at debug', async () => {
    const host = forwarderHost();
    host.state.answer = async () => { throw new Error('protocol selection failed'); };
    const forwarded = await share();

    host.forwarder.forward(forwarded);
    await host.forwarder.settled();
    host.advance(60_000);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(host.sends).toHaveLength(1);
    expect(host.logs.join('\n')).toContain('protocol selection failed');
    expect(host.forwarder.inFlight).toBe(0);
    // A later apply of the same share is a new attempt; nothing was queued.
    host.state.answer = async () => 'applied';
    host.forwarder.forward(forwarded);
    await host.forwarder.settled();
    expect(host.sends).toHaveLength(2);
    expect(host.forwarder.appliedCount(RELAYED_CG, 'op-1')).toBe(1);
  });

  it('keeps one lookup of a graph\'s owner for a while, and takes a slow lookup as no owner', async () => {
    const host = forwarderHost();
    host.forwarder.forward(await share('op-1'));
    await host.forwarder.settled();
    host.forwarder.forward(await share('op-2'));
    await host.forwarder.settled();
    expect(host.state.lookups).toBe(1);

    const slow = forwarderHost({ lookupTimeoutMs: 20 });
    slow.state.lookupHangs = true;
    slow.forwarder.forward(await share());
    await slow.forwarder.settled();
    expect(slow.sends).toEqual([]);
  });

  it('drops a forward beyond the sends in flight, with a debug line', async () => {
    const host = forwarderHost({ maxInFlight: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    host.state.answer = async () => { await held; return 'applied'; };

    host.forwarder.forward(await share('op-1'));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(host.forwarder.inFlight).toBe(1);
    host.forwarder.forward(await share('op-2'));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    release();
    await host.forwarder.settled();

    expect(host.sends.map(({ peerId }) => peerId)).toEqual([OWNER_A]);
    expect(host.logs.join('\n')).toContain('1 sends in flight');
    expect(host.forwarder.appliedCount(RELAYED_CG, 'op-2')).toBe(0);
  });

  it('aborts the sends in flight at stop, settles, and takes no forward after it', async () => {
    const host = forwarderHost();
    host.state.answer = async (_peerId, signal) => new Promise<OwnerForwardAnswer>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted at stop')), { once: true });
    });

    host.forwarder.forward(await share('op-1'));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(host.forwarder.inFlight).toBe(1);
    host.forwarder.stop();
    await host.forwarder.settled();
    host.forwarder.forward(await share('op-2'));
    await host.forwarder.settled();

    expect(host.sends).toHaveLength(1);
    expect(host.forwarder.inFlight).toBe(0);
    expect(host.logs.join('\n')).toContain('aborted at stop');
  });

  it('sends nothing when it stopped during the owner lookup', async () => {
    const host = forwarderHost();
    host.forwarder.forward(await share());
    host.forwarder.stop();
    await host.forwarder.settled();

    expect(host.sends).toEqual([]);
  });

  it('logs a forward that failed outside a send', async () => {
    const host = forwarderHost();
    host.state.selfFails = true;

    host.forwarder.forward(await share());
    await host.forwarder.settled();

    expect(host.sends).toEqual([]);
    expect(host.logs.join('\n')).toContain('not passed on to its owner: peer id unavailable');
  });
});

describe('checkRelayedShare', () => {
  const now = () => Date.now();

  it('accepts the author\'s fresh signature over a plain share into a named sub-graph', async () => {
    const check = checkRelayedShare(await relayedShare(), now());
    expect(check).toMatchObject({ ok: true, contextGraphId: RELAYED_CG, subGraphName: REPORTS, shareOperationId: 'op-a-report' });
    expect(check.ok ? check.author.toLowerCase() : '').toBe(AUTHOR.address.toLowerCase());
  });

  it('accepts an envelope up to the freshness window old, and a little ahead of the clock', async () => {
    const signedAt = new Date(Date.now() - GOSSIP_ENVELOPE_FRESHNESS_MS + 5_000);
    expect(checkRelayedShare(await relayedShare({ signedAt }), now()).ok).toBe(true);
    const ahead = new Date(Date.now() + RELAYED_SHARE_FUTURE_SKEW_MS - 5_000);
    expect(checkRelayedShare(await relayedShare({ signedAt: ahead }), now()).ok).toBe(true);
  });

  async function reasonOf(bytes: Uint8Array): Promise<string> {
    const check = checkRelayedShare(bytes, now());
    return check.ok ? 'accepted' : check.reason;
  }

  it.each([
    ['an envelope older than five minutes', async () => relayedShare({ signedAt: new Date(Date.now() - GOSSIP_ENVELOPE_FRESHNESS_MS - 1_000) }), /freshness window/],
    ['an envelope from the future', async () => relayedShare({ signedAt: new Date(Date.now() + RELAYED_SHARE_FUTURE_SKEW_MS + 5_000) }), /freshness window/],
    ['an unsigned envelope', async () => unsignedEnvelope(await relayedShareRequest()), /unsigned/],
    ['a sender-key payload', async () => signedEnvelope(senderKeyPayload()), /sender-key/],
    ['an encrypted payload', async () => signedEnvelope(encryptedPayload()), /encrypted/],
    ['bytes that are no envelope', async () => relayedShareRequest(), /other/],
    ['a share into the root', async () => relayedShare({ request: { subGraphName: '' } }), /root scope/],
    ['a share signed by another than its asset author', async () => relayedShare({ signer: STRANGER }), /not the asset author/],
    ['a share naming two authors', async () => relayedShare({ request: { agentAddress: STRANGER.address.toLowerCase() } }), /two authors/],
    ['a share without an asset scope', async () => relayedShare({ request: { kaUal: 'not-a-ual' } }), /no asset scope/],
    ['a payload naming another graph', async () => signedEnvelope(await relayedShareRequest({ contextGraphId: `${RELAYED_CG}-other` })), /another graph/],
  ])('refuses %s', async (_label, bytes, reason) => {
    expect(await reasonOf(await bytes())).toMatch(reason);
  });

  it('refuses an envelope without a valid timestamp, and a payload that is no share request', async () => {
    const envelope = decodeGossipEnvelope(await relayedShare());
    expect(await reasonOf(encodeGossipEnvelope({ ...envelope, timestamp: 'yesterday' }))).toMatch(/no valid timestamp/);
    const garbage = await signedEnvelope(new Uint8Array([0x0a, 0xff, 0xff, 0xff, 0xff]));
    expect(await reasonOf(garbage)).toMatch(/not a share request|other/);
  });

  it('refuses tampered bytes and a signature that is not the signer\'s', async () => {
    const envelope = decodeGossipEnvelope(await relayedShare());
    const tampered = encodeGossipEnvelope({ ...envelope, payload: await relayedShareRequest({ value: 'another report' }) });
    expect(await reasonOf(tampered)).toMatch(/signature is not the signer's/);
    const broken = encodeGossipEnvelope({ ...envelope, signature: new Uint8Array([1, 2, 3]) });
    expect(await reasonOf(broken)).toMatch(/does not verify/);
  });
});

describe('RelayedShareRateLimit', () => {
  it('allows a sender its shares per minute, then refuses until the next minute', () => {
    let now = 0;
    const limit = new RelayedShareRateLimit(RELAYED_SHARE_RATE_PER_MINUTE, () => now);
    for (let index = 0; index < RELAYED_SHARE_RATE_PER_MINUTE; index += 1) expect(limit.allow('12D3KooWCoreA')).toBe(true);
    expect(limit.allow('12D3KooWCoreA')).toBe(false);
    expect(limit.allow('12D3KooWCoreB')).toBe(true);
    now += 60_000;
    expect(limit.allow('12D3KooWCoreA')).toBe(true);
  });
});

describe('RelayedShareApplies', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('keys a share by its graph, its operation and its exact bytes', async () => {
    const wire = await relayedShare();
    const resigned = await relayedShare({ signedAt: new Date(Date.now() - 1_000) });

    expect(relayedShareKey(RELAYED_CG, 'op-a-report', wire)).toBe(relayedShareKey(RELAYED_CG, 'op-a-report', Uint8Array.from(wire)));
    expect(new Set([
      relayedShareKey(RELAYED_CG, 'op-a-report', wire),
      relayedShareKey(RELAYED_CG, 'op-a-report', resigned),
      relayedShareKey(RELAYED_CG, 'op-other', wire),
      relayedShareKey(`${RELAYED_CG}-other`, 'op-a-report', wire),
    ]).size).toBe(4);
  });

  it('remembers an applied share for the whole window in which a copy passes the byte checks', () => {
    expect(RELAYED_SHARE_APPLIED_TTL_MS).toBe(GOSSIP_ENVELOPE_FRESHNESS_MS + RELAYED_SHARE_FUTURE_SKEW_MS);
  });

  it('applies copies that come at once, or later within the window, once', async () => {
    let now = 0;
    const applies = new RelayedShareApplies({ now: () => now });
    const gate = deferred<boolean>();
    let runs = 0;
    const apply = () => { runs += 1; return gate.promise; };

    const copies = [applies.once('k', apply), applies.once('k', apply), applies.once('k', apply)];
    gate.resolve(true);

    expect(await Promise.all(copies)).toEqual(['applied', 'applied-before', 'applied-before']);
    now = RELAYED_SHARE_APPLIED_TTL_MS - 1;
    expect(await applies.once('k', apply)).toBe('applied-before');
    expect(runs).toBe(1);
    expect(await applies.once('other', async () => true)).toBe('applied');
  });

  it('applies a copy again once the window has passed', async () => {
    let now = 0;
    const applies = new RelayedShareApplies({ now: () => now });
    let runs = 0;
    const apply = async () => { runs += 1; return true; };

    expect(await applies.once('k', apply)).toBe('applied');
    now = RELAYED_SHARE_APPLIED_TTL_MS;
    expect(await applies.once('k', apply)).toBe('applied');
    expect(runs).toBe(2);
  });

  it('remembers no refusal: the copies that waited are refused, and the next copy is applied in full', async () => {
    const applies = new RelayedShareApplies();
    const gate = deferred<boolean>();
    let runs = 0;

    const copies = [
      applies.once('k', () => { runs += 1; return gate.promise; }),
      applies.once('k', async () => { runs += 1; return true; }),
    ];
    gate.resolve(false);

    expect(await Promise.all(copies)).toEqual(['refused', 'refused']);
    expect(await applies.once('k', async () => { runs += 1; return true; })).toBe('applied');
    expect(runs).toBe(2);
  });

  it('remembers no error: the copies that waited get it, and the next copy is applied in full', async () => {
    const applies = new RelayedShareApplies();
    const gate = deferred<boolean>();

    const first = applies.once('k', () => gate.promise);
    const waiting = applies.once('k', async () => true);
    gate.reject(new Error('store closed'));

    await expect(first).rejects.toThrow('store closed');
    await expect(waiting).rejects.toThrow('store closed');
    expect(await applies.once('k', async () => true)).toBe('applied');
  });

  it('remembers at most its bound of applied shares, dropping the oldest', async () => {
    const applies = new RelayedShareApplies({ maxEntries: 2 });
    let runs = 0;
    const apply = async () => { runs += 1; return true; };

    for (const key of ['a', 'b', 'c']) await applies.once(key, apply);
    expect(await applies.once('c', apply)).toBe('applied-before');
    expect(await applies.once('a', apply)).toBe('applied');
    expect(runs).toBe(4);
  });
});
