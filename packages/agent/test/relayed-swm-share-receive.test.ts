// SPDX-License-Identifier: Apache-2.0

/**
 * A member's signed share that a Core passes on to the graph's owner, through
 * the agent's own methods: the Core's forward right after it applied the share,
 * the owner's receipt on the relayed protocol, and both together. The owner
 * applies the share with a real share handler and store, so the author seal and
 * the share-complete record are the handler's own. Each agent is a bare host:
 * its role, connections, subscriptions, policy reads and sends are set by the
 * test. The forwarder and the byte checks alone are in
 * `owner-share-forward.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DKG_GOSSIP_MAX_RPC_BYTES,
  PROTOCOL_SWM_CHANGE_NOTICE,
  PROTOCOL_SWM_UPDATE_RELAYED,
  TypedEventBus,
  assertionLifecycleUri,
  contextGraphMetaUri,
  decodeGossipEnvelope,
  encodeGossipEnvelope,
  GOSSIP_ENVELOPE_FRESHNESS_MS,
  type ContextGraphIdV1,
} from '@origintrail-official/dkg-core';
import { SharedMemoryHandler } from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';
import { resolveDurableGraphScopedAuthorSealCandidateV1 } from '../src/durable-author-seal-resolver-v1.js';
import { SWM_CHANGE_NOTICE_MAX_BYTES } from '../src/swm/shared-memory-change-notice.js';
import { FANOUT_RESPONSE_REJECTED } from '../src/swm/substrate-fanout.js';
import { SWM_SHARE_COMPLETE_PRED } from '../../publisher/src/shared-memory-author-seal.js';
import {
  AUTHOR,
  OWNER_WALLET,
  RELAYED_CG,
  REPORTS,
  SECOND_AUTHOR,
  STRANGER,
  SUBJECT_PREDICATE,
  encryptedPayload,
  relayedShare,
  relayedShareRequest,
  senderKeyPayload,
  signedEnvelope,
  subjectOf,
  unsignedEnvelope,
} from './_helpers/relayed-share-fixtures.js';

const OWNER_PEER = '12D3KooWOwnerOfTheGraph';
const CORE_A = '12D3KooWCoreThatHostsTheGraph';
const CORE_B = '12D3KooWSecondCoreOfTheGraph';
const CORE_C = '12D3KooWThirdCoreOfTheGraph';
const MEMBER = '12D3KooWRelayedShareMember';
const EDGE = '12D3KooWAnAdmittedEdge';
const UNADMITTED_CORE = '12D3KooWCoreNotAdmitted';

type RouterHandler = (data: Uint8Array, peerId: { toString(): string }) => Promise<Uint8Array>;

function logger(lines: string[]) {
  return {
    info: (_ctx: unknown, message: string) => { lines.push(message); },
    warn: (_ctx: unknown, message: string) => { lines.push(message); },
    debug: (_ctx: unknown, message: string) => { lines.push(message); },
    error: (_ctx: unknown, message: string) => { lines.push(message); },
  };
}

/** The graph's owner: an Edge whose share handler and store are real. */
function ownerHost() {
  const store = new OxigraphStore();
  const handler = new SharedMemoryHandler(store, new TypedEventBus(), { keepsAuthorSeals: async () => true });
  const state = {
    cores: new Set([CORE_A, CORE_B, CORE_C, UNADMITTED_CORE]),
    admitted: new Set([CORE_A, CORE_B, CORE_C, EDGE]),
    curator: true,
    private: false,
    allowedPeers: [] as string[],
    allowedAgents: [] as string[],
    handlerFails: false,
  };
  const sends: Array<{ peerId: string; protocolId: string }> = [];
  const registrations: Array<{ protocolId: string; handler: RouterHandler; options: unknown }> = [];
  const logLines: string[] = [];
  const agent = Object.create(DKGAgent.prototype) as DKGAgent;
  Object.assign(agent, {
    node: { peerId: OWNER_PEER, libp2p: { getPeers: () => [], getConnections: () => [] } },
    config: { nodeRole: 'edge', rfc64CatalogExecutionPlan: { selectedAuthorityByWireId: {} } },
    wireIdToLocalCgId: new Map(),
    subscribedContextGraphs: new Map([[RELAYED_CG, { subscribed: true }]]),
    localAgents: new Map([[OWNER_WALLET.address, {}]]),
    log: logger(logLines),
    peerCapabilityRegistry: { supportsCore: (peerId: string) => state.cores.has(peerId) },
    networkAdmissionCoordinator: { isAcceptedPeer: (peerId: string) => state.admitted.has(peerId) },
    isCuratorOf: async () => state.curator,
    isPrivateContextGraph: async () => state.private,
    getCgMeta: async () => ({ allowedPeers: state.allowedPeers, allowedAgents: state.allowedAgents }),
    getOrCreateSharedMemoryHandler: () => {
      if (state.handlerFails) throw new Error('store closed');
      return handler;
    },
    messenger: {
      sendToPeer: async (peerId: string, protocolId: string) => { sends.push({ peerId, protocolId }); return new Uint8Array(); },
      sendReliable: async (peerId: string, protocolId: string) => { sends.push({ peerId, protocolId }); return { delivered: true }; },
    },
    router: {
      register: (protocolId: string, routed: RouterHandler, options: unknown) => { registrations.push({ protocolId, handler: routed, options }); },
    },
  });
  return { agent, store, handler, state, sends, registrations, logLines };
}

