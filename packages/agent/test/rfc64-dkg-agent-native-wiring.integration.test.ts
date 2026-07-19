import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { multiaddr } from '@multiformats/multiaddr';
import {
  computeAuthorCatalogScopeDigestV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type NetworkIdV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';

import { DKGAgent } from '../src/dkg-agent.js';
import { snapshotRfc64CatalogDeploymentProfileV1 } from '../src/dkg-agent-rfc64-catalog.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/native-wiring' as ContextGraphIdV1;
const FIXED_HEAD_ISSUED_AT = '1773900000000' as TimestampMsV1;
const DELEGATION_EFFECTIVE_AT = '1773899999999' as TimestampMsV1;
const DELEGATION_EXPIRES_AT = '1773900000001' as TimestampMsV1;
const NATIVE_DEPLOYMENT = Object.freeze({
  networkId: NETWORK_ID,
  assertedAtChainId: '20430',
  assertedAtKav10Address: '0x4444444444444444444444444444444444444444',
}) as CatalogSealDeploymentProfileV1;

const agents: DKGAgent[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) {
    try { await agent.stop(); } catch { /* best-effort */ }
  }
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function startNativeAgent(
  name: string,
  deployment: CatalogSealDeploymentProfileV1 = NATIVE_DEPLOYMENT,
  existingDataDir?: string,
): Promise<DKGAgent> {
  const dataDir = existingDataDir
    ?? await mkdtemp(join(tmpdir(), `dkg-rfc64-native-${name}-`));
  if (existingDataDir === undefined) tempDirs.push(dataDir);
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
    rfc64CatalogDeploymentProfile: deployment,
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
  await a.node.libp2p.dial(multiaddr(tcpMultiaddr(b)));
  await b.node.libp2p.dial(multiaddr(tcpMultiaddr(a)));
}

function catalogScopeDigest() {
  return computeAuthorCatalogScopeDigestV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    era: '0' as never,
    bucketCount: '1' as never,
  });
}

