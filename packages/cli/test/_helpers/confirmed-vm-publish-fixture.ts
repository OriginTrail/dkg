// SPDX-License-Identifier: Apache-2.0
import { afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';
import { assertionLifecycleUri, buildAssertionSealQuads, contextGraphAssertionUri, contextGraphMetaUri,
  createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { DKGPublisher, computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { GossipSession } from '../../../agent/src/gossip-session.js';
import { createKnowledgeAssetVmPublishIntentKey } from '../../../agent/dist/dkg-agent-publish.js';

const fault = vi.hoisted(() => ({ directory: '', confirmations: 0, admissions: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (fault.directory && String(args[0]).startsWith(join(fault.directory, '.named-ka-vm-lifecycle-repairs.json.')) && args[1] === 'wx') {
      expectConfirmation();
      fault.admissions++;
      throw Object.assign(new Error('No space left for lifecycle journal'), { code: 'ENOSPC' });
    }
    return actual.open(...args);
  } };
  function expectConfirmation() { if (fault.confirmations !== 1) throw new Error('Admission fault must follow confirmation'); }
});
const fixtures: Array<{ store: OxigraphStore; agent: any; dir: string }> = [];
afterEach(async () => {
  fault.directory = ''; fault.confirmations = 0; fault.admissions = 0; vi.restoreAllMocks();
  for (const { store, agent, dir } of fixtures.splice(0)) {
    await agent.namedKaVmLifecycleRepair?.stop(); await store.close(); await rm(dir, { recursive: true, force: true });
  }
});

/** Real sealed SWM and lifecycle owner; only the chain publication primitive is simulated. */
export async function confirmedVmPublishFixture(contextGraphId: string, name: string, failAdmission = true) {
  const author = '0x1111111111111111111111111111111111111111', packed = (BigInt(author) << 96n) | 1n;
  const ual = `did:dkg:mock:31337/${author}/1`, publishedUal = 'did:dkg:mock:31337/0x2222222222222222222222222222222222222222/1';
  const quads = [{ subject: 'urn:confirmed:entity', predicate: 'http://schema.org/name', object: '"Confirmed"', graph: '' }];
  const root = computeFlatKCRootV10(quads, []), rootHex = ethers.hexlify(root), now = new Date().toISOString();
  const scope = createGraphKnowledgeAssetScope(ual, 1), meta = contextGraphMetaUri(contextGraphId);
  const assertionUri = contextGraphAssertionUri(contextGraphId, author, name), lifecycle = assertionLifecycleUri(contextGraphId, author, name);
  const dir = await mkdtemp(join(tmpdir(), 'dkg-confirmed-http-')), store = new OxigraphStore(join(dir, 'store.nq'));
  await store.insert([
    ...buildAssertionSealQuads({ assertionUri, metaGraph: meta, merkleRoot: root, authorAddress: author,
      authorAttestationR: new Uint8Array(32).fill(1), authorAttestationVS: new Uint8Array(32).fill(2), authorSchemeVersion: 1,
      chainId: 31337n, kav10Address: author, reservedKaId: packed, finalizedAtIso: now, contentScopeVersion: 2,
      kaUal: ual, assertionVersion: 1, publicTripleCount: 1, privateTripleCount: 0 }),
    ...quads.map(q => ({ ...q, graph: knowledgeAssetLayerGraphUri(contextGraphId, MemoryLayer.SharedWorkingMemory, scope) })),
    { subject: lifecycle, predicate: 'http://dkg.io/ontology/kaId', object: '"1"', graph: meta },
    { subject: lifecycle, predicate: 'http://dkg.io/ontology/swmCurrentAssertion', object: JSON.stringify(rootHex.slice(2)), graph: meta },
  ]);
  const agent = Object.create(DKGAgent.prototype) as any;
  Object.defineProperty(agent, 'peerId', { value: 'peer-confirmed-http' });
  agent.config = { dataDir: dir }; agent.store = store; agent.defaultAgentAddress = author; agent.writeLocks = new Map();
  agent.gossipSession = new GossipSession(); agent.gossip = { publish: async () => undefined };
  agent.log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  agent.chain = { getEvmChainId: async () => 31337n, getKnowledgeAssetsLifecycleAddress: async () => author,
    readKnowledgeAssetVersionSnapshot: async () => ({ latestRoot: rootHex, rootCount: 1n }) };
  agent.getContextGraphOnChainId = async () => '1';
  agent.createV10ACKProvider = () => undefined; agent.afterConfirmedGraphScopedVmPublishV1 = async () => undefined;
  agent._resolveInlineEncryption = async () => ({ encryptInlinePayload: undefined, encryptInlineChunked: undefined });
  const result = { status: 'confirmed' as const, ual: publishedUal, kaId: packed, merkleRoot: root, kaManifest: [],
    onChainResult: { txHash: `0x${'cd'.repeat(32)}`, blockNumber: 2, txIndex: 0, kaId: packed, batchId: packed,
      startKAId: packed, endKAId: packed, publisherAddress: author } };
  const publish = vi.fn(async (...args: any[]) => {
    const options = args.at(-1);
    await options?.onBeforeBroadcast?.({ txHash: result.onChainResult.txHash, nonce: 1, operationKind: 'create' });
    fault.confirmations++; return result;
  });
  agent.publisher = { publish, hasSwmShareComplete: async () => true, clearSwmShareComplete: async () => undefined,
    clearPublishedKnowledgeAssetSwm: async () => undefined };
  agent.publishFromSharedMemory = publish;
  if (failAdmission) fault.directory = dir;
  fixtures.push({ store, agent, dir });
  const fields = { contextGraphId, name, agentAddress: author, shareOperationId: 'confirmed-http-share', roots: [],
    seal: { merkleRoot: rootHex, authorAddress: author, signature: { r: `0x${'01'.repeat(32)}`, vs: `0x${'02'.repeat(32)}` }, schemeVersion: 1, reservedKaId: packed.toString() },
    sealChainId: '31337', sealKav10Address: author, sealFinalizedAtIso: now, sealMerkleRoot: rootHex,
    contentScopeVersion: 2 as const, kaUal: ual, assertionVersion: '1', publicTripleCount: 1, privateTripleCount: 0 };
  const request = { ...fields, intentKey: createKnowledgeAssetVmPublishIntentKey(fields) };
  return { agent, store, dir, result, rootHex, assertionUri, author, request, publish, fault,
    stage: async (publisher: DKGPublisher) => publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      contextGraphId, kaUal: ual, assertionVersion: 1, shareOperationId: fields.shareOperationId, quads,
      privateTripleCount: 0, publisherPeerId: agent.peerId,
    }),
  };
}