/** Spies on the owner's share handler: its applies and its author seal keeps. */
function handlerSpies(owner: ReturnType<typeof ownerHost>) {
  const sealKeeper = (owner.handler as unknown as { authorSeals: { keep: (...args: unknown[]) => Promise<unknown> } }).authorSeals;
  return { handle: vi.spyOn(owner.handler, 'handle'), keep: vi.spyOn(sealKeeper, 'keep') };
}

/** The seal VM publish would read at the author's coordinate on `store`, if any. */
async function sealAt(store: OxigraphStore, author = AUTHOR.address, assertionName = 'report-1') {
  return resolveDurableGraphScopedAuthorSealCandidateV1({
    store,
    contextGraphId: RELAYED_CG as ContextGraphIdV1,
    agentAddress: author.toLowerCase(),
    assertionCoordinate: assertionName,
    subGraphName: REPORTS,
    source: 'test.relayedShare.seal',
  });
}

async function shareCompleteAt(store: OxigraphStore, author = AUTHOR.address, assertionName = 'report-1'): Promise<boolean> {
  const lifecycle = assertionLifecycleUri(RELAYED_CG, author, assertionName, REPORTS);
  const result = await store.query(`ASK { GRAPH <${contextGraphMetaUri(RELAYED_CG)}> { <${lifecycle}> <${SWM_SHARE_COMPLETE_PRED}> ?o } }`);
  return result.type === 'boolean' && result.value;
}

async function holds(store: OxigraphStore, value = 'a report'): Promise<boolean> {
  const result = await store.query(`ASK { GRAPH ?g { <${subjectOf(value)}> <${SUBJECT_PREDICATE}> "${value}" } }`);
  return result.type === 'boolean' && result.value;
}

async function tripleCount(store: OxigraphStore, value = 'a report'): Promise<number> {
  const result = await store.query(`SELECT ?g WHERE { GRAPH ?g { <${subjectOf(value)}> <${SUBJECT_PREDICATE}> "${value}" } }`);
  return result.type === 'bindings' ? result.bindings.length : 0;
}