describe('RFC-64 DKGAgent production native catalog wiring', () => {
  it('snapshots and canonicalizes the deterministic local deployment override', () => {
    const callerOwned = {
      networkId: NETWORK_ID,
      assertedAtChainId: '20430',
      assertedAtKav10Address: ethers.getAddress(
        '0x4444444444444444444444444444444444444444',
      ),
    } as CatalogSealDeploymentProfileV1;
    const snapshot = snapshotRfc64CatalogDeploymentProfileV1(callerOwned)!;
    (callerOwned as { networkId: NetworkIdV1 }).networkId = 'hostile:1' as NetworkIdV1;
    expect(snapshot).toEqual(NATIVE_DEPLOYMENT);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => snapshotRfc64CatalogDeploymentProfileV1({
      ...NATIVE_DEPLOYMENT,
      assertedAtKav10Address: `0x${'00'.repeat(20)}` as never,
    })).toThrow(/non-zero EVM address/);
  });

  it('uses the trusted override to fetch provider content and durably apply native genesis', async () => {
    const [author, receiver] = await Promise.all([
      startNativeAgent('author'),
      startNativeAgent('receiver'),
    ]);
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
      peers: [],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
    });
    expect(published.announcement.policyDigest).toBe(receiverPolicy.policyDigest);
    expect(published.announcedPeers).toEqual([]);
    const delivery = await author.announceRfc64PublicCatalogHeadV1({
      announcement: published.announcement,
      peers: [receiver.peerId],
    });
    expect(delivery.announcedPeers).toEqual([receiver.peerId]);
    expect(delivery.failedPeers).toEqual([]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();

    const scopeDigest = catalogScopeDigest();
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: scopeDigest,
      authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    })).toMatchObject({
      catalogScopeDigest: scopeDigest,
      currentCatalogHeadDigest: published.headObjectDigest,
      catalogVersion: '0',
      inventoryRowCount: '0',
    });
    expect(receiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      published.headObjectDigest,
    )).toMatchObject({
      catalogHeadDigest: published.headObjectDigest,
      inventoryRowCount: 0,
      activatedTripleCount: 0,
      stagedObjectCount: 3,
      appliedHeadStatus: 'applied',
    });
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toBeNull();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 1,
      stagedOnly: 0,
      failed: 0,
    });

    const replay = await author.announceRfc64PublicCatalogHeadV1({
      announcement: published.announcement,
      peers: [receiver.peerId],
    });
    expect(replay.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 1,
      dedupedAlreadyApplied: 1,
    });
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toBeNull();
  }, 60_000);

  it('exposes bounded typed failure evidence when wire scope differs from local deployment', async () => {
    const [author, receiver] = await Promise.all([
      startNativeAgent('mismatch-author'),
      startNativeAgent('mismatch-receiver', {
        ...NATIVE_DEPLOYMENT,
        networkId: 'base:8453' as NetworkIdV1,
      }),
    ]);
    receiver.acceptOpenContextGraphPolicyV1({
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
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
    });
    expect(published.announcedPeers).toEqual([receiver.peerId]);
    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(receiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    })).toBeNull();
    expect(receiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      published.headObjectDigest,
    )).toBeNull();
    expect(receiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 0,
      failed: 1,
    });
    const failure = receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    );
    expect(failure).toEqual({
      catalogHeadDigest: published.headObjectDigest,
      errorName: 'Rfc64PublicCatalogNativeReceiverErrorV1',
      errorCode: 'catalog-native-receiver-authorization',
    });
    expect(Object.isFrozen(failure)).toBe(true);

    await receiver.stop();
    agents.splice(agents.indexOf(receiver), 1);
    expect(receiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toBeNull();
  }, 60_000);

  it('rejects a stale-network durable dedupe after restart under a new local pin', async () => {
    const receiverDataDir = await mkdtemp(join(tmpdir(), 'dkg-rfc64-native-repin-'));
    tempDirs.push(receiverDataDir);
    const [author, firstReceiver] = await Promise.all([
      startNativeAgent('repin-author'),
      startNativeAgent('repin-receiver', NATIVE_DEPLOYMENT, receiverDataDir),
    ]);
    firstReceiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    });
    await connectBothWays(author, firstReceiver);
    const published = await author.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR_WALLET,
      peers: [firstReceiver.peerId],
      issuedAt: FIXED_HEAD_ISSUED_AT,
      catalogIssuerDelegationEffectiveAt: DELEGATION_EFFECTIVE_AT,
      catalogIssuerDelegationExpiresAt: DELEGATION_EXPIRES_AT,
    });
    await firstReceiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(firstReceiver.readRfc64AppliedCatalogHeadV1({
      catalogScopeDigest: catalogScopeDigest(),
      authorAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    })?.currentCatalogHeadDigest).toBe(published.headObjectDigest);

    await firstReceiver.stop();
    agents.splice(agents.indexOf(firstReceiver), 1);
    const restartedReceiver = await startNativeAgent('repin-receiver', {
      ...NATIVE_DEPLOYMENT,
      networkId: 'base:8453' as NetworkIdV1,
    }, receiverDataDir);
    restartedReceiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_WALLET.address.toLowerCase() as never,
    });
    await connectBothWays(author, restartedReceiver);
    const delivery = await author.announceRfc64PublicCatalogHeadV1({
      announcement: published.announcement,
      peers: [restartedReceiver.peerId],
    });
    expect(delivery.announcedPeers).toEqual([restartedReceiver.peerId]);
    await restartedReceiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(restartedReceiver.rfc64PublicCatalogStatsV1()?.receiver).toMatchObject({
      applied: 0,
      dedupedAlreadyApplied: 0,
      failed: 1,
    });
    expect(restartedReceiver.readRfc64PublicCatalogSynchronizationEvidenceV1(
      published.headObjectDigest,
    )).toBeNull();
    expect(restartedReceiver.readRfc64PublicCatalogReconciliationFailureV1(
      published.headObjectDigest,
    )).toEqual({
      catalogHeadDigest: published.headObjectDigest,
      errorName: 'Rfc64PublicCatalogNativeReceiverErrorV1',
      errorCode: 'catalog-native-receiver-authorization',
    });
  }, 60_000);
});
