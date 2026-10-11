/**
 * Rolling-upgrade compatibility: a 10.0.18 publisher's ACK collector against
 * a 10.0.19 core whose StorageACK finality gate is still starting.
 *
 * 10.0.18 retries only its own transient decline set and deselects a peer on
 * any other code, including codes it does not know. The core therefore sends
 * its transient VM-promotion refusal as CORE_TEMPORARILY_UNAVAILABLE. The
 * collector is unchanged in substance since 10.0.18, so this suite drives the
 * current collector with the 10.0.18 transient set pinned.
 */
import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

const TRANSIENT_CODES_10_0_18 = new Set([
  'NO_DATA_IN_SWM',
  'MERKLE_MISMATCH_IN_SWM',
  'MISSING_CIPHERTEXT_CHUNKS',
  'CORE_TEMPORARILY_UNAVAILABLE',
]);

vi.mock('@origintrail-official/dkg-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@origintrail-official/dkg-core')>();
  return {
    ...actual,
    isTransientStorageACKDeclineCode: (code: string | undefined) =>
      typeof code === 'string' && TRANSIENT_CODES_10_0_18.has(code),
  };
});

const {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  STORAGE_ACK_DECLINE_CODES,
  TypedEventBus,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} = await import('@origintrail-official/dkg-core');
const { OxigraphStore } = await import('@origintrail-official/dkg-storage');
const { ACKCollector } = await import('../src/ack-collector.js');
const { StorageACKHandler } = await import('../src/storage-ack-handler.js');
const { QuorumUnmetError } = await import('../src/ack-errors.js');
const { computeFlatKCMerkleLeafCountV10, computeFlatKCRootV10 } = await import('../src/merkle.js');
type Verdict = import('../src/storage-ack-handler.js').StorageAckVmPromotionVerdict;

const CG_ID = '42';
const SWM_GRAPH_ID = 'public-source-cg';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const CHAIN_ID = 31337n;
const KAV10 = '0x000000000000000000000000000000000000c10a';

function scenario(verdicts: Verdict[]) {
  const graph = knowledgeAssetLayerGraphUri(
    SWM_GRAPH_ID,
    MemoryLayer.SharedWorkingMemory,
    createGraphKnowledgeAssetScope(UAL, 1),
  );
  const quads = [{ subject: 'urn:asset:compat', predicate: 'urn:p:value', object: '"v1"', graph }];
  const stagingQuads = new TextEncoder().encode(
    quads.map((quad) => `<${quad.subject}> <${quad.predicate}> ${quad.object} <${quad.graph}> .`).join('\n'),
  );
  let gateCalls = 0;
  const handler = new StorageACKHandler(new OxigraphStore(), {
    nodeRole: 'core',
    nodeIdentityId: 17n,
    signerWallet: ethers.Wallet.createRandom(),
    contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
    chainId: CHAIN_ID,
    kav10Address: KAV10,
    isCgCurated: async () => false,
    ensureVmPromotion: async () => verdicts[Math.min(gateCalls++, verdicts.length - 1)]!,
  }, new TypedEventBus());
  const sends: string[] = [];
  const collector = new ACKCollector({
    gossipPublish: async () => {},
    sleep: async () => {},
    sendP2P: async (peerId, _protocol, data) => {
      sends.push(peerId);
      return handler.handler(data, { toString: () => 'publisher-peer' });
    },
    getConnectedCorePeers: () => ['core-10-0-19'],
    verifyIdentity: async () => true,
    log: () => {},
  });
  const collect = () => collector.collect({
    merkleRoot: computeFlatKCRootV10(quads, []),
    contextGraphId: BigInt(CG_ID),
    contextGraphIdStr: CG_ID,
    swmGraphId: SWM_GRAPH_ID,
    publisherPeerId: 'publisher-peer',
    publicByteSize: BigInt(stagingQuads.length),
    isPrivate: false,
    kaCount: 1,
    rootEntities: [],
    chainId: CHAIN_ID,
    kav10Address: KAV10,
    stagingQuads,
    merkleLeafCount: computeFlatKCMerkleLeafCountV10(quads, []),
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: UAL,
    assertionVersion: '1',
    publicTripleCount: quads.length,
    privateTripleCount: 0,
    accessPolicy: 'public',
    allowedPeers: [],
    requiredACKs: 1,
  });
  return { collect, sends, gateCalls: () => gateCalls };
}

const STARTING: Verdict = {
  ok: false,
  code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_UNAVAILABLE,
  message: 'VM reconciliation is not running on this core yet',
};