describe('the owner takes a member\'s share that a Core relays', () => {
  it('applies it as the curator and keeps the author seal and the share-complete record, without a share ack', async () => {
    const owner = ownerHost();

    const answer = await owner.agent.handleRelayedSwmShareV1(await relayedShare(), CORE_A);

    expect(answer).toEqual(new Uint8Array());
    expect(await holds(owner.store)).toBe(true);
    expect((await sealAt(owner.store))?.seal.authorAddress.toLowerCase()).toBe(AUTHOR.address.toLowerCase());
    expect(await shareCompleteAt(owner.store)).toBe(true);
    expect(owner.sends).toEqual([]);
    expect(owner.logLines.join('\n')).toContain(`relayed by Core ${CORE_A.slice(-8)}`);
  });

  it('applies the copies of one share that three Cores relay one after another once, and answers each as applied', async () => {
    const owner = ownerHost();
    const spies = handlerSpies(owner);
    const wire = await relayedShare();

    expect(await owner.agent.handleRelayedSwmShareV1(wire, CORE_A)).toEqual(new Uint8Array());
    const copies = await tripleCount(owner.store);
    expect(copies).toBeGreaterThan(0);
    expect(await owner.agent.handleRelayedSwmShareV1(Uint8Array.from(wire), CORE_B)).toEqual(new Uint8Array());
    expect(await owner.agent.handleRelayedSwmShareV1(Uint8Array.from(wire), CORE_C)).toEqual(new Uint8Array());

    expect(spies.handle).toHaveBeenCalledTimes(1);
    expect(spies.keep).toHaveBeenCalledTimes(1);
    expect(await tripleCount(owner.store)).toBe(copies);
    expect(await sealAt(owner.store)).toBeDefined();
    expect(owner.sends).toEqual([]);
    expect(owner.logLines.filter((line) => line.includes('already applied from another copy'))).toHaveLength(2);
  });

  it('tells the owner\'s followers once after it applies a relayed share, as a direct or gossip apply does, and passes nothing on', async () => {
    const owner = ownerHost();
    const notice = vi.spyOn(owner.agent, 'noticeSwmFollowersAfterApplyV1');
    const wire = await relayedShare();

    await owner.agent.handleRelayedSwmShareV1(wire, CORE_A);
    await owner.agent.handleRelayedSwmShareV1(Uint8Array.from(wire), CORE_B);
    await owner.agent.handleRelayedSwmShareV1(await relayedShare({ request: { contentScopeVersion: 1 } }), CORE_C);

    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0]![0]).toMatchObject({ cgId: RELAYED_CG });
    expect(notice.mock.calls[0]![1]).toBe(CORE_A);
    expect(notice.mock.calls[0]![2], 'no bytes: the owner does not pass the share on').toBeUndefined();
  });

  it('applies the copies of one share that three Cores relay at once once', async () => {
    const owner = ownerHost();
    const spies = handlerSpies(owner);
    const wire = await relayedShare();

    const answers = await Promise.all([CORE_A, CORE_B, CORE_C].map((core) => owner.agent.handleRelayedSwmShareV1(Uint8Array.from(wire), core)));

    expect(answers).toEqual([new Uint8Array(), new Uint8Array(), new Uint8Array()]);
    expect(spies.handle).toHaveBeenCalledTimes(1);
    expect(spies.keep).toHaveBeenCalledTimes(1);
    expect(await sealAt(owner.store)).toBeDefined();
  });

  it('still checks each copy before answering it, and applies a copy in full after one that was not applied', async () => {
    const owner = ownerHost();
    const spies = handlerSpies(owner);
    const wire = await relayedShare();

    owner.state.handlerFails = true;
    expect(await owner.agent.handleRelayedSwmShareV1(wire, CORE_A)).toEqual(FANOUT_RESPONSE_REJECTED);
    owner.state.handlerFails = false;
    expect(await owner.agent.handleRelayedSwmShareV1(wire, CORE_B)).toEqual(new Uint8Array());
    expect(spies.handle).toHaveBeenCalledTimes(1);
    owner.state.curator = false;
    expect(await owner.agent.handleRelayedSwmShareV1(wire, CORE_C)).toEqual(FANOUT_RESPONSE_REJECTED);
    expect(owner.logLines.join('\n')).toMatch(/not the curator/);
    expect(spies.handle).toHaveBeenCalledTimes(1);
  });

  type Setup = (owner: ReturnType<typeof ownerHost>) => void;
  const none: Setup = () => {};
  it.each([
    ['from a peer that is not a Core', none, async () => relayedShare(), EDGE, /not an admitted Core/],
    ['from a Core that is not admitted', none, async () => relayedShare(), UNADMITTED_CORE, /not an admitted Core/],
    ['on a node that is not the curator', (owner: ReturnType<typeof ownerHost>) => { owner.state.curator = false; }, async () => relayedShare(), CORE_A, /not the curator/],
    ['for a private graph', (owner: ReturnType<typeof ownerHost>) => { owner.state.private = true; }, async () => relayedShare(), CORE_A, /is private/],
    ['for a graph with a peer allowlist', (owner: ReturnType<typeof ownerHost>) => { owner.state.allowedPeers = [MEMBER]; }, async () => relayedShare(), CORE_A, /has an allowlist/],
    ['for a graph with an agent allowlist', (owner: ReturnType<typeof ownerHost>) => { owner.state.allowedAgents = [AUTHOR.address]; }, async () => relayedShare(), CORE_A, /has an allowlist/],
    ['for a share into the root', none, async () => relayedShare({ request: { subGraphName: '' } }), CORE_A, /root scope/],
    ['in an unsigned envelope', none, async () => unsignedEnvelope(await relayedShareRequest()), CORE_A, /unsigned/],
    ['in an envelope older than five minutes', none, async () => relayedShare({ signedAt: new Date(Date.now() - GOSSIP_ENVELOPE_FRESHNESS_MS - 1_000) }), CORE_A, /freshness window/],
    ['signed by another than the asset author', none, async () => relayedShare({ signer: STRANGER }), CORE_A, /not the asset author/],
    ['with a sender-key payload', none, async () => signedEnvelope(senderKeyPayload()), CORE_A, /sender-key/],
    ['with an encrypted payload', none, async () => signedEnvelope(encryptedPayload()), CORE_A, /encrypted/],
  ] as Array<[string, Setup, () => Promise<Uint8Array>, string, RegExp]>)('refuses a relayed share %s and stores nothing', async (_label, setup, bytes, from, reason) => {
    const owner = ownerHost();
    setup(owner);

    expect(await owner.agent.handleRelayedSwmShareV1(await bytes(), from)).toEqual(FANOUT_RESPONSE_REJECTED);

    expect(await holds(owner.store)).toBe(false);
    expect(await sealAt(owner.store)).toBeUndefined();
    expect(owner.logLines.join('\n')).toMatch(reason);
  });

  it('refuses tampered bytes', async () => {
    const owner = ownerHost();
    const envelope = decodeGossipEnvelope(await relayedShare());
    const tampered = encodeGossipEnvelope({ ...envelope, payload: await relayedShareRequest({ value: 'another report' }) });

    expect(await owner.agent.handleRelayedSwmShareV1(tampered, CORE_A)).toEqual(FANOUT_RESPONSE_REJECTED);
    expect(await holds(owner.store, 'another report')).toBe(false);
  });

  it('refuses a share the share handler does not apply, and says why', async () => {
    const owner = ownerHost();

    const answer = await owner.agent.handleRelayedSwmShareV1(await relayedShare({ request: { contentScopeVersion: 1 } }), CORE_A);

    expect(answer).toEqual(FANOUT_RESPONSE_REJECTED);
    expect(owner.logLines.join('\n')).toContain(`Share relayed by ${CORE_A.slice(-8)} not applied:`);
  });

  it('refuses a Core past its rate limit', async () => {
    const owner = ownerHost();
    for (let index = 0; index < 120; index += 1) await owner.agent.handleRelayedSwmShareV1(new Uint8Array([1]), CORE_A);

    expect(await owner.agent.handleRelayedSwmShareV1(await relayedShare(), CORE_A)).toEqual(FANOUT_RESPONSE_REJECTED);
    expect(owner.logLines.join('\n')).toContain('passed its rate limit');
    expect(await owner.agent.handleRelayedSwmShareV1(await relayedShare(), CORE_B)).toEqual(new Uint8Array());
  });

  it('refuses once the node is stopping, and when the share cannot be handled', async () => {
    const stopping = ownerHost();
    stopping.agent.stopSwmChangeNoticesV1();
    expect(await stopping.agent.handleRelayedSwmShareV1(await relayedShare(), CORE_A)).toEqual(FANOUT_RESPONSE_REJECTED);
    expect(stopping.logLines.join('\n')).toContain('the node is stopping');

    const failing = ownerHost();
    failing.state.handlerFails = true;
    expect(await failing.agent.handleRelayedSwmShareV1(await relayedShare(), CORE_A)).toEqual(FANOUT_RESPONSE_REJECTED);
    expect(failing.logLines.join('\n')).toContain('not handled: store closed');
  });
});

