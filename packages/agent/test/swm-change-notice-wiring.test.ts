/**
 * The agent's wiring of the shared-memory change notice (#1611), through the
 * agent's own methods: which senders and graphs a follower pulls for, the
 * protocol registration, how the owner tells its followers, how it passes
 * another author's catalog head on, and shutdown. Each agent here is a bare
 * host: its connections, subscriptions, privacy, follower records, curator
 * lookup, sync and sends are set by the test; the notice code is the agent's.
 * The notice logic itself is in `swm-change-notice.test.ts`, and the whole
 * path over real sync in `e2e-swm-relay-only.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { PROTOCOL_SWM_CHANGE_NOTICE } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/dkg-agent.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from '../src/rfc64/public-catalog-transport-v1.js';
import {
  SWM_CHANGE_NOTICE_MAX_BYTES,
  decodeSwmChangeNoticeV1,
  encodeSwmChangeNoticeV1,
} from '../src/swm/shared-memory-change-notice.js';
import { sharedMemoryFollowersOf } from '../src/swm/shared-memory-followers.js';

const OWNER_ADDRESS = '0x1111111111111111111111111111111111111111';
const CG = `${OWNER_ADDRESS}/notice-wiring`;
const PRIVATE_CG = `${OWNER_ADDRESS}/notice-wiring-private`;
const UNSUBSCRIBED_CG = `${OWNER_ADDRESS}/notice-wiring-unsubscribed`;
const SELF = '12D3KooWSelfOfTheHost';
const CURATOR = '12D3KooWCuratorOfTheGraph';
const FOLLOWER = '12D3KooWFollowerOfTheGraph';
const STRANGER = '12D3KooWConnectedStranger';

type RouterHandler = (data: Uint8Array, peerId: { toString(): string }) => Promise<Uint8Array>;

function host() {
  const state = {
    connected: [CURATOR, FOLLOWER, STRANGER],
    curatorOf: new Set<string>(),
    dialable: new Set([CURATOR, FOLLOWER, STRANGER]),
    curatorLookupFails: false,
    privacyCheckFails: false,
  };
  const syncs: Array<{ peerId: string; contextGraphIds: string[]; options: unknown }> = [];
  const sends: Array<{ peerId: string; protocolId: string; bytes: Uint8Array; options: unknown }> = [];
  const handoffs: Array<{ announcement: Rfc64PublicCatalogHeadAnnouncementV1; peers: readonly string[] }> = [];
  const registrations: Array<{ protocolId: string; handler: RouterHandler; options: unknown }> = [];
  const curatorLookups: string[] = [];
  const logLines: string[] = [];
  const agent = Object.create(DKGAgent.prototype) as DKGAgent;
  Object.assign(agent, {
    node: {
      peerId: SELF,
      libp2p: { getPeers: () => state.connected.map((peerId) => ({ toString: () => peerId })) },
    },
    subscribedContextGraphs: new Map([
      [CG, { subscribed: true }],
      [PRIVATE_CG, { subscribed: true }],
      [UNSUBSCRIBED_CG, { subscribed: false }],
    ]),
    log: {
      info: (_ctx: unknown, message: string) => { logLines.push(message); },
      warn: (_ctx: unknown, message: string) => { logLines.push(message); },
      debug: () => {},
    },
    router: {
      register: (protocolId: string, handler: RouterHandler, options: unknown) => {
        registrations.push({ protocolId, handler, options });
      },
    },
    messenger: {
      sendToPeer: async (peerId: string, protocolId: string, bytes: Uint8Array, options: unknown) => {
        sends.push({ peerId, protocolId, bytes, options });
        return new Uint8Array();
      },
    },
    isPrivateContextGraph: async (contextGraphId: string) => {
      if (state.privacyCheckFails) throw new Error('store closed');
      return contextGraphId === PRIVATE_CG;
    },
    isCuratorOf: async (contextGraphId: string) => state.curatorOf.has(contextGraphId),
    isPeerDialable: async (peerId: string) => state.dialable.has(peerId),
    resolveCuratorPeerIdsForCg: async (contextGraphId: string) => {
      curatorLookups.push(contextGraphId);
      if (state.curatorLookupFails) throw new Error('chain unavailable');
      return { peerIds: [CURATOR], curatorIsLocal: false, legacyTripleResolved: true };
    },
    syncSharedMemoryFromPeerDetailed: async (peerId: string, contextGraphIds: string[], options: unknown) => {
      syncs.push({ peerId, contextGraphIds, options });
      return { deferredBackpressure: 0 };
    },
    deliverRfc64CatalogHeadV1: (input: { announcement: Rfc64PublicCatalogHeadAnnouncementV1; peers: readonly string[] }) => {
      handoffs.push(input);
      return { status: 'queued' };
    },
  });
  return { agent, state, syncs, sends, handoffs, registrations, curatorLookups, logLines };
}

const noticeBytes = (contextGraphId = CG, subGraphName: string | null = 'notes', hint = 'op-1') => (
  encodeSwmChangeNoticeV1({ contextGraphId, subGraphName, hint })
);

/** What a follower does with one notice from `peerId`, and the syncs it started. */
async function notify(target: ReturnType<typeof host>, peerId: string, contextGraphId = CG) {
  const disposition = await target.agent.handleSwmChangeNoticeV1(noticeBytes(contextGraphId), peerId);
  await target.agent.whenSwmChangeNoticesSettledV1();
  return { disposition, syncs: target.syncs.map(({ peerId: from, contextGraphIds }) => [from, contextGraphIds]) };
}

