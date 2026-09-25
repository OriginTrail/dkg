import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  createGraphKnowledgeAssetScope,
  decodeStorageACK,
  encodePublishIntent,
  encodeUpdateIntent,
  generateEd25519Keypair,
  isStorageACKDecline,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { StorageACKHandler } from '../src/storage-ack-handler.js';
import type { LocalStorageAckHeadExpectation } from '../src/storage-ack-handler.js';
import { computeFlatKCMerkleLeafCountV10, computeFlatKCRootV10 } from '../src/merkle.js';
import { resolveKnowledgeAssetWorkspaceHead } from '../src/workspace-resolution.js';
import { workspaceKnowledgeAssetHeadSubject, workspaceOperationSubject } from '../src/workspace-metadata-subjects.js';
import {
  STORAGE_ACK_LEDGER_GRAPH,
  STORAGE_ACK_LEDGER_PREDICATES as LEDGER,
  storageAckOperationId,
} from '../src/storage-ack-ledger.js';

// #2796 lets a publishing core ACK its own publish or update through its
// local StorageACK endpoint. The SWM head that ACK meets is the publisher's own
// in-flight share, which a queued publish/update re-validates before every
// attempt. These pin that a local self-ACK leaves that head (operation id and
// access envelope) alone while a remote ACK keeps taking the head over.

const CG_ID = '42';
const SWM_GRAPH_ID = 'publisher-self-ack-cg';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const UAL = `did:dkg:otp:20430/${AUTHOR}/7`;
const KA_ID = (BigInt(AUTHOR) << 96n) | 7n;
const PUBLISHER_PEER = '12D3KooWSelfAckPublisher';
const REMOTE_PEER = '12D3KooWRemoteAckRequester';
const ALLOWED_PEERS = ['reader-b', 'reader-a'];
const DKG = 'http://dkg.io/ontology/';

function content(value: string): Quad[] {
  return [
    { subject: 'urn:asset:self-ack', predicate: 'urn:p:value', object: `"${value}"`, graph: '' },
    { subject: 'urn:asset:self-ack', predicate: 'urn:p:note', object: '"shared"', graph: '' },
  ];
}

function layerGraph(layer: MemoryLayer, version: number): string {
  return knowledgeAssetLayerGraphUri(SWM_GRAPH_ID, layer, createGraphKnowledgeAssetScope(UAL, version));
}

function wireNquads(quads: readonly Quad[], graph: string): Uint8Array {
  return new TextEncoder().encode(quads.map((quad) =>
    `<${quad.subject}> <${quad.predicate}> ${quad.object} <${graph}> .`,
  ).join('\n'));
}

/** A graph-scoped public publish, payload inline; `merkleRoot` overrides the claimed root. */
function publishIntent(quads: readonly Quad[], merkleRoot = computeFlatKCRootV10([...quads], [])): Uint8Array {
  const stagingQuads = wireNquads(quads, layerGraph(MemoryLayer.SharedWorkingMemory, 1));
  return encodePublishIntent({
    merkleRoot,
    contextGraphId: CG_ID,
    swmGraphId: SWM_GRAPH_ID,
    publisherPeerId: PUBLISHER_PEER,
    publicByteSize: stagingQuads.length,
    isPrivate: false,
    kaCount: 1,
    rootEntities: [],
    merkleLeafCount: computeFlatKCMerkleLeafCountV10([...quads], []),
    stagingQuads,
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: UAL,
    assertionVersion: '1',
    publicTripleCount: quads.length,
    privateTripleCount: 0,
    accessPolicy: 'allowList',
    allowedPeers: [...ALLOWED_PEERS].sort(),
  });
}

/** A public graph-scoped update, payload inline from the publisher's VM graph. */
function updateIntent(quads: readonly Quad[], version: number): Uint8Array {
  const stagingQuads = wireNquads(quads, layerGraph(MemoryLayer.VerifiableMemory, version));
  return encodeUpdateIntent({
    kaId: KA_ID.toString(),
    contextGraphId: CG_ID,
    swmGraphId: SWM_GRAPH_ID,
    preUpdateMerkleRootCount: version - 1,
    newMerkleRoot: computeFlatKCRootV10([...quads], []),
    newByteSize: stagingQuads.length,
    newTokenAmount: '1000',
    mintAmount: 0,
    burnTokenIds: [],
    newMerkleLeafCount: computeFlatKCMerkleLeafCountV10([...quads], []),
    publisherPeerId: PUBLISHER_PEER,
    stagingQuads,
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: UAL,
    assertionVersion: String(version),
    publicTripleCount: quads.length,
    privateTripleCount: 0,
  });
}

