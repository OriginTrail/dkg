/**
 * The legacy publish protocol (/dkg/10.0.0/publish) is not served. Publishing
 * moved to the V10 lifecycle and StorageACK, and no node sends on the old
 * protocol, so a started node does not register it and a peer that asks for it
 * is refused when the protocol is selected. Tentative publishes that an earlier
 * version journaled are still restored at start, so they can be confirmed on
 * chain or expire and be removed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { PROTOCOL_PUBLISH, PROTOCOL_SYNC, encodePublishRequest } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';

const agents: DKGAgent[] = [];
const directories: string[] = [];

async function startedNode(name: string, nodeRole: 'core' | 'edge', dataDir?: string): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name,
    nodeRole,
    listenHost: '127.0.0.1',
    listenPort: 0,
    chainAdapter: new MockChainAdapter('mock:31337'),
    store: new OxigraphStore(),
    randomSamplingUseWorkerThread: false,
    ...(dataDir ? { dataDir } : {}),
  });
  agents.push(agent);
  await agent.start();
  return agent;
}

function tcpAddress(agent: DKGAgent): string {
  return agent.multiaddrs.find((address) => address.includes('/tcp/') && !address.includes('/p2p-circuit'))!;
}

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.stop().catch(() => undefined)));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('the legacy publish protocol', () => {
  it.each(['core', 'edge'] as const)('is not served by a started %s node', async (nodeRole) => {
    const agent = await startedNode(`LegacyPublishProtocol-${nodeRole}`, nodeRole);
    const protocols = agent.node.libp2p.getProtocols();
    // The same start registers the node's other protocol handlers, so this is
    // not a registration still to come.
    expect(protocols).toContain(PROTOCOL_SYNC);
    expect(protocols).not.toContain(PROTOCOL_PUBLISH);
  });

  it('is refused at protocol selection when a connected peer asks for it', async () => {
    const core = await startedNode('LegacyPublishProtocolCore', 'core');
    const edge = await startedNode('LegacyPublishProtocolEdge', 'edge');
    await edge.connectTo(tcpAddress(core));
    // A well-formed request: a node that served the protocol would answer it.
    const request = encodePublishRequest({
      ual: 'did:dkg:mock:31337/0x0000000000000000000000000000000000000001/1',
      nquads: new TextEncoder().encode(''),
      contextGraphId: 'legacy-publish-protocol-test',
      kas: [],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: '0x0000000000000000000000000000000000000001',
      startKAId: 1,
      endKAId: 1,
      chainId: 'mock:31337',
      publisherSignatureR: new Uint8Array(32),
      publisherSignatureVs: new Uint8Array(32),
    });
    await expect(edge.router.send(core.peerId, PROTOCOL_PUBLISH, request, 10_000))
      .rejects.toThrow(/protocol/i);
  }, 60_000);

  it('still restores tentative publishes journaled by an earlier version', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-legacy-publish-journal-'));
    directories.push(dataDir);
    const journalFile = join(dataDir, 'pending-publishes.json');
    const entry = (ual: string, createdAt: number) => ({
      ual,
      contextGraphId: 'legacy-publish-journal',
      expectedPublisherAddress: '0x0000000000000000000000000000000000000001',
      expectedMerkleRoot: `0x${'ab'.repeat(32)}`,
      expectedStartKAId: '1',
      expectedEndKAId: '1',
      expectedChainId: 'mock:31337',
      rootEntities: ['urn:legacy-publish-journal:entity'],
      createdAt,
    });
    const fresh = entry('did:dkg:mock:31337/0x0000000000000000000000000000000000000001/1', Date.now() - 60_000);
    const expired = entry('did:dkg:mock:31337/0x0000000000000000000000000000000000000001/2', Date.now() - 2 * 60 * 60_000);
    await writeFile(journalFile, JSON.stringify([fresh, expired]));

    await startedNode('LegacyPublishJournal', 'edge', dataDir);

    // Restoring skips the expired entry and writes the journal back with the
    // entry it restored.
    let journal: Array<{ ual: string }> = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      journal = JSON.parse(await readFile(journalFile, 'utf8')) as Array<{ ual: string }>;
      if (journal.length === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(journal.map((restored) => restored.ual)).toEqual([fresh.ual]);
  }, 60_000);
});