describe('a follower\'s notice admission, as the agent wires it', () => {
  it('pulls from the connected curator of a subscribed public graph, as a fresh sync of the whole graph', async () => {
    const follower = host();

    expect(await notify(follower, CURATOR)).toEqual({ disposition: 'pulling', syncs: [[CURATOR, [CG]]] });
    expect(follower.syncs[0]!.options).toEqual({ source: 'reconcile', freshSnapshot: true });
  });

  it('pulls from a connected peer that follows the graph from this node', async () => {
    const follower = host();
    sharedMemoryFollowersOf(follower.agent).note(CG, FOLLOWER);

    expect(await notify(follower, FOLLOWER)).toEqual({ disposition: 'pulling', syncs: [[FOLLOWER, [CG]]] });
  });

  it('refuses a connected peer that is neither the curator nor a follower, and syncs nothing', async () => {
    const follower = host();

    expect(await notify(follower, STRANGER)).toEqual({ disposition: 'sender-not-accepted', syncs: [] });
  });

  it('refuses a follower that is not connected, and syncs nothing', async () => {
    const follower = host();
    sharedMemoryFollowersOf(follower.agent).note(CG, FOLLOWER);
    follower.state.connected = [CURATOR];

    expect(await notify(follower, FOLLOWER)).toEqual({ disposition: 'sender-not-accepted', syncs: [] });
  });

  it('refuses a notice for a graph it does not subscribe to, or for a private graph, and syncs nothing', async () => {
    const follower = host();

    expect(await notify(follower, CURATOR, UNSUBSCRIBED_CG)).toEqual({ disposition: 'not-followed', syncs: [] });
    expect(await notify(follower, CURATOR, PRIVATE_CG)).toEqual({ disposition: 'not-followed', syncs: [] });
  });

  it('refuses the curator while its lookup fails, and keeps one lookup per graph for a while', async () => {
    const failing = host();
    failing.state.curatorLookupFails = true;
    expect(await notify(failing, CURATOR)).toEqual({ disposition: 'sender-not-accepted', syncs: [] });

    const follower = host();
    await notify(follower, CURATOR);
    await notify(follower, STRANGER);
    await notify(follower, CURATOR);
    expect(follower.curatorLookups).toEqual([CG]);
    expect(follower.syncs.map(({ peerId }) => peerId)).toEqual([CURATOR, CURATOR]);
  });
});

describe('the notice protocol, as the agent registers it', () => {
  it('reads at most a notice\'s size, answers at once and handles the notice', async () => {
    const follower = host();
    follower.agent.registerSwmChangeNoticeProtocolV1();

    expect(follower.registrations.map(({ protocolId, options }) => [protocolId, options])).toEqual([
      [PROTOCOL_SWM_CHANGE_NOTICE, { maxReadBytes: SWM_CHANGE_NOTICE_MAX_BYTES }],
    ]);
    const answer = await follower.registrations[0]!.handler(noticeBytes(), { toString: () => CURATOR });
    expect(answer).toEqual(new Uint8Array());
    // The handler did not wait for the notice's admission; the pull starts after it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await follower.agent.whenSwmChangeNoticesSettledV1();
    expect(follower.syncs.map(({ peerId }) => peerId)).toEqual([CURATOR]);
  });

  it('logs a notice it could not handle', async () => {
    const follower = host();
    follower.agent.registerSwmChangeNoticeProtocolV1();
    follower.state.privacyCheckFails = true;

    await follower.registrations[0]!.handler(noticeBytes(), { toString: () => CURATOR });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(follower.logLines).toContain(`SWM change notice from ${CURATOR.slice(-8)} not handled: store closed`);
    expect(follower.syncs).toEqual([]);
  });
});