async function harness(ackHandlerDeadlineMs?: number) {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain: { chainId: 'none' } as never,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  const wallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey);
  const signMessage = vi.spyOn(wallet, 'signMessage');
  const handler = new StorageACKHandler(store, {
    nodeRole: 'core',
    nodeIdentityId: 17n,
    signerWallet: wallet,
    contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
    chainId: 31337n,
    kav10Address: '0x000000000000000000000000000000000000c10a',
    workspaceWriteLocks: publisher.writeLocks,
    ensureVmPromotion: async () => ({ ok: true }),
    ackHandlerDeadlineMs,
  }, new TypedEventBus());
  return { store, publisher, handler, signMessage };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** The publisher's own share, as a queued publish or update staged it. */
function shareInput(version: number, shareOperationId: string, quads: readonly Quad[]) {
  return {
    contextGraphId: SWM_GRAPH_ID,
    kaUal: UAL,
    assertionVersion: String(version),
    shareOperationId,
    quads,
    privateTripleCount: 0,
    publisherPeerId: PUBLISHER_PEER,
    accessPolicy: 'allowList' as const,
    allowedPeers: ALLOWED_PEERS,
    agentAddress: AUTHOR,
    timestamp: new Date('2026-09-24T12:00:00.000Z'),
  };
}

function expectedHead(version: number, shareOperationId: string): LocalStorageAckHeadExpectation {
  return {
    shareOperationId,
    publisherPeerId: PUBLISHER_PEER,
    kaUal: UAL,
    assertionVersion: String(version),
    accessPolicy: 'allowList',
    allowedPeers: ALLOWED_PEERS,
  };
}

async function readHead(h: Harness) {
  return resolveKnowledgeAssetWorkspaceHead({
    store: h.store,
    graphManager: new GraphManager(h.store),
    contextGraphId: SWM_GRAPH_ID,
    kaUal: UAL,
  });
}

function ackCopyOperationId(version: number, quads: readonly Quad[]): string {
  return storageAckOperationId(UAL, version, computeFlatKCRootV10([...quads], []));
}

async function ledgerOperations(h: Harness): Promise<string[]> {
  const result = await h.store.query(`SELECT ?op WHERE { GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
    ?op <${LEDGER.signedAt}> ?signedAt
  } }`);
  return result.type === 'bindings' ? result.bindings.map((row) => row['op']!) : [];
}

async function hasOperationRows(h: Harness, shareOperationId: string): Promise<boolean> {
  const result = await h.store.query(`ASK { GRAPH <${new GraphManager(h.store).sharedMemoryMetaUri(SWM_GRAPH_ID)}> {
    <${workspaceOperationSubject(SWM_GRAPH_ID, shareOperationId)}> <${DKG}shareOperationId> ?id
  } }`);
  return result.type === 'boolean' && result.value;
}

async function swmValues(h: Harness, version: number): Promise<string[]> {
  const result = await h.store.query(
    `SELECT ?o WHERE { GRAPH <${layerGraph(MemoryLayer.SharedWorkingMemory, version)}> { ?s <urn:p:value> ?o } }`,
  );
  return result.type === 'bindings' ? result.bindings.map((row) => row['o']!) : [];
}

