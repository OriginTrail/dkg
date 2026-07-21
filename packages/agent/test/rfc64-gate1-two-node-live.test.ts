import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import type {
  ContextGraphIdV1,
  EvmAddressV1,
  NetworkIdV1,
  TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';

import { DKGAgent } from '../src/index.js';

const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/gate-1-live' as ContextGraphIdV1;
const ISSUED_AT = '1773900000000' as TimestampMsV1;
const AUTHOR = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const AUTHOR_ADDRESS = AUTHOR.address.toLowerCase() as EvmAddressV1;

const agents: DKGAgent[] = [];
const dataDirectories: string[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0).reverse()) {
    try { await agent.stop(); } catch {}
  }
  await Promise.all(dataDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

async function createLiveAgent(name: string): Promise<DKGAgent> {
  const dataDir = await mkdtemp(join(tmpdir(), `dkg-rfc64-${name.toLowerCase()}-`));
  dataDirectories.push(dataDir);
  const agent = await DKGAgent.create({
    name,
    dataDir,
    listenPort: 0,
    skills: [],
    chainAdapter: new MockChainAdapter('mock:31337'),
    nodeRole: 'edge',
    syncOnConnectEnabled: false,
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

describe('RFC-64 Gate 1 two-node live evidence', () => {
  it('moves exactly one signed catalog head into the live receiver by exact digests', async () => {
    const [sender, receiver] = await Promise.all([
      createLiveAgent('Rfc64Gate1Sender'),
      createLiveAgent('Rfc64Gate1Receiver'),
    ]);
    const senderAddress = sender.multiaddrs.find((address) =>
      address.includes('/tcp/') && !address.includes('/p2p-circuit'));
    if (senderAddress === undefined) throw new Error('sender has no direct TCP multiaddr');
    await receiver.connectTo(senderAddress);

    receiver.acceptOpenContextGraphPolicyV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      ownerAddress: AUTHOR_ADDRESS,
    });

    const publication = await sender.publishOpenAuthorCatalogGenesisV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      author: AUTHOR,
      peers: [receiver.peerId],
      issuedAt: ISSUED_AT,
    });
    expect(publication.failedPeers).toEqual([]);
    expect(publication.announcedPeers).toEqual([receiver.peerId]);

    await receiver.whenRfc64PublicCatalogReceiverIdleV1();
    expect(receiver.rfc64PublicCatalogStatsV1()).toMatchObject({
      acceptedPolicies: 1,
      receiver: {
        scheduled: 1,
        staged: 1,
        failed: 0,
        notFound: 0,
        inFlight: 0,
        queued: 0,
      },
    });

    const receivedDigest = await receiver.readRfc64StagedAuthorCatalogHeadV1({
      objectDigest: publication.headObjectDigest,
      signatureVariantDigest: publication.signatureVariantDigest,
    });
    expect(receivedDigest).toBe(publication.headObjectDigest);
    expect(publication.announcement).toMatchObject({
      catalogEra: '0',
      catalogVersion: '0',
      catalogHeadObjectDigest: publication.headObjectDigest,
      signatureVariantDigest: publication.signatureVariantDigest,
    });
  }, 30_000);
});
