/**
 * E2E (#3198): shared memory on a public context graph that is not registered
 * on chain, between agents whose only route to each other is a relay.
 *
 * Every other agent E2E connects its agents directly. Edge nodes behind NATs
 * reach each other through a Core's relay instead, and libp2p marks such a
 * connection limited (`connection.limits`). Request/response protocols run on
 * a limited connection. Gossipsub does not, and the direct shared-memory
 * fan-out leaves out a peer it holds only limited connections to. So:
 *   - the owner's policy and every share into the graph's ROOT cross the relay
 *     (a root share travels by its author's catalog: a head announce, then a
 *     pull, all request/response);
 *   - a share into a NAMED SUB-GRAPH has only gossip and the direct fan-out,
 *     and nobody is sent it. That is the defect.
 *
 * One scenario, told in nine tests so that each numbered assertion reports on
 * its own:
 *   1. the precondition: the members reach the owner through the relay only;
 *   -  the members follow the graph and receive a root share (works today);
 *   2. a share by the owner into a named sub-graph reaches the members;
 *   3. a share by a member into a named sub-graph reaches the owner;
 *   4. a share by a member reaches the other member through the owner while
 *      the two are not connected (the owner's change notice, #1611);
 *   5. and 6. a notice that arrives while the other member already pulls the
 *      graph, on an earlier notice or periodically, still brings the share;
 *   7. a share by a member is sent to the other member directly once the two
 *      are connected;
 *   8. a member without the change notice protocol is left alone.
 * Without the fix the deliveries of 2, 3, 4 and 7 do not happen: see
 * `SUB_GRAPH_SHARES_CROSS_THE_RELAY`.
 *
 * The agents make the calls a daemon's routes make: create, connect,
 * subscribe (admission, then the subscription), create a sub-graph, write,
 * share.
 *
 * Two things about pulls, because a share can also be fetched:
 *   - A node asks its peers for a graph's shared memory on its own: when it
 *     subscribes, about three seconds after a connection, and every few
 *     minutes. An author can only know that a peer follows a public graph
 *     once the peer has asked it, so the test makes each of those requests
 *     itself at a fixed point (`askForSharedMemory`), always BEFORE the share
 *     that is asserted, and no assertion depends on when the node's own
 *     rounds happen to run.
 *   - A background round that is still running fetches a fresh share as well.
 *     That is catch-up, not the delivery under test, so every asserted share
 *     is made once those rounds have ended (`whenNobodyPulls`). After a
 *     share the test only reads the receiver's shared memory.
 */
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { PROTOCOL_SWM_CHANGE_NOTICE } from '@origintrail-official/dkg-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RealChainAgents, pollUntil } from './_helpers/real-chain-agent.js';
import {
  RelayOnlyNetwork,
  connectThroughRelay,
  expectFreshCoreGrant,
  expectRelayOnlyLink,
  linkConnections,
} from './_helpers/relay-only-network.js';
import type { DKGAgent } from '../src/index.js';
import { takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';

/**
 * THE SWITCH for the fix of #3198: the one line of this file the fix changes.
 *
 * `false` describes the code before the fix. A share into a named sub-graph
 * is not sent across a relay-only link, and assertions 2, 3 and 4 pin exactly
 * that: the share is made, and it is not there after `ABSENCE_WATCH_MS`.
 * With `true` the same assertions require it within `DELIVERY_BOUND_MS`.
 *
 * A build that delivers while this still says `false` fails as well, on
 * purpose, with a message that points at this line.
 */
const SUB_GRAPH_SHARES_CROSS_THE_RELAY = true;

/**
 * A share that crosses the relay is pushed to the peer, so it is there in
 * seconds, not after the minutes the next catch-up round is away. The bound
 * leaves room for the dial detours of a limited connection (see
 * `relay-only-network.ts`).
 */
const DELIVERY_BOUND_MS = 30_000;
/** How long a share is watched before a test says "it was not delivered". */
const ABSENCE_WATCH_MS = 10_000;
/** A root share is pulled through its author's catalog. */
const CATALOG_BOUND_MS = 60_000;
/** The background sync rounds that follow a connection end well within this. */
const BACKGROUND_SYNC_BOUND_MS = 90_000;

const NAME = 'http://schema.org/name';
const SUBJECT_PREFIX = 'urn:dkg:e2e-3198:';

/** One shared assertion: a single triple whose literal is the assertion's name. */
interface Shared {
  readonly name: string;
  readonly subject: string;
  readonly subGraphName: string | undefined;
  readonly sharedAt: number;
}

interface SharedMemoryRead {
  readonly names: string[];
  readonly error?: string;
}

/** What a watch for a share saw at one reader. */
interface Arrival {
  /** Milliseconds from the share to its arrival, or null when it was not there at the end of the watch. */
  readonly afterMs: number | null;
  /** For assertion messages. */
  readonly detail: string;
}

let fileSnapshot: string;
beforeAll(async () => {
  fileSnapshot = await takeSnapshot();
});
afterAll(async () => {
  await revertSnapshot(fileSnapshot);
});

/** What `reader` holds for `shared` in the shared memory of the graph (of the sub-graph, when the share named one). */
async function readSharedMemory(reader: DKGAgent, contextGraphId: string, shared: Shared): Promise<SharedMemoryRead> {
  try {
    const result = await reader.query(
      'SELECT ?name WHERE { <' + shared.subject + '> <' + NAME + '> ?name }',
      {
        contextGraphId,
        graphSuffix: '_shared_memory',
        ...(shared.subGraphName === undefined ? {} : { subGraphName: shared.subGraphName }),
      },
    );
    return { names: result.bindings.map((row) => String(row['name'])) };
  } catch (error) {
    return { names: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The graphs in which a read over all of the graph's partitions finds
 * `shared`: the read of the node UI and of `/api/query` with
 * `includeContextGraphPartitions`. Unlike `readSharedMemory` it names no
 * sub-graph, so it sees a sub-graph's share only once the reader has the
 * sub-graph registered.
 */
async function partitionsHolding(reader: DKGAgent, contextGraphId: string, shared: Shared): Promise<string[]> {
  const result = await reader.query(
    'SELECT DISTINCT ?g WHERE { GRAPH ?g { <' + shared.subject + '> <' + NAME + '> ?name } }',
    { contextGraphId, includeContextGraphPartitions: true },
  );
  return result.bindings.map((row) => String(row['g']));
}

/** The disposition of every change notice `agent` handles from now on (`swm/shared-memory-change-notice.ts`). */
function recordChangeNotices(agent: DKGAgent): string[] {
  const dispositions: string[] = [];
  const handle = agent.handleSwmChangeNoticeV1.bind(agent);
  agent.handleSwmChangeNoticeV1 = async (data, fromPeerId) => {
    const disposition = await handle(data, fromPeerId);
    dispositions.push(disposition);
    return disposition;
  };
  return dispositions;
}

/** The catalog heads `owner` hands to its catalog delivery from now on: each head's author and the peers named. */
function recordCatalogHeadHandoffs(owner: DKGAgent): Array<{ author: string; peers: readonly string[] }> {
  const handoffs: Array<{ author: string; peers: readonly string[] }> = [];
  const deliver = owner.deliverRfc64CatalogHeadV1.bind(owner);
  owner.deliverRfc64CatalogHeadV1 = (input) => {
    handoffs.push({ author: input.announcement.authorAddress.toLowerCase(), peers: [...input.peers] });
    return deliver(input);
  };
  return handoffs;
}

/** A pull `holdNextPullAfterMetadata` holds. */
interface HeldPull {
  /** Resolves once the pull has fetched the graph's metadata and is held. */
  readonly reached: Promise<void>;
  readonly release: () => void;
  /** Release, and hold no later pull. */
  readonly restore: () => void;
}

/**
 * Hold `reader`'s next pull of the graph's shared memory from `provider`
 * right after its metadata fetch, before anything else the pull fetches or
 * stores. Whatever the provider applies meanwhile is not in the metadata that
 * pull read. (A pull of graph-scoped shares fetches no data phase after the
 * metadata, #3421, so the hold is on the metadata fetch's return.)
 */
function holdNextPullAfterMetadata(reader: DKGAgent, provider: DKGAgent, contextGraphId: string): HeldPull {
  type FetchSyncPages = (...args: unknown[]) => Promise<unknown>;
  const host = reader as unknown as { fetchSyncPages: FetchSyncPages };
  const fetchSyncPages = host.fetchSyncPages;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let markReached!: () => void;
  const reached = new Promise<void>((resolve) => { markReached = resolve; });
  let holding = true;
  host.fetchSyncPages = async function holdAfterMetadata(this: unknown, ...args: unknown[]) {
    const fetched = await fetchSyncPages.apply(this, args);
    // (ctx, peerId, contextGraphId, includeSharedMemory, phase, ...)
    if (holding && args[1] === provider.peerId && args[2] === contextGraphId && args[3] === true && args[4] === 'meta') {
      holding = false;
      markReached();
      await released;
    }
    return fetched;
  };
  return {
    reached,
    release,
    restore: () => {
      release();
      delete (host as { fetchSyncPages?: FetchSyncPages }).fetchSyncPages;
    },
  };
}

/**
 * Write one knowledge asset and share it: POST /api/knowledge-assets, then its
 * swm/share. A share into a named sub-graph creates the sub-graph on the
 * author first (POST /api/sub-graph/create; creating it again changes nothing).
 * The share itself must succeed, whatever happens to its delivery.
 */
async function share(author: DKGAgent, contextGraphId: string, name: string, subGraphName?: string): Promise<Shared> {
  const scope = subGraphName === undefined ? {} : { subGraphName };
  if (subGraphName !== undefined) await author.createSubGraph(contextGraphId, subGraphName);
  const subject = SUBJECT_PREFIX + name;
  await author.assertion.create(contextGraphId, name, scope);
  await author.assertion.write(contextGraphId, name, [{ subject, predicate: NAME, object: '"' + name + '"' }], scope);
  const promoted = await author.assertion.promote(contextGraphId, name, scope);
  expect(promoted.sealed, name + ' was sealed and shared').toBe(true);
  const shared: Shared = { name, subject, subGraphName, sharedAt: Date.now() };
  // The author reads its own share with the query the receivers are read with.
  const own = await readSharedMemory(author, contextGraphId, shared);
  expect(own.names, name + ' in its author\'s shared memory' + (own.error ? ' (' + own.error + ')' : '')).toEqual(['"' + name + '"']);
  return shared;
}

/**
 * `asker` asks `peer` for the graph's shared memory and is answered (not
 * refused). Repeated within its bound: a request over a relayed link can fail
 * in transit. Made before a share exists, it fetches nothing of that share.
 */
async function askForSharedMemory(asker: DKGAgent, peer: DKGAgent, contextGraphId: string, who: string): Promise<void> {
  const answered = await pollUntil(
    () => asker.syncSharedMemoryFromPeerDetailed(peer.peerId, [contextGraphId]).then(
      (result) => result.completedPhases > 0 && result.deniedPhases === 0,
      () => false,
    ),
    (ok) => ok,
    30_000,
    1_000,
  );
  expect(answered, who + ' asked for the graph\'s shared memory and was answered').toBe(true);
}

/**
 * A background pull of `agent` is queued or running: a sync-on-connect job, or
 * a sync round it holds a peer's lease for. Both fetch the peer's shared
 * memory, whatever was shared when.
 */
function isPulling(agent: DKGAgent): boolean {
  if (agent.getSyncOnConnectPeerScheduler().size > 0) return true;
  const { peerSyncSession } = agent as unknown as { peerSyncSession: { isSyncing(peerId: string): boolean } };
  return agent.node.libp2p.getPeers().some((peer) => peerSyncSession.isSyncing(peer.toString()));
}

/**
 * Wait until no agent pulls, three polls in a row. A share made after this is
 * not picked up by a round that happened to be running: the next automatic
 * round is minutes away, unless a new connection starts one.
 */
async function whenNobodyPulls(agents: readonly DKGAgent[]): Promise<void> {
  let quietPolls = 0;
  const reached = await pollUntil(
    () => {
      quietPolls = agents.some(isPulling) ? 0 : quietPolls + 1;
      return quietPolls;
    },
    (count) => count >= 3,
    BACKGROUND_SYNC_BOUND_MS,
    500,
  );
  expect(reached, 'the background sync rounds ended within ' + BACKGROUND_SYNC_BOUND_MS + ' ms').toBeGreaterThanOrEqual(3);
}

/** Watch `reader` for `shared`, at most `watchMs`. Never throws: the caller asserts on what was seen. */
async function arrival(reader: DKGAgent, contextGraphId: string, shared: Shared, watchMs: number): Promise<Arrival> {
  const expected = '"' + shared.name + '"';
  let pulledMeanwhile = false;
  const last = await pollUntil(
    async () => {
      pulledMeanwhile ||= isPulling(reader);
      return { ...(await readSharedMemory(reader, contextGraphId, shared)), readAt: Date.now() };
    },
    (read) => read.names.includes(expected),
    watchMs,
    500,
  );
  const elapsed = last.readAt - shared.sharedAt;
  if (last.names.includes(expected)) {
    return {
      afterMs: elapsed,
      // Said, not hidden: with a pull in the watch, an arrival does not show a delivery.
      detail: 'arrived after ' + elapsed + ' ms'
        + (pulledMeanwhile ? ' (the reader ran a background pull meanwhile, which may be what fetched it)' : ''),
    };
  }
  return {
    afterMs: null,
    detail: 'not there ' + elapsed + ' ms after the share' + (last.error ? ' (last read failed: ' + last.error + ')' : ''),
  };
}

/**
 * Watch for a share that has no path across a relay today: for as long as the
 * fix may take, or, without the fix, long enough to say it was not delivered.
 */
function watchAcrossTheRelay(reader: DKGAgent, contextGraphId: string, shared: Shared): Promise<Arrival> {
  return arrival(
    reader,
    contextGraphId,
    shared,
    SUB_GRAPH_SHARES_CROSS_THE_RELAY ? DELIVERY_BOUND_MS : ABSENCE_WATCH_MS,
  );
}

/**
 * The switched assertion. With the fix the share arrived within the bound;
 * without it, it is not there. Soft, so that a test which watches two readers
 * reports both and still checks its links afterwards.
 */
function expectCrossing(what: string, watched: Arrival): void {
  const outcome = what + ': ' + watched.detail;
  if (SUB_GRAPH_SHARES_CROSS_THE_RELAY) {
    expect.soft(watched.afterMs, outcome).not.toBeNull();
  } else {
    expect.soft(
      watched.afterMs,
      outcome + '. If this build delivers across the relay, set SUB_GRAPH_SHARES_CROSS_THE_RELAY to true',
    ).toBeNull();
  }
}

/**
 * Direct sends for the graph that `author` counted as delivered so far: each
 * one is a receiver that answered "applied" to the share it was sent.
 */
function directDeliveries(author: DKGAgent, contextGraphId: string): number {
  return author.getSwmSubstrateFanoutStats().delivered[contextGraphId] ?? 0;
}

/**
 * The proof that a share crossed by being delivered. An arrival alone does
 * not show it: a pull that starts during the watch fetches the share as well.
 * The author's own count of delivered direct sends does, and a pull does not
 * move it. Asserted only with the fix: without it nothing is sent at all.
 */
async function expectDeliveredDirectly(
  what: string,
  author: DKGAgent,
  contextGraphId: string,
  deliveriesBefore: number,
  receivers: number,
): Promise<void> {
  if (!SUB_GRAPH_SHARES_CROSS_THE_RELAY) return;
  await author.awaitInFlightSubstrateFanOuts();
  expect.soft(
    directDeliveries(author, contextGraphId) - deliveriesBefore,
    what + ': receivers that applied the share its author sent them directly',
  ).toBe(receivers);
}

/**
 * What POST /api/context-graph/subscribe does: admit the subscription (prove
 * the name is not registered, fetch the owner-signed policy from a connected
 * peer and accept it), subscribe, and, first thing in its catch-up job, fetch
 * the graph's public definition from a connected peer. A step that did not
 * succeed is repeated within its bound, as a client repeats the request.
 */
async function follow(member: DKGAgent, contextGraphId: string): Promise<void> {
  const admission = await pollUntil(
    () => member.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId),
    (decision) => decision.outcome === 'allowed',
    30_000,
    1_000,
  );
  expect(
    admission.outcome,
    JSON.stringify(admission, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
  ).toBe('allowed');
  member.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on' });
  await member.reconcileRfc64CatalogResponsibilityV1(contextGraphId);
  const accepted = await pollUntil(
    async () => member.hasAcceptedRfc64PublicUnregisteredAuthorityV1(contextGraphId),
    (value) => value === true,
    30_000,
    500,
  );
  expect(accepted, 'the member accepted the owner-signed public policy').toBe(true);
  // Without the definition the member cannot create a sub-graph of the graph.
  const definition = await pollUntil(
    () => member.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(contextGraphId).catch(() => 'failed' as const),
    (outcome) => outcome === 'fetched' || outcome === 'already-confirmed',
    30_000,
    1_000,
  );
  expect(['fetched', 'already-confirmed'], 'the member holds the graph\'s public definition').toContain(definition);
  expect(await member.contextGraphExists(contextGraphId), 'the member knows the graph').toBe(true);
}

const DELIVERY = SUB_GRAPH_SHARES_CROSS_THE_RELAY ? 'reaches' : 'does not reach (the open defect)';

describe('E2E: shared memory between agents linked only through a relay, public unregistered context graph (#3198)', () => {
  const pool = new RealChainAgents();
  const tempDirs: string[] = [];
  let network: RelayOnlyNetwork;
  let owner: DKGAgent;
  let member1: DKGAgent;
  let member2: DKGAgent;
  let everyone: readonly DKGAgent[];
  let contextGraphId: string;

  // A test that builds on an earlier step names it first. When that step
  // failed, the test fails with the step's name, not with a symptom of the
  // half-built state.
  const LINKED = 'the members reach the owner through the relay only';
  const FOLLOWING = 'the members follow the graph';
  const THROUGH_THE_OWNER = 'a member\'s shares reach the other member through the owner';
  const completed = new Set<string>();
  const buildsOn = (step: string): void => {
    expect(completed.has(step), 'not evaluated: the step "' + step + '" of this scenario failed').toBe(true);
  };

  /**
   * An edge agent as a daemon runs it, behind the relay. The data directory
   * matters: with one, the release default follows a graph through the author
   * catalogs; an agent without one runs in legacy mode and tests another node.
   */
  async function createAgent(name: string, operationalKey: string): Promise<DKGAgent> {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-e2e-relay-only-'));
    tempDirs.push(dataDir);
    return pool.create({
      name,
      operationalKey,
      listenHost: '127.0.0.1',
      dataDir,
      ...(await network.addressing()),
    });
  }

  beforeAll(async () => {
    network = await RelayOnlyNetwork.start();
    owner = await createAgent('RelayOnlyOwner', HARDHAT_KEYS.CORE_OP);
    member1 = await createAgent('RelayOnlyMember1', HARDHAT_KEYS.EXTRA1);
    member2 = await createAgent('RelayOnlyMember2', HARDHAT_KEYS.EXTRA2);
    everyone = [owner, member1, member2];
    for (const agent of everyone) await agent.start();

    // POST /api/context-graph/create with accessPolicy 0, and no registration.
    const ownerAddress = owner.getDefaultAgentAddress()!.toLowerCase();
    contextGraphId = ownerAddress + '/relay-only-swm-e2e';
    await owner.createContextGraph({
      id: contextGraphId,
      name: 'Relay-only SWM E2E',
      description: '',
      accessPolicy: 0,
      callerAgentAddress: ownerAddress,
    });
    expect(await owner.isCuratorOf(contextGraphId)).toBe(true);
  }, 120_000);

  afterAll(async () => {
    await pool.stopAll();
    await network?.stop();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  }, 60_000);

  it('1. the members reach the owner through the relay only: relayed, limited, no direct connection', async () => {
    // POST /api/connect with the owner's peer id first resolves the peer's
    // addresses through the DHT. That walk does not resolve among the three
    // nodes of this fixture (connectToPeerId times out), so each member dials
    // what it yields for a node behind a NAT: the owner's circuit address.
    await connectThroughRelay(network, member1, owner);
    await connectThroughRelay(network, member2, owner);

    // Before any share. Without this the rest proves nothing about relays.
    for (const member of [member1, member2]) {
      const link = expectRelayOnlyLink(network, member, owner, 'before any share');
      expectFreshCoreGrant([...link.aToB, ...link.bToA], 'before any share');
    }
    expect(linkConnections(network, member1, member2), 'the members are not connected to each other').toEqual([]);
    completed.add(LINKED);
  }, 60_000);

  it('the members follow the graph over the relay and receive a share into its root', async () => {
    buildsOn(LINKED);
    for (const member of [member1, member2]) await follow(member, contextGraphId);

    // A subscribing node then asks its peers for the graph's shared memory
    // (the rest of the subscribe route's catch-up job). The owner asks its
    // connected peers too, after a connection and every few minutes; that
    // round is made here, now that the members can answer for the graph.
    await askForSharedMemory(member1, owner, contextGraphId, 'member 1, of the owner,');
    await askForSharedMemory(member2, owner, contextGraphId, 'member 2, of the owner,');
    await askForSharedMemory(owner, member1, contextGraphId, 'the owner, of member 1,');
    await askForSharedMemory(owner, member2, contextGraphId, 'the owner, of member 2,');

    // The part that works today. It also is what a member of an empty graph
    // waits for before a daemon lets it write.
    const rootShare = await share(owner, contextGraphId, 'owner-root');
    const [atMember1, atMember2] = await Promise.all([
      arrival(member1, contextGraphId, rootShare, CATALOG_BOUND_MS),
      arrival(member2, contextGraphId, rootShare, CATALOG_BOUND_MS),
    ]);
    expect(atMember1.afterMs, 'the owner\'s root share at member 1: ' + atMember1.detail).not.toBeNull();
    expect(atMember2.afterMs, 'the owner\'s root share at member 2: ' + atMember2.detail).not.toBeNull();

    for (const member of [member1, member2]) expectRelayOnlyLink(network, member, owner, 'after the root share');
    completed.add(FOLLOWING);
  }, 180_000);

  it('2. a share by the owner into a named sub-graph ' + DELIVERY + ' the members', async () => {
    buildsOn(FOLLOWING);
    await whenNobodyPulls(everyone);
    // The owner shared into the root a moment ago, in the test above, when
    // both members had already asked it for the graph. That is the ordinary
    // order, and it is part of what is asserted here: a receiver refuses a
    // root share that reaches it on the direct path (the catalog carries the
    // root), so whatever a sender does with its root share must not cost the
    // peer the sub-graph share that follows. Assertion 3 is the same delivery
    // with no root share by its author before it.
    const deliveriesBefore = directDeliveries(owner, contextGraphId);
    const shared = await share(owner, contextGraphId, 'owner-sub-graph', 'owner-notes');
    const [atMember1, atMember2] = await Promise.all([
      watchAcrossTheRelay(member1, contextGraphId, shared),
      watchAcrossTheRelay(member2, contextGraphId, shared),
    ]);
    expectCrossing('the owner\'s sub-graph share at member 1', atMember1);
    expectCrossing('the owner\'s sub-graph share at member 2', atMember2);
    await expectDeliveredDirectly('the owner\'s sub-graph share', owner, contextGraphId, deliveriesBefore, 2);
    // What was watched crossed, or failed to cross, a relay and nothing else.
    for (const member of [member1, member2]) expectRelayOnlyLink(network, member, owner, 'after the owner\'s sub-graph share');
  }, 240_000);

  it('3. a share by a member into a named sub-graph ' + DELIVERY + ' the owner', async () => {
    buildsOn(FOLLOWING);
    await whenNobodyPulls(everyone);
    const deliveriesBefore = directDeliveries(member1, contextGraphId);
    const shared = await share(member1, contextGraphId, 'member-sub-graph', 'member-1-notes');
    expectCrossing('member 1\'s sub-graph share at the owner', await watchAcrossTheRelay(owner, contextGraphId, shared));
    await expectDeliveredDirectly('member 1\'s sub-graph share', member1, contextGraphId, deliveriesBefore, 1);
    expectRelayOnlyLink(network, member1, owner, 'after the member\'s sub-graph share');
  }, 240_000);

  it('4. a share by a member reaches the other member through the owner', async () => {
    buildsOn(FOLLOWING);
    await whenNobodyPulls(everyone);

    // What this expects, and why.
    //
    // A share is delivered by its author to the peers the author is connected
    // to, and member 2 is connected to the owner only. Gossip does not run
    // across a relayed connection, so the owner passes member 1's share on
    // (#1611): for a named sub-graph it sends its followers a change notice,
    // and member 2 pulls the graph's shared memory from the owner at once,
    // which also registers the sub-graph there; for the root it hands the
    // announcement of member 1's catalog head to its catalog delivery, and
    // member 2's catalog receiver pulls the head from the owner. Neither
    // carries any data.
    expect(linkConnections(network, member1, member2), 'the members are not connected to each other').toEqual([]);
    // The owner's notice of assertion 3's share started a pull on member 2
    // that may still run: the notices recorded below are this test's.
    await member2.whenSwmChangeNoticesSettledV1();
    const notices = recordChangeNotices(member2);
    const handoffs = recordCatalogHeadHandoffs(owner);

    const subGraphShare = await share(member1, contextGraphId, 'member-sub-graph-unconnected', 'member-1-notes');
    const subGraphAtMember2 = await arrival(member2, contextGraphId, subGraphShare, DELIVERY_BOUND_MS);
    expect(
      subGraphAtMember2.afterMs,
      'member 1\'s sub-graph share at member 2, which member 1 has no connection to: ' + subGraphAtMember2.detail,
    ).not.toBeNull();
    expect(
      notices.filter((disposition) => disposition === 'pulling' || disposition === 'coalesced'),
      'member 2 pulled on the owner\'s change notice (dispositions: ' + notices.join(', ') + ')',
    ).not.toEqual([]);
    expect(
      await partitionsHolding(member2, contextGraphId, subGraphShare),
      'member 1\'s sub-graph share in member 2\'s read over the graph\'s partitions',
    ).toHaveLength(1);
    expect(
      (await member2.listSubGraphs(contextGraphId)).map((subGraph) => subGraph.name),
      'the sub-graphs member 2 lists',
    ).toContain('member-1-notes');

    const rootShare = await share(member1, contextGraphId, 'member-root-unconnected');
    const rootAtMember2 = await arrival(member2, contextGraphId, rootShare, DELIVERY_BOUND_MS);
    expect(
      rootAtMember2.afterMs,
      'member 1\'s root share at member 2, which member 1 has no connection to: ' + rootAtMember2.detail,
    ).not.toBeNull();
    const member1Heads = handoffs.filter(({ author }) => author === member1.getDefaultAgentAddress()!.toLowerCase());
    expect(member1Heads, 'the owner handed member 1\'s root head to its catalog delivery').not.toEqual([]);
    for (const { peers } of member1Heads) {
      expect(peers, 'the peers the owner named for member 1\'s head').toContain(member2.peerId);
      expect(peers, 'the peers the owner named for member 1\'s head').not.toContain(member1.peerId);
    }
    console.log(
      '[#1611] member 1 to member 2 through the owner: sub-graph share ' + subGraphAtMember2.afterMs
        + ' ms, root share ' + rootAtMember2.afterMs + ' ms',
    );
    expect(
      linkConnections(network, member1, member2),
      'the members were still not connected when member 2 got both shares',
    ).toEqual([]);
    completed.add(THROUGH_THE_OWNER);
  }, 240_000);

  it('5. a notice that arrives while a member pulls the graph from the owner brings one more pull', async () => {
    buildsOn(THROUGH_THE_OWNER);
    await whenNobodyPulls(everyone);
    await member2.whenSwmChangeNoticesSettledV1();
    expect(linkConnections(network, member1, member2), 'the members are not connected to each other').toEqual([]);
    // Member 2 pulls the whole graph on a notice. Its pull on the notice of
    // the first share is held after the metadata fetch while the owner
    // applies a share into another sub-graph and tells member 2: the held
    // pull read no metadata of that share, and cannot bring it.
    const notices = recordChangeNotices(member2);
    const held = holdNextPullAfterMetadata(member2, owner, contextGraphId);
    try {
      const first = await share(member1, contextGraphId, 'member-sub-graph-during-pull-a', 'member-1-held-a');
      await held.reached;
      const second = await share(member1, contextGraphId, 'member-sub-graph-during-pull-b', 'member-1-held-b');
      const handled = await pollUntil(() => notices.length, (count) => count >= 2, DELIVERY_BOUND_MS, 200);
      expect(handled, 'member 2 handled the owner\'s notices of both shares').toBeGreaterThanOrEqual(2);
      // Soft: without one pull per graph and sender the second notice starts
      // a pull of its own, and the test goes on to show what that pull misses.
      expect.soft(notices[1], 'the second notice, while the first pull runs (dispositions: ' + notices.join(', ') + ')')
        .toBe('coalesced');
      held.release();
      const [firstAtMember2, secondAtMember2] = await Promise.all([
        arrival(member2, contextGraphId, first, DELIVERY_BOUND_MS),
        arrival(member2, contextGraphId, second, DELIVERY_BOUND_MS),
      ]);
      expect(firstAtMember2.afterMs, 'the first share at member 2: ' + firstAtMember2.detail).not.toBeNull();
      expect(secondAtMember2.afterMs, 'the share made while member 2 pulled: ' + secondAtMember2.detail).not.toBeNull();
      console.log(
        '[#1611] a notice during a pull: the first share ' + firstAtMember2.afterMs + ' ms, the second '
          + secondAtMember2.afterMs + ' ms',
      );
    } finally {
      held.restore();
    }
  }, 240_000);

  it('6. a notice that arrives during a periodic pull of the graph is not answered by that pull', async () => {
    buildsOn(THROUGH_THE_OWNER);
    await whenNobodyPulls(everyone);
    await member2.whenSwmChangeNoticesSettledV1();
    // The pull the reconciler makes of the graph from its owner, held after
    // its metadata fetch. A notice pull would be the same sync of the graph,
    // and must not take that one's result as its own.
    const notices = recordChangeNotices(member2);
    const held = holdNextPullAfterMetadata(member2, owner, contextGraphId);
    try {
      const periodic = member2.syncSharedMemoryFromPeerDetailed(owner.peerId, [contextGraphId], { source: 'reconcile' });
      await held.reached;
      const shared = await share(member1, contextGraphId, 'member-sub-graph-during-periodic-pull', 'member-1-periodic');
      const handled = await pollUntil(() => notices.length, (count) => count >= 1, DELIVERY_BOUND_MS, 200);
      expect(handled, 'member 2 handled the owner\'s notice').toBeGreaterThanOrEqual(1);
      expect(notices[0], 'the notice during the periodic pull').toBe('pulling');
      held.release();
      await periodic;
      const atMember2 = await arrival(member2, contextGraphId, shared, DELIVERY_BOUND_MS);
      expect(atMember2.afterMs, 'the share made during the periodic pull, at member 2: ' + atMember2.detail).not.toBeNull();
      console.log('[#1611] a notice during a periodic pull: the share ' + atMember2.afterMs + ' ms');
    } finally {
      held.restore();
    }
  }, 240_000);

  it('7. a share by a member reaches the other member directly once the two are connected', async () => {
    buildsOn(FOLLOWING);
    await whenNobodyPulls(everyone);

    // Then the two connect, through the relay like every other link here, and
    // ask each other for the graph's shared memory. That, and the background
    // sync the connection starts, brings each what the other shared before;
    // the test waits for it to end, so that the next share can only arrive by
    // being delivered.
    await connectThroughRelay(network, member2, member1);
    expectRelayOnlyLink(network, member1, member2, 'the members, after they connected');
    await askForSharedMemory(member1, member2, contextGraphId, 'member 1, of member 2,');
    await askForSharedMemory(member2, member1, contextGraphId, 'member 2, of member 1,');
    await whenNobodyPulls(everyone);

    // Now the same kind of share as in assertion 4 has a connection to
    // cross. Its author last worked out whom to send to before member 2
    // connected, so this also requires that a peer which has just asked for
    // the graph counts at once. The switch decides what is expected.
    const deliveriesBefore = directDeliveries(member1, contextGraphId);
    const connected = await share(member1, contextGraphId, 'member-sub-graph-connected', 'member-1-notes');
    expectCrossing('member 1\'s sub-graph share at member 2', await watchAcrossTheRelay(member2, contextGraphId, connected));
    // To the owner and, now, to member 2.
    await expectDeliveredDirectly('member 1\'s sub-graph share after the members connected', member1, contextGraphId, deliveriesBefore, 2);
    expectRelayOnlyLink(network, member1, member2, 'the members, after the sub-graph share');
  }, 360_000);

  it('8. a member without the change notice protocol is left alone', async () => {
    buildsOn(FOLLOWING);
    await whenNobodyPulls(everyone);
    // A node of an older release has no handler for the notice: take member
    // 2's away. The owner leaves it out once identify has told it, or fails
    // to open the stream once and does not send it again (#3421).
    (member2 as unknown as { router: { unregister(protocolId: string): void } }).router
      .unregister(PROTOCOL_SWM_CHANGE_NOTICE);
    const ownerLog = vi.spyOn((owner as unknown as { log: { info(...args: unknown[]): void } }).log, 'info');
    try {
      const shared = await share(member1, contextGraphId, 'member-sub-graph-older-reader', 'member-1-notes');
      const atOwner = await arrival(owner, contextGraphId, shared, DELIVERY_BOUND_MS);
      expect(atOwner.afterMs, 'member 1\'s share at the owner: ' + atOwner.detail).not.toBeNull();
      const noticeLine = await pollUntil(
        async () => ownerLog.mock.calls
          .map(([, message]) => String(message))
          .find((message) => message.startsWith('SWM change notice for') && message.includes('sub-graph "member-1-notes"')),
        (line) => line !== undefined,
        DELIVERY_BOUND_MS,
        500,
      );
      expect(noticeLine, 'the owner\'s change notice line after the share')
        .toMatch(/reached 0 of 0 follower\(s\); 1 without the notice protocol$/);
    } finally {
      ownerLog.mockRestore();
    }
  }, 180_000);
});