describe('StorageACK local self-ACK keeps the publisher SWM head (#2796)', () => {
  it('keeps a queued publish share as the head and still keeps the ACK copy and its ledger row', async () => {
    const h = await harness();
    await h.publisher.stageKnowledgeAssetSharedWorkingMemoryV1(shareInput(1, 'queued-publish-share', content('v1')));
    const before = await readHead(h);
    expect(before).toMatchObject({
      shareOperationIds: ['queued-publish-share'],
      access: { kind: 'persisted', accessPolicy: 'allowList', allowedPeers: ['reader-a', 'reader-b'] },
    });

    const ack = decodeStorageACK(await h.handler.localHandler(
      publishIntent(content('v1')),
      { toString: () => PUBLISHER_PEER },
      undefined,
      expectedHead(1, 'queued-publish-share'),
    ));

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(h.signMessage).toHaveBeenCalledOnce();
    // The queued publish's operation id, access envelope and timestamp survive.
    expect(await readHead(h)).toEqual(before);
    expect(await swmValues(h, 1)).toEqual(['"v1"']);
    // The ACK copy and the ledger row VM promotion keys on are still kept.
    const copy = ackCopyOperationId(1, content('v1'));
    expect(await hasOperationRows(h, copy)).toBe(true);
    expect(await ledgerOperations(h)).toEqual([workspaceOperationSubject(SWM_GRAPH_ID, copy)]);
  });

  it('keeps a queued update share and its access envelope, so the same job re-validates it', async () => {
    const h = await harness();
    const queued = shareInput(2, 'queued-update-share', content('v2'));
    await h.publisher.stageKnowledgeAssetSharedWorkingMemoryV1(queued);
    const before = await readHead(h);

    const ack = decodeStorageACK(await h.handler.localUpdateHandler(
      updateIntent(content('v2'), 2),
      { toString: () => PUBLISHER_PEER },
      undefined,
      expectedHead(2, 'queued-update-share'),
    ));

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(await readHead(h)).toEqual(before);
    expect(before).toMatchObject({
      assertionVersion: '2',
      shareOperationIds: ['queued-update-share'],
      access: { kind: 'persisted', accessPolicy: 'allowList', allowedPeers: ['reader-a', 'reader-b'] },
    });
    // What a queued UPDATE retry runs before signing its transaction again.
    await expect(h.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      ...queued,
      reuseExistingOperation: true,
    })).resolves.toMatchObject({ shareOperationId: 'queued-update-share', assertionVersion: '2' });
    const copy = ackCopyOperationId(2, content('v2'));
    expect(await hasOperationRows(h, copy)).toBe(true);
    expect(await ledgerOperations(h)).toEqual([workspaceOperationSubject(SWM_GRAPH_ID, copy)]);
  });

  it('preserves a queued operation that is a non-selected equivalent head alias', async () => {
    const h = await harness();
    await h.publisher.stageKnowledgeAssetSharedWorkingMemoryV1(
      shareInput(1, 'queued-publish-share', content('v1')),
    );
    await h.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      ...shareInput(1, 'replacement-share', content('v1')),
      timestamp: new Date('2026-09-24T12:01:00.000Z'),
    });
    // SWM sync union-inserts the older, still-valid operation ID on the head.
    await h.store.insert([{
      subject: workspaceKnowledgeAssetHeadSubject(UAL),
      predicate: `${DKG}shareOperationId`,
      object: JSON.stringify('queued-publish-share'),
      graph: new GraphManager(h.store).sharedMemoryMetaUri(SWM_GRAPH_ID),
    }]);
    const before = await readHead(h);
    expect(before.shareOperationId).toBe('replacement-share');
    expect(before.operationAliases.map((alias) => alias.shareOperationId)).toContain('queued-publish-share');

    const ack = decodeStorageACK(await h.handler.localHandler(
      publishIntent(content('v1')),
      { toString: () => PUBLISHER_PEER },
      undefined,
      expectedHead(1, 'queued-publish-share'),
    ));

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(await readHead(h)).toEqual(before);
    expect(h.signMessage).toHaveBeenCalledOnce();
  });

  it.each([
    ['operation', { shareOperationId: 'replacement-share' }],
    ['access', { accessPolicy: 'public' as const, allowedPeers: [] }],
    ['publisher', { publisherPeerId: REMOTE_PEER }],
  ])('declines a queued self-ACK when the same-content head changes %s', async (_name, change) => {
    const h = await harness();
    await h.publisher.stageKnowledgeAssetSharedWorkingMemoryV1(
      shareInput(1, 'queued-publish-share', content('v1')),
    );
    await h.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
      ...shareInput(1, 'queued-publish-share', content('v1')),
      ...change,
    });
    const changedHead = await readHead(h);

    const ack = decodeStorageACK(await h.handler.localHandler(
      publishIntent(content('v1')),
      { toString: () => PUBLISHER_PEER },
      undefined,
      expectedHead(1, 'queued-publish-share'),
    ));

    expect(isStorageACKDecline(ack)).toBe(true);
    expect(h.signMessage).not.toHaveBeenCalled();
    expect(await readHead(h)).toEqual(changedHead);
    expect(await ledgerOperations(h)).toEqual([]);
  });

  it('finishes graph, metadata, head, and ledger after a non-cooperative replace commits past deadline', async () => {
    const h = await harness(40);
    const originalReplace = h.store.replaceGraph.bind(h.store);
    let entered!: () => void;
    let release!: () => void;
    const inReplace = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(h.store, 'replaceGraph').mockImplementation(async (graph, quads) => {
      entered();
      await held;
      await originalReplace(graph, quads);
    });

    const response = h.handler.localHandler(
      publishIntent(content('late-commit')),
      { toString: () => PUBLISHER_PEER },
    );
    await inReplace;
    const ack = decodeStorageACK(await response);
    expect(isStorageACKDecline(ack)).toBe(true);
    release();

    const copy = ackCopyOperationId(1, content('late-commit'));
    await vi.waitFor(async () => {
      expect(await hasOperationRows(h, copy)).toBe(true);
      expect(await ledgerOperations(h)).toEqual([workspaceOperationSubject(SWM_GRAPH_ID, copy)]);
    });
    expect(await readHead(h)).toMatchObject({ shareOperationId: copy });
    expect(await swmValues(h, 1)).toEqual(['"late-commit"']);
    expect(h.signMessage).not.toHaveBeenCalled();
  });

  it('writes the head as before when no head holds the ACKed content', async () => {
    const h = await harness();

    const ack = decodeStorageACK(await h.handler.localHandler(
      publishIntent(content('direct')),
      { toString: () => PUBLISHER_PEER },
    ));

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(await readHead(h)).toMatchObject({
      shareOperationIds: [ackCopyOperationId(1, content('direct'))],
    });
  });

  it('still verifies the content before a local ACK is signed', async () => {
    const h = await harness();
    await h.publisher.stageKnowledgeAssetSharedWorkingMemoryV1(shareInput(1, 'queued-publish-share', content('v1')));
    const before = await readHead(h);
    const intent = publishIntent(content('v1'), computeFlatKCRootV10(content('other'), []));

    await expect(h.handler.localHandler(intent, { toString: () => PUBLISHER_PEER }, undefined, expectedHead(1, 'queued-publish-share')))
      .rejects.toThrow(/Merkle root mismatch/);

    expect(h.signMessage).not.toHaveBeenCalled();
    expect(await readHead(h)).toEqual(before);
    expect(await ledgerOperations(h)).toEqual([]);
  });

  describe('remote requests are unchanged', () => {
    it('a remote publish ACK points the head at its ACK copy', async () => {
      const h = await harness();
      await h.publisher.stageKnowledgeAssetSharedWorkingMemoryV1(shareInput(1, 'gossiped-share', content('v1')));

      const ack = decodeStorageACK(await h.handler.handler(
        publishIntent(content('v1')),
        { toString: () => REMOTE_PEER },
      ));

      expect(isStorageACKDecline(ack)).toBe(false);
      const copy = ackCopyOperationId(1, content('v1'));
      expect(await readHead(h)).toMatchObject({
        shareOperationId: copy,
        shareOperationIds: [copy],
        publisherPeerId: REMOTE_PEER,
        access: { kind: 'persisted', accessPolicy: 'allowList', allowedPeers: ['reader-a', 'reader-b'] },
      });
      expect(await ledgerOperations(h)).toEqual([workspaceOperationSubject(SWM_GRAPH_ID, copy)]);
    });

    it('a remote update ACK points the head at its ACK copy with the legacy default access', async () => {
      const h = await harness();
      const shared = shareInput(2, 'gossiped-update', content('v2'));
      await h.publisher.stageKnowledgeAssetSharedWorkingMemoryV1(shared);

      const ack = decodeStorageACK(await h.handler.updateHandler(
        updateIntent(content('v2'), 2),
        { toString: () => REMOTE_PEER },
      ));

      expect(isStorageACKDecline(ack)).toBe(false);
      const copy = ackCopyOperationId(2, content('v2'));
      expect(await readHead(h)).toMatchObject({
        shareOperationIds: [copy],
        access: { kind: 'legacy-default', accessPolicy: 'public', allowedPeers: [] },
      });
      // The state a local self-ACK used to leave behind: a queued update can
      // no longer re-validate its own share.
      await expect(h.publisher.stageKnowledgeAssetSharedWorkingMemoryV1({
        ...shared,
        reuseExistingOperation: true,
      })).rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });
    });
  });
});