describe('the owner\'s side, as the agent wires it', () => {
  const announcement = {
    contextGraphId: CG,
    authorAddress: '0x2222222222222222222222222222222222222222',
    catalogHeadObjectDigest: 'sha256:head',
  } as unknown as Rfc64PublicCatalogHeadAnnouncementV1;

  /** An owner of the graph with three followers: the source of the change, one it reaches and one it does not. */
  function owner() {
    const target = host();
    target.state.curatorOf.add(CG);
    target.state.curatorOf.add(PRIVATE_CG);
    target.state.dialable = new Set([CURATOR, FOLLOWER]);
    for (const contextGraphId of [CG, PRIVATE_CG]) {
      for (const peerId of [CURATOR, FOLLOWER, STRANGER]) sharedMemoryFollowersOf(target.agent).note(contextGraphId, peerId);
    }
    return target;
  }

  it('sends a member\'s change to the followers it reaches except the member, on the notice protocol', async () => {
    const target = owner();

    target.agent.noticeSwmFollowersAfterApplyV1({ cgId: CG, subGraphName: 'notes', shareOperationId: 'op-7' }, CURATOR);
    target.agent.noticeSwmFollowersAfterApplyV1({ shareOperationId: 'op-8' }, CURATOR);
    await target.agent.whenSwmChangeNoticesSettledV1();

    expect(target.sends.map(({ peerId, protocolId }) => [peerId, protocolId])).toEqual([[FOLLOWER, PROTOCOL_SWM_CHANGE_NOTICE]]);
    expect(decodeSwmChangeNoticeV1(target.sends[0]!.bytes)).toEqual({ contextGraphId: CG, subGraphName: 'notes', hint: 'op-7' });
  });

  it('hands another author\'s catalog head to the catalog delivery, for the followers it reaches except the source', async () => {
    const target = owner();

    target.agent.forwardRemoteRfc64CatalogHeadV1(announcement, CURATOR);
    await target.agent.whenSwmChangeNoticesSettledV1();

    expect(target.handoffs).toEqual([{ announcement, peers: [FOLLOWER] }]);
    expect(target.sends).toEqual([]);
  });

  it('passes nothing on for a graph it does not own, or for a private one', async () => {
    const notOwner = host();
    sharedMemoryFollowersOf(notOwner.agent).note(CG, FOLLOWER);
    notOwner.agent.forwardRemoteRfc64CatalogHeadV1(announcement, CURATOR);
    notOwner.agent.noticeSwmFollowersAfterApplyV1({ cgId: CG, subGraphName: 'notes' }, CURATOR);
    await notOwner.agent.whenSwmChangeNoticesSettledV1();
    const privateOwner = owner();
    privateOwner.agent.forwardRemoteRfc64CatalogHeadV1({ ...announcement, contextGraphId: PRIVATE_CG }, CURATOR);
    privateOwner.agent.noticeSwmFollowersAfterApplyV1({ cgId: PRIVATE_CG, subGraphName: 'notes' }, CURATOR);
    await privateOwner.agent.whenSwmChangeNoticesSettledV1();

    expect([...notOwner.handoffs, ...notOwner.sends, ...privateOwner.handoffs, ...privateOwner.sends]).toEqual([]);
  });

  it('logs a catalog head whose recipients it could not find', async () => {
    const target = owner();
    target.state.privacyCheckFails = true;

    target.agent.forwardRemoteRfc64CatalogHeadV1(announcement, CURATOR);
    await target.agent.whenSwmChangeNoticesSettledV1();

    expect(target.handoffs).toEqual([]);
    expect(target.logLines).toContain(`Catalog head of "${CG}" not passed on: store closed`);
  });
});

describe('shutdown and restart', () => {
  it('after stop, tells nobody of a change, passes no catalog head on and pulls on no notice', async () => {
    const target = host();
    target.state.curatorOf.add(CG);
    sharedMemoryFollowersOf(target.agent).note(CG, FOLLOWER);

    target.agent.stopSwmChangeNoticesV1();
    target.agent.noticeSwmFollowersAfterApplyV1({ cgId: CG, subGraphName: 'notes' }, CURATOR);
    target.agent.forwardRemoteRfc64CatalogHeadV1(
      { contextGraphId: CG, authorAddress: OWNER_ADDRESS } as unknown as Rfc64PublicCatalogHeadAnnouncementV1,
      CURATOR,
    );
    const disposition = await target.agent.handleSwmChangeNoticeV1(noticeBytes(), CURATOR);
    await target.agent.whenSwmChangeNoticesSettledV1();

    expect(disposition).toBe('stopped');
    expect([...target.sends, ...target.handoffs, ...target.syncs]).toEqual([]);
  });

  it('answers notices again once started again', async () => {
    const target = host();
    target.agent.stopSwmChangeNoticesV1();
    target.agent.registerSwmChangeNoticeProtocolV1();

    expect(await notify(target, CURATOR)).toEqual({ disposition: 'pulling', syncs: [[CURATOR, [CG]]] });
  });
});
