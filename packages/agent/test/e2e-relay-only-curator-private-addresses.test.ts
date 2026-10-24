/**
 * E2E (#3421): a member of a registered, curated graph whose curator is
 * reachable only through a relay and announces addresses no peer can reach.
 *
 * A curator in a private network, with no public address, lists every
 * interface it has: loopback, a LAN address, a container bridge, a VPN address
 * in the shared range (100.64/10), and its relay circuit. A member then holds
 * an open circuit to the curator and a set of direct addresses that go
 * nowhere. A router that takes those for a direct route dials for every
 * request: a dial that tries them spends the request's time (libp2p tries
 * circuits through a local relay, as here, after private addresses), and a
 * dial that ends on a second circuit starts the connection work again at
 * both ends.
 *
 * With `publicAddressesOnly` (what the daemon sets for an Edge whose relays
 * are all public) only public addresses count as a direct route, so the open
 * circuit carries every request. Both agents here run with it and both
 * announce unreachable private addresses (`addressing({ interfaces: true })`).
 *
 * What is asserted, over one relay-only link:
 *  1. the precondition: the member reaches the curator through the relay only,
 *     and its peer store lists the curator's unreachable addresses;
 *  2. after the curator approves the member's join request, the member holds
 *     the curator's metadata naming it (the listing says it is involved), and
 *     its write into the graph goes through;
 *  3. a sync from the curator completes over the circuit, and the curator's
 *     shared memory reaches the member;
 *  and, for all of it, the member opened no stream by dialing the curator.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { peerIdFromString } from '@libp2p/peer-id';
import type { DKGAgent } from '../src/index.js';
import { RealChainAgents, pollUntil } from './_helpers/real-chain-agent.js';
import { RelayOnlyNetwork, connectThroughRelay, expectRelayOnlyLink } from './_helpers/relay-only-network.js';
import {
  HARDHAT_KEYS,
  createProvider,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

const NAME = 'http://schema.org/name';
/** A run of this file never collides with another run's graphs. */
const RUN = Date.now().toString(36);
const CURATOR_KEY = HARDHAT_KEYS.CORE_OP;
const MEMBER_KEY = HARDHAT_KEYS.EXTRA1;
/** Generous for a loaded host: over an open circuit each of these takes seconds. */
const BOUND_MS = 60_000;

