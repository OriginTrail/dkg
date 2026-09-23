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
