import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';

import { DKGAgent } from '../src/dkg-agent.js';
import type {
  ContextGraphIdV1,
  NetworkIdV1,
  TimestampMsV1,
} from '@origintrail-official/dkg-core';

/**
 * Gate 1 end-to-end across TWO real DKGAgent instances, driven entirely through
 * the WIRED path: `DKGAgent.create()` + `agent.start()` constructs and starts
 * the public catalog service on each agent's production router; the author
 * publishes+announces via the agent method; the receiver's wired
 * `onCatalogHeadAvailable` + scheduler fetch, re-verify, and durably stage.
 * Nothing here reconstructs the transport by hand.
 */

const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/gate-1' as ContextGraphIdV1;
const FIXED_HEAD_ISSUED_AT = '1773900000000' as TimestampMsV1;

const agents: DKGAgent[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    try { await agent.stop(); } catch { /* best-effort */ }
  }
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function startAgent(name: string): Promise<DKGAgent> {
  const dataDir = await mkdtemp(join(tmpdir(), `dkg-rfc64-gate1-${name}-`));
  tempDirs.push(dataDir);
  const agent = await DKGAgent.create({
    name,
    dataDir,
    listenHost: '127.0.0.1',
    listenPort: 0,
    bootstrapPeers: [],
    nodeRole: 'edge',
    store: new OxigraphStore(),
    syncSharedMemoryOnConnect: false,
    syncReconcilerEnabled: false,
    syncOnConnectEnabled: false,
    durableSyncEnabled: false,
    agentProfileHeartbeatMs: 0,
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

function tcpMultiaddr(agent: DKGAgent): string {
  const address = agent.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
  if (address === undefined) throw new Error('agent has no TCP multiaddr');
  return address;
}

async function connectBothWays(a: DKGAgent, b: DKGAgent): Promise<void> {
  // Raw libp2p dials (chain-free → network admission is disabled). A single
  // libp2p connection is bidirectional; dialing both ways just seeds both
  // peer stores so the production router's send() can resolve either peer.
  await a.node.libp2p.dial(multiaddr(tcpMultiaddr(b)));
  await b.node.libp2p.dial(multiaddr(tcpMultiaddr(a)));
}

describe('RFC-64 Gate 1 public catalog wiring — two real DKGAgent instances', () => {
  it('announces, fetches, re-verifies, and durably stages the exact head; dedups; no activation', async () => {
    const [author, receiver] = await Promise.all([startAgent('author'), startAgent('receiver')]);

    // The wired service must be live on both started agents (assert via the
    // agent's own accessor, not a hand-built transport).
    expect(author.rfc64PublicCatalogStatsV1()?.started).toBe(true);
    expect(receiver.rfc64PublicCatalogStatsV1()?.started).toBe(true);

    // The receiver independently accepts the SAME open policy from CG-identity
    // facts it holds locally (owner = the author EOA) — BEFORE any announcement.
    // This is the honesty boundary: the receiver's policyDigest comes from its
    // own accepted policy object, never from the untrusted wire announcement.
    const receiverPolicy = receiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    });

    await connectBothWays(author, receiver);

    const published = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [receiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
    });

    // Author and receiver independently computed the same policy digest.
    expect(published.announcement.policyDigest).toBe(receiverPolicy.policyDigest);
    // The announcement was acknowledged by the receiver over the production
    // router — proving send() delivers across the dialed connection + admission.
    expect(published.announcedPeers).toEqual([receiver.peerId]);
    expect(published.failedPeers).toEqual([]);

    // The receiver's wired scheduler fetched + staged the head.
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    // Durably staged the EXACT head: read it back from the receiver's
    // control-object store by the announced digests.
    const stagedDigest = await receiver.readRfc64StagedAuthorCatalogHeadV1({
      objectDigest: published.headObjectDigest,
      signatureVariantDigest: published.signatureVariantDigest,
    });
    expect(stagedDigest).toBe(published.headObjectDigest);

    const receiverStats = receiver.rfc64PublicCatalogStatsV1();
    expect(receiverStats?.receiver).toMatchObject({
      stagedOnly: 1,
      applied: 0,
      notFound: 0,
      failed: 0,
    });

    // Re-announcing the identical head may replay the idempotent diagnostic
    // stage, because staging alone is deliberately no longer the completion
    // boundary. Only a durable applied-inventory record may suppress work.
    const republished = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [receiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
    });
    expect(republished.announcement.catalogHeadObjectDigest).toBe(published.headObjectDigest);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const afterStats = receiver.rfc64PublicCatalogStatsV1();
    expect(afterStats?.receiver).toMatchObject({
      stagedOnly: 2,
      applied: 0,
      dedupedAlreadyApplied: 0,
    });

    // NO KA/SWM activation: the head lives only in the control-object cache;
    // the receiver never activated the CG as queryable knowledge.
    const activeContextGraphs = await receiver.listContextGraphs();
    expect(
      activeContextGraphs.some(
        (row) => row.id === CONTEXT_GRAPH_ID || row.uri.includes(CONTEXT_GRAPH_ID),
      ),
    ).toBe(false);
  }, 60_000);

  it('fails closed when the receiver holds no accepted open policy for the CG', async () => {
    const [author, receiver] = await Promise.all([startAgent('author2'), startAgent('receiver2')]);
    // Receiver does NOT accept any policy → its authorizer returns null →
    // inbound announce is denied and the head is never fetched/staged.
    await connectBothWays(author, receiver);

    const published = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [receiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
    });
    // The announcement is refused by the receiver's policy gate.
    expect(published.announcedPeers).toEqual([]);
    expect(published.failedPeers).toHaveLength(1);

    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    const stagedDigest = await receiver.readRfc64StagedAuthorCatalogHeadV1({
      objectDigest: published.headObjectDigest,
      signatureVariantDigest: published.signatureVariantDigest,
    });
    expect(stagedDigest).toBeNull();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      stagedOnly: 0,
      applied: 0,
    });
  }, 60_000);
});