describe('the relayed protocol, as the agent registers it', () => {
  it('registers it next to the change notice, reading at most a share\'s size, and answers through the owner\'s checks', async () => {
    const owner = ownerHost();
    owner.agent.registerSwmChangeNoticeProtocolV1();

    expect(owner.registrations.map(({ protocolId, options }) => [protocolId, options])).toEqual([
      [PROTOCOL_SWM_CHANGE_NOTICE, { maxReadBytes: SWM_CHANGE_NOTICE_MAX_BYTES }],
      [PROTOCOL_SWM_UPDATE_RELAYED, { maxReadBytes: DKG_GOSSIP_MAX_RPC_BYTES }],
    ]);
    const relayed = owner.registrations[1]!.handler;
    expect(await relayed(await relayedShare(), { toString: () => CORE_A })).toEqual(new Uint8Array());
    expect(await relayed(await relayedShare({ value: 'b' }), { toString: () => EDGE })).toEqual(FANOUT_RESPONSE_REJECTED);
    expect(await holds(owner.store)).toBe(true);
  });
});

/** A Core that hosts the graph, connected to the owner and the member; its sends go to `deliver`. */
function coreHost(deliver?: (peerId: string, bytes: Uint8Array) => Promise<Uint8Array>) {
  const state = {
    nodeRole: 'core' as 'core' | 'edge',
    connected: [OWNER_PEER, MEMBER],
    private: false,
    allowedPeers: [] as string[],
    privacyFails: false,
    localAgents: new Map<string, unknown>(),
  };
  const sends: Array<{ peerId: string; protocolId: string; bytes: Uint8Array }> = [];
  const logLines: string[] = [];
  const agent = Object.create(DKGAgent.prototype) as DKGAgent;
  const config = { rfc64CatalogExecutionPlan: { selectedAuthorityByWireId: {} } } as Record<string, unknown>;
  Object.defineProperty(config, 'nodeRole', { get: () => state.nodeRole, enumerable: true });
  Object.assign(agent, {
    node: {
      peerId: CORE_A,
      libp2p: {
        getPeers: () => state.connected.map((peerId) => ({ toString: () => peerId })),
        getConnections: () => state.connected.map((peerId) => ({ remotePeer: { toString: () => peerId } })),
      },
    },
    config,
    wireIdToLocalCgId: new Map(),
    subscribedContextGraphs: new Map<string, Record<string, unknown>>([
      [RELAYED_CG, { subscribed: false, coreHosted: true }],
      [`${OWNER_WALLET.address.toLowerCase()}/subscribed`, { subscribed: true }],
      [`${OWNER_WALLET.address.toLowerCase()}/elsewhere`, { subscribed: false }],
      ['graph-without-owner-namespace', { subscribed: true, coreHosted: true }],
    ]),
    localAgents: state.localAgents,
    log: logger(logLines),
    isCuratorOf: async () => false,
    isPeerDialable: async () => true,
    isPrivateContextGraph: async () => {
      if (state.privacyFails) throw new Error('store closed');
      return state.private;
    },
    getCgMeta: async () => ({ allowedPeers: state.allowedPeers, allowedAgents: [] }),
    resolveCuratorPeerId: async () => OWNER_PEER,
    discovery: { findAgents: async () => [] },
    messenger: {
      sendToPeer: async (peerId: string, protocolId: string, bytes: Uint8Array) => {
        sends.push({ peerId, protocolId, bytes });
        return deliver === undefined ? new Uint8Array() : deliver(peerId, bytes);
      },
    },
  });
  return { agent, state, sends, logLines };
}