let fileSnapshot: string;
beforeAll(async () => {
  fileSnapshot = await takeSnapshot();
  // Registering a Context Graph pulls the registration deposit.
  const { hubAddress } = getSharedContext();
  const curator = new ethers.Wallet(CURATOR_KEY);
  await mintTokens(createProvider(), hubAddress, HARDHAT_KEYS.DEPLOYER, curator.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(fileSnapshot);
});

/** POST /api/knowledge-assets (create + write), then swm/share, into the graph's root. */
async function writeAndShare(author: DKGAgent, contextGraphId: string, name: string) {
  const subject = `urn:e2e:3421:${RUN}:${name}`;
  await author.assertion.create(contextGraphId, name);
  await author.assertion.write(contextGraphId, name, [{ subject, predicate: NAME, object: `"${name}"` }]);
  return { subject, promoted: await author.assertion.promote(contextGraphId, name) };
}

async function sharedNames(reader: DKGAgent, contextGraphId: string, subject: string): Promise<string[]> {
  const result = await reader.query(`SELECT ?name WHERE { <${subject}> <${NAME}> ?name }`, {
    contextGraphId,
    graphSuffix: '_shared_memory',
  });
  return result.bindings.map((row) => String(row['name']));
}

describe('E2E: a relay-only curator that announces unreachable private addresses (#3421)', () => {
  const pool = new RealChainAgents();
  const tempDirs: string[] = [];
  let network: RelayOnlyNetwork;
  let curator: DKGAgent;
  let member: DKGAgent;
  let curatorAddress: string;
  /** A custodial agent of the member's node, the one that asks to join: it signs the request. */
  let memberAddress: string;
  let contextGraphId: string;
  /** Streams the member opened by dialing the curator (libp2p `dialProtocol`), from the link on. */
  const dialsToCurator: string[] = [];

  const LINKED = 'the member reaches the curator through the relay only';
  const APPROVED = 'the approved member holds the curator\'s metadata';
  const completed = new Set<string>();
  const buildsOn = (step: string): void => {
    expect(completed.has(step), 'not evaluated: the step "' + step + '" of this scenario failed').toBe(true);
  };

  /** An Edge as a daemon on a public network runs it, behind the relay. */
  async function createAgent(name: string, operationalKey: string): Promise<DKGAgent> {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-e2e-3421-'));
    tempDirs.push(dataDir);
    return pool.create({
      name,
      operationalKey,
      listenHost: '127.0.0.1',
      dataDir,
      publicAddressesOnly: true,
      ...(await network.addressing({ interfaces: true })),
    });
  }

  beforeAll(async () => {
    network = await RelayOnlyNetwork.start();
    curator = await createAgent('RelayOnlyCurator3421', CURATOR_KEY);
    member = await createAgent('RelayOnlyMember3421', MEMBER_KEY);
    await curator.start();
    await member.start();
    curatorAddress = curator.getDefaultAgentAddress()!.toLowerCase();
    memberAddress = (await member.registerAgent('relay-only-member-3421', { framework: 'test' })).agentAddress;

    const libp2p = member.node.libp2p;
    const dialProtocol = libp2p.dialProtocol.bind(libp2p);
    libp2p.dialProtocol = ((peer, protocols, options) => {
      if (peer.toString() === curator.peerId) dialsToCurator.push(String(protocols));
      return dialProtocol(peer, protocols, options);
    }) as typeof libp2p.dialProtocol;
  }, 120_000);

  afterAll(async () => {
    await pool.stopAll();
    await network?.stop();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  }, 60_000);

  it('1. the member reaches the curator through the relay only, and holds the curator\'s unreachable addresses', async () => {
    await connectThroughRelay(network, member, curator);
    expectRelayOnlyLink(network, member, curator, 'before the graph exists');

    const listed = (await member.node.libp2p.peerStore.get(peerIdFromString(curator.peerId))).addresses
      .map(({ multiaddr }) => multiaddr.toString());
    for (const prefix of ['/ip4/127.0.0.1/', '/ip4/10.254.', '/ip4/172.17.0.1/', '/ip4/100.64.']) {
      expect(listed.some((address) => address.startsWith(prefix)), `the member's store lists ${prefix}…: ${listed.join(', ')}`)
        .toBe(true);
    }
    completed.add(LINKED);
  }, 60_000);

  it('2. once approved, the member holds the curator\'s metadata naming it, and writes into the graph', async () => {
    buildsOn(LINKED);
    // POST /api/context-graph/create with register: true: public, with a curated publish policy.
    contextGraphId = `${curatorAddress}/relay-only-curator-${RUN}`;
    await curator.createContextGraph({
      id: contextGraphId, name: 'Relay-only curator E2E', description: '', accessPolicy: 0, callerAgentAddress: curatorAddress,
    });
    const registered = await curator.registerContextGraph(contextGraphId, {
      accessPolicy: 0, publishPolicy: 1, callerAgentAddress: curatorAddress,
    });
    const onChainId = String(registered.onChainId);
    expect(Number(onChainId)).toBeGreaterThan(0);

    // POST /api/context-graph/subscribe: the chain admits it, and it subscribes.
    const admission = await pollUntil(
      () => member.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
        callerAgentAddress: memberAddress, allowSubscriptionFallback: false,
      }),
      (decision) => decision.outcome === 'allowed',
      BOUND_MS,
      1_000,
    );
    expect(admission).toMatchObject({ outcome: 'allowed', source: 'registered-chain' });
    member.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on', onChainId });

    // POST /api/context-graph/<id>/request-join, then the curator's approve-join.
    const delegation = await member.signJoinRequest(contextGraphId, memberAddress);
    const forwarded = await member.forwardJoinRequest(contextGraphId, delegation, 'RelayOnlyMember3421', curator.peerId);
    expect(forwarded.delivered, `forward result: ${JSON.stringify(forwarded)}`).toBeGreaterThanOrEqual(1);
    const pending = await pollUntil(
      () => curator.listPendingJoinRequests(contextGraphId),
      (rows) => rows.some((row: { agentAddress?: unknown }) => String(row.agentAddress).toLowerCase() === memberAddress.toLowerCase()),
      BOUND_MS,
      500,
    );
    expect(pending.length, 'the join request is pending at the curator').toBeGreaterThan(0);
    await curator.approveJoinRequest(contextGraphId, memberAddress, curatorAddress);
    const status = await pollUntil(() => member.getJoinRequestStatus(contextGraphId, memberAddress), (s) => s === 'approved', BOUND_MS, 500);
    expect(status, 'the approval reached the member').toBe('approved');

    // The member's post-approval sync pulls the curator's metadata, with the
    // allowlist that names it, over the open circuit.
    const row = await pollUntil(
      async () => (await member.listContextGraphs({ callerAgentAddress: memberAddress }))
        .find((candidate) => candidate.id === contextGraphId),
      (candidate) => candidate?.callerInvolved === true,
      BOUND_MS,
      1_000,
    );
    expect(row, 'the member\'s listing row for the graph').toMatchObject({ subscribed: true, callerInvolved: true });

    const written = await writeAndShare(member, contextGraphId, 'member-write');
    expect(written.promoted.sealed, 'the member\'s write was sealed and shared').toBe(true);
    expectRelayOnlyLink(network, member, curator, 'after the approval');
    completed.add(APPROVED);
  }, 240_000);

  it('3. a sync from the curator completes over the circuit, and the curator\'s shared memory reaches the member', async () => {
    buildsOn(APPROVED);
    const shared = await writeAndShare(curator, contextGraphId, 'curator-share');
    expect(shared.promoted.sealed).toBe(true);

    const result = await pollUntil(
      () => member.syncSharedMemoryFromPeerDetailed(curator.peerId, [contextGraphId]).catch(() => undefined),
      (outcome) => outcome !== undefined && outcome.completedPhases > 0 && outcome.deniedPhases === 0,
      BOUND_MS,
      1_000,
    );
    expect(result?.completedPhases ?? 0, 'phases the sync from the curator completed').toBeGreaterThan(0);
    expect(result?.deniedPhases, 'phases the curator denied').toBe(0);
    const names = await pollUntil(() => sharedNames(member, contextGraphId, shared.subject), (found) => found.length > 0, BOUND_MS, 500);
    expect(names).toEqual(['"curator-share"']);

    expectRelayOnlyLink(network, member, curator, 'after the sync');
    expect(dialsToCurator, 'streams the member opened by dialing the curator instead of using the open circuit').toEqual([]);
  }, 240_000);
});