describe('10.0.18 ACK collector against a starting 10.0.19 core', () => {
  it('keeps retrying the core while its finality gate starts, and collects the ACK once it is ready', async () => {
    const { collect, sends, gateCalls } = scenario([STARTING, STARTING, { ok: true }]);

    const result = await collect();

    expect(result.acks).toHaveLength(1);
    expect(result.acks[0]?.peerId).toBe('core-10-0-19');
    expect(sends).toEqual(['core-10-0-19', 'core-10-0-19', 'core-10-0-19']);
    expect(gateCalls()).toBe(3);
  });

  it('keeps retrying an update while the core promotes the version it replaces', async () => {
    const store = new OxigraphStore();
    const scopeGraph = (layer: MemoryLayer, version: number) => knowledgeAssetLayerGraphUri(
      SWM_GRAPH_ID, layer, createGraphKnowledgeAssetScope(UAL, version),
    );
    const nquads = (quads: Array<{ subject: string; predicate: string; object: string; graph: string }>) =>
      new TextEncoder().encode(quads.map((q) => `<${q.subject}> <${q.predicate}> ${q.object} <${q.graph}> .`).join('\n'));
    let nudges = 0;
    const handler = new StorageACKHandler(store, {
      nodeRole: 'core',
      nodeIdentityId: 17n,
      signerWallet: ethers.Wallet.createRandom(),
      contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
      chainId: CHAIN_ID,
      kav10Address: KAV10,
      isCgCurated: async () => false,
      ensureVmPromotion: async () => ({ ok: true }),
      // The core promotes the held version after the publisher's second try.
      onPriorVersionAwaitingPromotion: () => {
        nudges += 1;
        if (nudges !== 2) return;
        void store.insert([
          { subject: UAL, predicate: 'http://dkg.io/ontology/status', object: '"confirmed"', graph: `did:dkg:context-graph:${SWM_GRAPH_ID}/_meta` },
          {
            subject: UAL,
            predicate: 'http://dkg.io/ontology/assertionVersion',
            object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
            graph: `did:dkg:context-graph:${SWM_GRAPH_ID}/_meta`,
          },
        ]);
      },
    }, new TypedEventBus());
    const v1 = [{ subject: 'urn:asset:compat', predicate: 'urn:p:value', object: '"v1"', graph: scopeGraph(MemoryLayer.SharedWorkingMemory, 1) }];
    const collector = new ACKCollector({
      gossipPublish: async () => {},
      sleep: async () => {},
      sendP2P: async (_peerId, protocol, data) => (
        protocol.includes('update')
          ? handler.updateHandler(data, { toString: () => 'publisher-peer' })
          : handler.handler(data, { toString: () => 'publisher-peer' })
      ),
      getConnectedCorePeers: () => ['core-10-0-19'],
      verifyIdentity: async () => true,
      log: () => {},
    });
    await collector.collect({
      merkleRoot: computeFlatKCRootV10(v1, []),
      contextGraphId: BigInt(CG_ID),
      contextGraphIdStr: CG_ID,
      swmGraphId: SWM_GRAPH_ID,
      publisherPeerId: 'publisher-peer',
      publicByteSize: BigInt(nquads(v1).length),
      isPrivate: false,
      kaCount: 1,
      rootEntities: [],
      chainId: CHAIN_ID,
      kav10Address: KAV10,
      stagingQuads: nquads(v1),
      merkleLeafCount: computeFlatKCMerkleLeafCountV10(v1, []),
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: '1',
      publicTripleCount: 1,
      privateTripleCount: 0,
      accessPolicy: 'public',
      allowedPeers: [],
      requiredACKs: 1,
    });
    const v2 = [{ subject: 'urn:asset:compat', predicate: 'urn:p:value', object: '"v2"', graph: scopeGraph(MemoryLayer.VerifiableMemory, 2) }];

    const result = await collector.collectUpdate({
      kaId: (BigInt(AUTHOR) << 96n) | 7n,
      contextGraphId: BigInt(CG_ID),
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: computeFlatKCRootV10(v2, []),
      newByteSize: BigInt(nquads(v2).length),
      newTokenAmount: 1000n,
      mintAmount: 0n,
      burnTokenIds: [],
      newMerkleLeafCount: computeFlatKCMerkleLeafCountV10(v2, []),
      chainId: CHAIN_ID,
      kav10Address: KAV10,
      publisherPeerId: 'publisher-peer',
      requiredACKs: 1,
      swmGraphId: SWM_GRAPH_ID,
      stagingQuads: nquads(v2),
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: '2',
      publicTripleCount: 1,
      privateTripleCount: 0,
    });

    expect(result.acks).toHaveLength(1);
    expect(nudges).toBe(2);
  });

  it('drops the core at once on the final refusal of a core with VM reconcile disabled', async () => {
    const { collect, sends } = scenario([{
      ok: false,
      code: STORAGE_ACK_DECLINE_CODES.CORE_VM_PROMOTION_DISABLED,
      message: 'VM reconciliation is disabled on this core',
    }]);

    const error = await collect().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(QuorumUnmetError);
    expect(sends).toEqual(['core-10-0-19']);
  });
});