const applied = (contextGraphId = RELAYED_CG, shareOperationId = 'op-a-report') => ({
  cgId: contextGraphId,
  subGraphName: REPORTS,
  shareOperationId,
  publisherPeerId: MEMBER,
});

async function afterApply(core: ReturnType<typeof coreHost>, wire: Uint8Array | undefined, outcome = applied()) {
  core.agent.noticeSwmFollowersAfterApplyV1(outcome, MEMBER, wire);
  await core.agent.whenSwmChangeNoticesSettledV1();
  return core.sends.map(({ peerId, protocolId }) => [peerId, protocolId]);
}

describe('a Core passes a member\'s share on to the graph\'s owner', () => {
  it('sends the share\'s bytes to the owner it is connected to, and the owner keeps the member\'s seal', async () => {
    const owner = ownerHost();
    const core = coreHost((_peerId, bytes) => owner.agent.handleRelayedSwmShareV1(bytes, CORE_A));
    const wire = await relayedShare();

    expect(await afterApply(core, wire)).toEqual([[OWNER_PEER, PROTOCOL_SWM_UPDATE_RELAYED]]);

    expect(core.sends[0]!.bytes).toBe(wire);
    expect(core.agent.swmChangeNoticeOwnersV1().ownerForwarder.appliedCount(RELAYED_CG, 'op-a-report')).toBe(1);
    expect(await sealAt(owner.store)).toBeDefined();
    expect(await shareCompleteAt(owner.store)).toBe(true);
  });

  it('sends one copy when the share is applied by gossip and by a direct send, and one for each share', async () => {
    const core = coreHost();
    const wire = await relayedShare();

    core.agent.noticeSwmFollowersAfterApplyV1(applied(), MEMBER, wire);
    core.agent.noticeSwmFollowersAfterApplyV1(applied(), MEMBER, wire);
    await core.agent.whenSwmChangeNoticesSettledV1();
    core.agent.noticeSwmFollowersAfterApplyV1(applied(), MEMBER, wire);
    await core.agent.whenSwmChangeNoticesSettledV1();
    const second = await relayedShare({ author: SECOND_AUTHOR, value: 'b', shareOperationId: 'op-b' });
    core.agent.noticeSwmFollowersAfterApplyV1(applied(RELAYED_CG, 'op-b'), MEMBER, second);
    await core.agent.whenSwmChangeNoticesSettledV1();

    expect(core.sends.map(({ peerId }) => peerId)).toEqual([OWNER_PEER, OWNER_PEER]);
  });

  it('passes on a share of a graph it subscribes to without hosting it', async () => {
    const core = coreHost();
    const contextGraphId = `${OWNER_WALLET.address.toLowerCase()}/subscribed`;

    expect(await afterApply(core, await relayedShare({ contextGraphId }), applied(contextGraphId))).toEqual([
      [OWNER_PEER, PROTOCOL_SWM_UPDATE_RELAYED],
    ]);
  });

  it.each([
    ['without the share\'s bytes', (_core: ReturnType<typeof coreHost>) => {}, false, applied()],
    ['on an Edge', (core: ReturnType<typeof coreHost>) => { core.state.nodeRole = 'edge'; }, true, applied()],
    ['for a private graph', (core: ReturnType<typeof coreHost>) => { core.state.private = true; }, true, applied()],
    ['for a graph with an allowlist', (core: ReturnType<typeof coreHost>) => { core.state.allowedPeers = [MEMBER]; }, true, applied()],
    ['when the owner is on this node', (core: ReturnType<typeof coreHost>) => { core.state.localAgents.set(OWNER_WALLET.address, {}); }, true, applied()],
    ['when the owner is not connected', (core: ReturnType<typeof coreHost>) => { core.state.connected = [MEMBER]; }, true, applied()],
    ['for a graph it neither hosts nor subscribes to', (_core: ReturnType<typeof coreHost>) => {}, true, applied(`${OWNER_WALLET.address.toLowerCase()}/elsewhere`)],
    ['for a graph whose id names no owner', (_core: ReturnType<typeof coreHost>) => {}, true, applied('graph-without-owner-namespace')],
    ['for a share without a graph', (_core: ReturnType<typeof coreHost>) => {}, true, { shareOperationId: 'op-a-report', publisherPeerId: MEMBER }],
    ['for a share without an operation id', (_core: ReturnType<typeof coreHost>) => {}, true, { cgId: RELAYED_CG, subGraphName: REPORTS, publisherPeerId: MEMBER }],
  ] as Array<[string, (core: ReturnType<typeof coreHost>) => void, boolean, ReturnType<typeof applied>]>)('passes nothing on %s', async (_label, setup, withWire, outcome) => {
    const core = coreHost();
    setup(core);

    expect(await afterApply(core, withWire ? await relayedShare() : undefined, outcome)).toEqual([]);
  });

  it('passes nothing on after stop, and logs a decision that failed', async () => {
    const stopped = coreHost();
    stopped.agent.stopSwmChangeNoticesV1();
    expect(await afterApply(stopped, await relayedShare())).toEqual([]);

    const failing = coreHost();
    failing.state.privacyFails = true;
    expect(await afterApply(failing, await relayedShare())).toEqual([]);
    expect(failing.logLines.join('\n')).toContain('not passed on to the graph\'s owner: store closed');
  });
});
