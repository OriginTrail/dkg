import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  ASSERTION_SEAL_PREDICATES,
  AUTHOR_SCHEME_VERSION_V1,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  TypedEventBus,
  assertionLifecycleUri,
  buildAssertionPublishReceiptQuads,
  buildAssertionSealQuads,
  buildAuthorAttestationTypedData,
  computeGossipSigningPayload,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  encodeGossipEnvelope,
  encodeWorkspacePublishRequest,
  generateEd25519Keypair,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  knowledgeAssetLayerGraphUri,
  MemoryLayer,
  parseAssertionSealQuads,
  parseGraphScopedAssertionSealCandidate,
  type AssertionSeal,
  type WorkspacePublishRequestMsg,
} from '@origintrail-official/dkg-core';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher, KA_ID_PRED, computeFlatKCRootV10 } from '../src/index.js';
import { SharedMemoryHandler } from '../src/workspace-handler.js';
import {
  SWM_SHARE_COMPLETE_PRED,
  keepSharedMemoryAuthorSeal,
  sharedMemoryAuthorSealFields,
  sharedMemoryShareSignedBy,
  verifySharedMemoryAuthorSeal,
  type SharedMemoryAuthorSealShare,
} from '../src/shared-memory-author-seal.js';
import { finalizeRootlessAssertionForTest } from './_helpers/rootless-lifecycle.js';

const CG = 'curated-seal-receiver';
const SUB = 'reports';
const NAME = 'report-1';
const PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const AUTHOR = new ethers.Wallet(`0x${'11'.repeat(32)}`);
const STRANGER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const KAV10 = ethers.getAddress(`0x${'12'.repeat(20)}`);
const DATA_GRAPH = `did:dkg:context-graph:${CG}`;
const META_GRAPH = contextGraphMetaUri(CG);
const SUBJECT = 'urn:report:1';
const NAME_PRED = 'http://schema.org/name';

function ualOf(number: bigint = 7n): string {
  return `did:dkg:evm:31337/${AUTHOR.address.toLowerCase()}/${number}`;
}

function rootOf(value: string): Uint8Array {
  return computeFlatKCRootV10([{ subject: SUBJECT, predicate: NAME_PRED, object: `"${value}"`, graph: '' }], []);
}

/** A seal the author's finalize would write for one triple with `value`. */
async function sealOf(value: string, opts: {
  version?: number;
  signer?: ethers.Wallet;
  number?: bigint;
} = {}): Promise<AssertionSeal> {
  const number = opts.number ?? 7n;
  const merkleRoot = rootOf(value);
  const reservedKaId = (BigInt(AUTHOR.address) << 96n) | number;
  const typed = buildAuthorAttestationTypedData({
    chainId: 31337n,
    kav10Address: KAV10,
    merkleRoot,
    authorAddress: AUTHOR.address,
    reservedKaId,
    schemeVersion: AUTHOR_SCHEME_VERSION_V1,
  });
  const signature = ethers.Signature.from(
    await (opts.signer ?? AUTHOR).signTypedData(typed.domain, typed.types, typed.message),
  );
  return {
    merkleRoot,
    authorAddress: AUTHOR.address,
    authorAttestationR: ethers.getBytes(signature.r),
    authorAttestationVS: ethers.getBytes(signature.yParityAndS),
    authorSchemeVersion: AUTHOR_SCHEME_VERSION_V1,
    chainId: 31337n,
    kav10Address: KAV10,
    reservedKaId,
    finalizedAtIso: '2026-10-16T00:00:00.000Z',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: ualOf(number),
    assertionVersion: String(opts.version ?? 1),
    publicTripleCount: 1,
    privateTripleCount: 0,
    rootEntities: [],
  };
}

function shareOf(value: string, overrides: Partial<SharedMemoryAuthorSealShare> = {}): SharedMemoryAuthorSealShare {
  return {
    contextGraphId: CG,
    subGraphName: SUB,
    kaUal: ualOf(),
    assertionVersion: '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
    merkleRoot: rootOf(value),
    ...overrides,
  };
}

/** The share message the author's node sends for one triple with `value`. */
function shareMessage(
  value: string,
  seal: AssertionSeal | undefined,
  overrides: Partial<WorkspacePublishRequestMsg> = {},
): Uint8Array {
  return encodeWorkspacePublishRequest({
    contextGraphId: CG,
    nquads: new TextEncoder().encode(`<${SUBJECT}> <${NAME_PRED}> "${value}" <${DATA_GRAPH}> .`),
    manifest: [],
    publisherPeerId: PEER_ID,
    shareOperationId: `op-${value}`,
    timestampMs: Date.now(),
    subGraphName: SUB,
    agentAddress: AUTHOR.address.toLowerCase(),
    kaNumber: '7',
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: ualOf(),
    assertionVersion: seal?.assertionVersion ?? '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
    ...(seal ? sharedMemoryAuthorSealFields(NAME, seal) : {}),
    ...overrides,
  });
}

/** `message` in the gossip envelope its sender's node signs (the agent signs every share it sends). */
async function signed(message: Uint8Array, signer = AUTHOR, contextGraphId = CG): Promise<Uint8Array> {
  const timestamp = new Date().toISOString();
  const signature = await signer.signMessage(
    computeGossipSigningPayload(GOSSIP_TYPE_WORKSPACE_PUBLISH, contextGraphId, timestamp, message),
  );
  return encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId,
    agentAddress: signer.address,
    timestamp,
    signature: ethers.getBytes(signature),
    payload: message,
  });
}

async function rowsOf(store: OxigraphStore, subject: string): Promise<Quad[]> {
  const result = await store.query(
    `CONSTRUCT { <${subject}> ?p ?o } WHERE { GRAPH <${META_GRAPH}> { <${subject}> ?p ?o } }`,
  );
  return result.type === 'quads' ? result.quads : [];
}

/** The seal VM publish would resolve at the author's coordinate, if any. */
async function keptSeal(store: OxigraphStore, author = AUTHOR.address) {
  const subject = contextGraphAssertionUri(CG, author, NAME, SUB);
  return parseGraphScopedAssertionSealCandidate(await rowsOf(store, subject), subject);
}

async function hasShareCompleteMarker(store: OxigraphStore, author = AUTHOR.address): Promise<boolean> {
  const result = await store.query(
    `ASK { GRAPH <${META_GRAPH}> { <${assertionLifecycleUri(CG, author, NAME, SUB)}> <${SWM_SHARE_COMPLETE_PRED}> ?o } }`,
  );
  return result.type === 'boolean' && result.value;
}

/**
 * The asset VM publish would mint under the author's name: the UAL of the kept
 * seal, when the share-complete marker is set and the shared content of that
 * UAL still has the seal's Merkle root, as the publish path checks.
 */
async function publishTarget(store: OxigraphStore): Promise<string | undefined> {
  const candidate = await keptSeal(store);
  if (!candidate || !(await hasShareCompleteMarker(store))) return undefined;
  const scope = createGraphKnowledgeAssetScope(candidate.seal.kaUal!, candidate.seal.assertionVersion!);
  const graph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope, SUB);
  const shared = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  const quads = shared.type === 'quads' ? shared.quads : [];
  const root = computeFlatKCRootV10(quads.map((quad) => ({ ...quad, graph: '' })), []);
  return ethers.hexlify(root) === ethers.hexlify(candidate.seal.merkleRoot) ? scope.ual : undefined;
}

describe('verifySharedMemoryAuthorSeal', () => {
  it('accepts the author\'s seal of exactly the shared content', async () => {
    const seal = await sealOf('one');
    const verdict = verifySharedMemoryAuthorSeal(sharedMemoryAuthorSealFields(NAME, seal), shareOf('one'));
    expect(verdict.kind).toBe('verified');
    if (verdict.kind !== 'verified') return;
    expect(verdict.verified).toMatchObject({ contextGraphId: CG, subGraphName: SUB, assertionName: NAME });
    expect(verdict.verified.seal).toMatchObject({
      authorAddress: AUTHOR.address,
      kav10Address: KAV10,
      chainId: 31337n,
      reservedKaId: seal.reservedKaId,
      kaUal: ualOf(),
      assertionVersion: '1',
      publicTripleCount: 1,
      privateTripleCount: 0,
    });
    expect(ethers.hexlify(verdict.verified.seal.merkleRoot)).toBe(ethers.hexlify(seal.merkleRoot));
    expect(verdict.verified.seal.authorAttestationVS).toEqual(seal.authorAttestationVS);
  });

  it('reports a share without a seal as absent', () => {
    expect(verifySharedMemoryAuthorSeal({}, shareOf('one'))).toEqual({ kind: 'absent' });
    expect(verifySharedMemoryAuthorSeal({ assertionName: '', authorSeal: new Uint8Array() }, shareOf('one')))
      .toEqual({ kind: 'absent' });
  });

  it.each([
    ['a name without a seal', async () => ({ assertionName: NAME }), shareOf('one'), /without an author seal/],
    ['a name that is not an assertion name', async () => ({
      ...sharedMemoryAuthorSealFields(NAME, await sealOf('one')), assertionName: 'reports/1',
    }), shareOf('one'), /invalid assertion name/],
    ['seal bytes that are not a canonical seal', async () => ({
      assertionName: NAME, authorSeal: new TextEncoder().encode('{"not":"a seal"}'),
    }), shareOf('one'), /canonical-seal/],
    ['a seal of another version', async () => sharedMemoryAuthorSealFields(NAME, await sealOf('one', { version: 2 })),
      shareOf('one'), /the share for/],
    ['a seal of another asset', async () => sharedMemoryAuthorSealFields(NAME, await sealOf('one', { number: 8n })),
      shareOf('one'), /the share for/],
    ['a seal counting other triples', async () => sharedMemoryAuthorSealFields(NAME, await sealOf('one')),
      shareOf('one', { publicTripleCount: 2 }), /count different triples/],
    ['a seal naming another private root', async () => sharedMemoryAuthorSealFields(NAME, await sealOf('one')),
      shareOf('one', { privateTripleCount: 0, privateMerkleRoot: new Uint8Array(32).fill(9) }), /private roots/],
    ['a seal of other content', async () => sharedMemoryAuthorSealFields(NAME, await sealOf('two')),
      shareOf('one'), /does not commit to the content/],
    ['a seal signed by someone else', async () => sharedMemoryAuthorSealFields(NAME, await sealOf('one', { signer: STRANGER })),
      shareOf('one'), /not the author/],
  ])('rejects %s', async (_label, fields, share, reason) => {
    const verdict = verifySharedMemoryAuthorSeal(await fields(), share);
    expect(verdict.kind).toBe('rejected');
    expect(verdict.kind === 'rejected' ? verdict.reason : '').toMatch(reason);
  });
});

describe('sharedMemoryShareSignedBy', () => {
  const message = new TextEncoder().encode('share bytes');
  const deliveryOf = async (bytes: Uint8Array) => {
    const { decodeGossipEnvelope } = await import('@origintrail-official/dkg-core');
    const envelope = decodeGossipEnvelope(bytes);
    return { envelope, signedPayload: new Uint8Array(envelope.payload) };
  };

  it('accepts the author\'s signature over this graph\'s share', async () => {
    expect(sharedMemoryShareSignedBy(await deliveryOf(await signed(message)), CG, AUTHOR.address.toLowerCase())).toBe(true);
  });

  it('refuses an unsigned delivery, another signer, another graph and other bytes', async () => {
    expect(sharedMemoryShareSignedBy({ signedPayload: message }, CG, AUTHOR.address)).toBe(false);
    expect(sharedMemoryShareSignedBy(await deliveryOf(await signed(message, STRANGER)), CG, AUTHOR.address)).toBe(false);
    expect(sharedMemoryShareSignedBy(await deliveryOf(await signed(message, AUTHOR, 'another-graph')), CG, AUTHOR.address)).toBe(false);
    const delivery = await deliveryOf(await signed(message));
    expect(sharedMemoryShareSignedBy({ ...delivery, signedPayload: new TextEncoder().encode('other bytes') }, CG, AUTHOR.address)).toBe(false);
    expect(sharedMemoryShareSignedBy({ ...delivery, envelope: { ...delivery.envelope, type: 'share-chunk' } }, CG, AUTHOR.address)).toBe(false);
    expect(sharedMemoryShareSignedBy({ ...delivery, envelope: { ...delivery.envelope, signature: new Uint8Array([1, 2, 3]) } }, CG, AUTHOR.address)).toBe(false);
  });
});

describe('sharedMemoryAuthorSealFields', () => {
  it('sends no seal that has no canonical form', async () => {
    const seal = await sealOf('one');
    expect(sharedMemoryAuthorSealFields(NAME, { ...seal, authorSchemeVersion: 2 })).toEqual({});
    expect(sharedMemoryAuthorSealFields(NAME, { ...seal, reservedKaId: undefined })).toEqual({});
  });
});

describe('keepSharedMemoryAuthorSeal', () => {
  async function verifiedOf(value: string, version = 1, number = 7n) {
    const verdict = verifySharedMemoryAuthorSeal(
      sharedMemoryAuthorSealFields(NAME, await sealOf(value, { version, number })),
      shareOf(value, { assertionVersion: String(version), kaUal: ualOf(number) }),
    );
    if (verdict.kind !== 'verified') throw new Error(`fixture seal not verified: ${JSON.stringify(verdict)}`);
    return verdict.verified;
  }

  it('records the seal and the share-complete marker where VM publish reads them', async () => {
    const store = new OxigraphStore();
    await keepSharedMemoryAuthorSeal(store, await verifiedOf('one'));
    const candidate = await keptSeal(store);
    expect(candidate?.coordinate).toEqual({ scope: `${CG}/${SUB}`, agentAddress: AUTHOR.address, name: NAME });
    expect(ethers.hexlify(candidate!.seal.merkleRoot)).toBe(ethers.hexlify(rootOf('one')));
    expect(await hasShareCompleteMarker(store)).toBe(true);
  });

  it('replaces an earlier seal of the coordinate, in either address spelling, and keeps other rows', async () => {
    const store = new OxigraphStore();
    const lower = AUTHOR.address.toLowerCase();
    const lowerSubject = contextGraphAssertionUri(CG, lower, NAME, SUB);
    const old = await sealOf('one');
    await store.insert([
      ...buildAssertionSealQuads({
        assertionUri: lowerSubject,
        metaGraph: META_GRAPH,
        merkleRoot: old.merkleRoot,
        authorAddress: lower,
        authorAttestationR: old.authorAttestationR,
        authorAttestationVS: old.authorAttestationVS,
        authorSchemeVersion: 1,
        chainId: old.chainId,
        kav10Address: old.kav10Address,
        reservedKaId: old.reservedKaId!,
        finalizedAtIso: old.finalizedAtIso,
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: old.kaUal!,
        assertionVersion: old.assertionVersion!,
        publicTripleCount: 1,
        privateTripleCount: 0,
      }),
      { subject: assertionLifecycleUri(CG, lower, NAME, SUB), predicate: SWM_SHARE_COMPLETE_PRED, object: '"true"', graph: META_GRAPH },
    ]);
    await keepSharedMemoryAuthorSeal(store, await verifiedOf('one'));
    const receipt = buildAssertionPublishReceiptQuads({
      assertionUri: contextGraphAssertionUri(CG, AUTHOR.address, NAME, SUB),
      metaGraph: META_GRAPH,
      txHash: '0xabc',
      blockNumber: 12n,
    });
    await store.insert(receipt);

    expect(await keepSharedMemoryAuthorSeal(store, await verifiedOf('two', 2))).toEqual({ kind: 'kept' });

    expect(await rowsOf(store, lowerSubject)).toEqual([]);
    expect(await hasShareCompleteMarker(store, lower)).toBe(false);
    const candidate = await keptSeal(store);
    expect(candidate?.seal.assertionVersion).toBe('2');
    expect(ethers.hexlify(candidate!.seal.merkleRoot)).toBe(ethers.hexlify(rootOf('two')));
    expect(await hasShareCompleteMarker(store)).toBe(true);
    const rows = await rowsOf(store, contextGraphAssertionUri(CG, AUTHOR.address, NAME, SUB));
    for (const quad of receipt) {
      expect(rows.some((row) => row.predicate === quad.predicate)).toBe(true);
    }
  });

  it('replaces the seal only with a seal of the same asset at the same or a newer version', async () => {
    const store = new OxigraphStore();
    expect(await keepSharedMemoryAuthorSeal(store, await verifiedOf('two', 2))).toEqual({ kind: 'kept' });

    expect(await keepSharedMemoryAuthorSeal(store, await verifiedOf('other', 1, 8n))).toEqual({
      kind: 'refused',
      reason: `"${NAME}" is bound here to another asset, ${ualOf()}`,
    });
    expect(await keepSharedMemoryAuthorSeal(store, await verifiedOf('one', 1))).toEqual({
      kind: 'refused',
      reason: 'version 1 is older than the kept version 2',
    });
    const kept = await keptSeal(store);
    expect(kept?.seal.kaUal).toBe(ualOf());
    expect(kept?.seal.assertionVersion).toBe('2');

    expect(await keepSharedMemoryAuthorSeal(store, await verifiedOf('two', 2))).toEqual({ kind: 'kept' });
    expect(await keepSharedMemoryAuthorSeal(store, await verifiedOf('three', 3))).toEqual({ kind: 'kept' });
    const newer = await keptSeal(store);
    expect(newer?.seal.assertionVersion).toBe('3');
    expect(ethers.hexlify(newer!.seal.merkleRoot)).toBe(ethers.hexlify(rootOf('three')));
    expect(await hasShareCompleteMarker(store)).toBe(true);
  });

  it('does not bind a name this node published when it holds no seal of it', async () => {
    const store = new OxigraphStore();
    await store.insert([{
      subject: assertionLifecycleUri(CG, AUTHOR.address.toLowerCase(), NAME, SUB),
      predicate: 'http://dkg.io/ontology/vmCurrentAssertion',
      object: `"${ethers.hexlify(rootOf('one')).slice(2)}"`,
      graph: META_GRAPH,
    }]);
    expect(await keepSharedMemoryAuthorSeal(store, await verifiedOf('other', 1, 8n))).toEqual({
      kind: 'refused',
      reason: `"${NAME}" was published here and names no asset to compare with`,
    });
    expect(await keptSeal(store)).toBeUndefined();
    expect(await hasShareCompleteMarker(store)).toBe(false);
  });

  it('records the lifecycle\'s KA number and name, which identifier reads match', async () => {
    const store = new OxigraphStore();
    await keepSharedMemoryAuthorSeal(store, await verifiedOf('one'));
    // The lookup `resolveByKaId` runs: the lifecycle with the KA number, and its name.
    const found = await store.query(`SELECT ?lifecycle ?name WHERE { GRAPH <${META_GRAPH}> {
      ?lifecycle <${KA_ID_PRED}> ?n . FILTER(?n = 7)
      ?lifecycle <http://dkg.io/ontology/assertionName> ?name } }`);
    expect(found.type === 'bindings' ? found.bindings : []).toEqual([
      { lifecycle: assertionLifecycleUri(CG, AUTHOR.address, NAME, SUB), name: `"${NAME}"` },
    ]);
    // No lifecycle state until this node publishes the asset, so it is not
    // taken for a lifecycle of the author's own (the queued lane refuses it).
    const state = await store.query(`ASK { GRAPH <${META_GRAPH}> { ?lifecycle <http://dkg.io/ontology/state> ?s } }`);
    expect(state.type === 'boolean' && state.value).toBe(false);
  });

  it('keeps the asset its lifecycle names when the seal rows are gone', async () => {
    const store = new OxigraphStore();
    await keepSharedMemoryAuthorSeal(store, await verifiedOf('one'));
    await store.deleteByPattern({ graph: META_GRAPH, subject: contextGraphAssertionUri(CG, AUTHOR.address, NAME, SUB) });

    expect(await keepSharedMemoryAuthorSeal(store, await verifiedOf('other', 1, 8n))).toEqual({
      kind: 'refused',
      reason: `"${NAME}" is bound here to another asset, KA number 7`,
    });
    expect(await keepSharedMemoryAuthorSeal(store, await verifiedOf('one'))).toEqual({ kind: 'kept' });
    expect((await keptSeal(store))?.seal.kaUal).toBe(ualOf());
  });
});

describe('SharedMemoryHandler keeps the author seal a share carries', () => {
  it('keeps the seal of an applied share, and heals it on an exact replay', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    const message = await signed(shareMessage('one', await sealOf('one')));

    expect(await handler.handle(message, PEER_ID)).toMatchObject({ applied: true });
    expect((await keptSeal(store))?.seal.assertionVersion).toBe('1');
    expect(await hasShareCompleteMarker(store)).toBe(true);

    await store.deleteByPattern({ graph: META_GRAPH, subject: contextGraphAssertionUri(CG, AUTHOR.address, NAME, SUB) });
    expect(await handler.handle(message, PEER_ID)).toMatchObject({ applied: true });
    expect(await keptSeal(store)).toBeDefined();
  });

  it('replaces the seal when a newer version is shared', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    await handler.handle(await signed(shareMessage('one', await sealOf('one'))), PEER_ID);
    expect(await handler.handle(await signed(shareMessage('two', await sealOf('two', { version: 2 }))), PEER_ID))
      .toMatchObject({ applied: true });
    const candidate = await keptSeal(store);
    expect(candidate?.seal.assertionVersion).toBe('2');
    expect(ethers.hexlify(candidate!.seal.merkleRoot)).toBe(ethers.hexlify(rootOf('two')));
    expect(await publishTarget(store)).toBe(ualOf());
  });

  it('keeps the newer seal when an older version is replayed and refused', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    const first = await signed(shareMessage('one', await sealOf('one')));
    await handler.handle(first, PEER_ID);
    await handler.handle(await signed(shareMessage('two', await sealOf('two', { version: 2 }))), PEER_ID);

    expect(await handler.handle(first, PEER_ID)).toMatchObject({ applied: false });
    const candidate = await keptSeal(store);
    expect(candidate?.seal.assertionVersion).toBe('2');
    expect(ethers.hexlify(candidate!.seal.merkleRoot)).toBe(ethers.hexlify(rootOf('two')));
    expect(await hasShareCompleteMarker(store)).toBe(true);
  });

  it('keeps the seal when a share of the same version with other content is refused', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    await handler.handle(await signed(shareMessage('one', await sealOf('one'))), PEER_ID);

    const conflicting = shareMessage('two', await sealOf('two'), { shareOperationId: 'op-conflicting' });
    expect(await handler.handle(await signed(conflicting), PEER_ID)).toMatchObject({ applied: false });
    const candidate = await keptSeal(store);
    expect(candidate?.seal.assertionVersion).toBe('1');
    expect(ethers.hexlify(candidate!.seal.merkleRoot)).toBe(ethers.hexlify(rootOf('one')));
    expect(await hasShareCompleteMarker(store)).toBe(true);
  });

  it('applies the share but keeps no seal that is not the author\'s', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    const forged = await signed(shareMessage('one', await sealOf('one', { signer: STRANGER })));
    expect(await handler.handle(forged, PEER_ID)).toMatchObject({ applied: true });
    expect(await keptSeal(store)).toBeUndefined();
    expect(await hasShareCompleteMarker(store)).toBe(false);
  });

  it('keeps no seal for content other than what the share delivered', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    expect(await handler.handle(await signed(shareMessage('one', await sealOf('two'))), PEER_ID)).toMatchObject({ applied: true });
    expect(await keptSeal(store)).toBeUndefined();
  });

  it('leaves the author\'s own node alone: its finalize owns the seal', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus(), {
      localAgentAddresses: () => [AUTHOR.address.toLowerCase()],
    });
    expect(await handler.handle(await signed(shareMessage('one', await sealOf('one'))), PEER_ID)).toMatchObject({ applied: true });
    expect(await keptSeal(store)).toBeUndefined();
    expect(await hasShareCompleteMarker(store)).toBe(false);
  });

  it('keeps seals only where the node says it keeps them (the graph\'s curator)', async () => {
    const asked: string[] = [];
    const notCurator = new OxigraphStore();
    const elsewhere = new SharedMemoryHandler(notCurator, new TypedEventBus(), {
      keepsAuthorSeals: (contextGraphId) => { asked.push(contextGraphId); return false; },
    });
    expect(await elsewhere.handle(await signed(shareMessage('one', await sealOf('one'))), PEER_ID)).toMatchObject({ applied: true });
    expect(asked).toEqual([CG]);
    expect(await keptSeal(notCurator)).toBeUndefined();

    const curatorStore = new OxigraphStore();
    const curator = new SharedMemoryHandler(curatorStore, new TypedEventBus(), {
      keepsAuthorSeals: async () => true,
    });
    expect(await curator.handle(await signed(shareMessage('one', await sealOf('one'))), PEER_ID)).toMatchObject({ applied: true });
    expect(await keptSeal(curatorStore)).toBeDefined();
  });

  it.each([
    ['unsigned', (message: Uint8Array) => Promise.resolve(message)],
    ['signed by another peer', (message: Uint8Array) => signed(message, STRANGER)],
    ['signed by the author for another graph', (message: Uint8Array) => signed(message, AUTHOR, 'another-graph')],
  ])('applies a share %s but keeps none of its valid seal, on a name not bound yet', async (_how, deliver) => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    expect(await handler.handle(await deliver(shareMessage('one', await sealOf('one'))), PEER_ID))
      .toMatchObject({ applied: true });
    expect(await keptSeal(store)).toBeUndefined();
    expect(await rowsOf(store, contextGraphAssertionUri(CG, AUTHOR.address, NAME, SUB))).toEqual([]);
    expect(await rowsOf(store, assertionLifecycleUri(CG, AUTHOR.address, NAME, SUB))).toEqual([]);
  });

  /** A share of another asset of the author's (KA 8), whose seal and content a peer could have seen elsewhere. */
  async function otherAssetShare(): Promise<Uint8Array> {
    return shareMessage('other', await sealOf('other', { number: 8n }), {
      kaUal: ualOf(8n), kaNumber: '8', shareOperationId: 'op-other',
    });
  }

  it.each([
    ['unsigned', (message: Uint8Array) => Promise.resolve(message)],
    ['signed by another peer', (message: Uint8Array) => signed(message, STRANGER)],
    ['signed by the author for another graph', (message: Uint8Array) => signed(message, AUTHOR, 'another-graph')],
    ['signed by the author', (message: Uint8Array) => signed(message)],
  ])('keeps the author\'s name bound to its asset when another asset\'s seal arrives %s', async (_how, deliver) => {
    // The curator holds the author's unpublished "report-1", bound to KA 7. A
    // valid seal and the content of the author's KA 8 arrive under that name.
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    await handler.handle(await signed(shareMessage('one', await sealOf('one'))), PEER_ID);
    expect(await publishTarget(store)).toBe(ualOf());

    expect(await handler.handle(await deliver(await otherAssetShare()), PEER_ID)).toMatchObject({ applied: true });
    const candidate = await keptSeal(store);
    expect(candidate?.seal.kaUal).toBe(ualOf());
    expect(candidate?.seal.reservedKaId).toBe((BigInt(AUTHOR.address) << 96n) | 7n);
    expect(ethers.hexlify(candidate!.seal.merkleRoot)).toBe(ethers.hexlify(rootOf('one')));
    expect(await publishTarget(store)).toBe(ualOf());
  });

  it('keeps the name bound to its asset when earlier shares are replayed late', async () => {
    // KA 7 binds "report-1", the author then shares KA 8 under it, and both
    // shares are delivered again later.
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    const first = await signed(shareMessage('one', await sealOf('one')));
    const other = await signed(await otherAssetShare());
    await handler.handle(first, PEER_ID);
    await handler.handle(other, PEER_ID);

    expect(await handler.handle(first, PEER_ID)).toMatchObject({ applied: true });
    expect(await handler.handle(other, PEER_ID)).toMatchObject({ applied: true });
    expect((await keptSeal(store))?.seal.kaUal).toBe(ualOf());
    expect(await publishTarget(store)).toBe(ualOf());
  });

  it('keeps the seal of the asset this node published under the name', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    await handler.handle(await signed(shareMessage('one', await sealOf('one'))), PEER_ID);
    // This node published KA 7 under the name: its lifecycle carries the VM pointer.
    await store.insert([{
      subject: assertionLifecycleUri(CG, AUTHOR.address, NAME, SUB),
      predicate: 'http://dkg.io/ontology/vmCurrentAssertion',
      object: `"${ethers.hexlify(rootOf('one')).slice(2)}"`,
      graph: META_GRAPH,
    }]);
    await handler.handle(await signed(await otherAssetShare()), PEER_ID);
    expect((await keptSeal(store))?.seal.kaUal).toBe(ualOf());
  });

  it('serializes two deliveries for one name: one whole seal remains', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    const [first, second] = await Promise.all([
      signed(shareMessage('one', await sealOf('one'))),
      signed(await otherAssetShare()),
    ]);
    await Promise.all([handler.handle(first, PEER_ID), handler.handle(second, PEER_ID)]);
    // Interleaved rows of two seals would not parse as one seal.
    const candidate = await keptSeal(store);
    expect([ualOf(), ualOf(8n)]).toContain(candidate?.seal.kaUal);
    expect(await hasShareCompleteMarker(store)).toBe(true);
  });

  it('takes a share without a seal as before', async () => {
    const store = new OxigraphStore();
    const handler = new SharedMemoryHandler(store, new TypedEventBus());
    expect(await handler.handle(await signed(shareMessage('one', undefined)), PEER_ID)).toMatchObject({ applied: true });
    expect(await keptSeal(store)).toBeUndefined();
  });
});

describe('a share carries the seal its finalize wrote', () => {
  it('reaches a receiver that is not the author, which keeps it', async () => {
    const authorStore = new OxigraphStore();
    const publisher = new DKGPublisher({
      store: authorStore,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    const subGraphUri = `${DATA_GRAPH}/${SUB}`;
    await authorStore.insert([
      { subject: subGraphUri, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/SubGraph', graph: META_GRAPH },
      { subject: subGraphUri, predicate: 'http://schema.org/name', object: `"${SUB}"`, graph: META_GRAPH },
      { subject: subGraphUri, predicate: 'http://dkg.io/ontology/createdBy', object: 'did:dkg:agent:test-agent', graph: META_GRAPH },
    ]);
    await publisher.assertionCreate(CG, NAME, AUTHOR.address, SUB);
    await publisher.assertionWrite(CG, NAME, AUTHOR.address, [
      { subject: SUBJECT, predicate: NAME_PRED, object: '"one"' },
    ], SUB);
    await finalizeRootlessAssertionForTest({
      publisher, store: authorStore, contextGraphId: CG, name: NAME, agentAddress: AUTHOR.address, subGraphName: SUB,
    });
    // The fixture finalize leaves inert signature bytes: sign the seal it wrote.
    const sealSubject = contextGraphAssertionUri(CG, AUTHOR.address, NAME, SUB);
    const sealRows = await rowsOf(authorStore, sealSubject);
    const written = parseAssertionSealQuads(sealRows, sealSubject)!;
    const typed = buildAuthorAttestationTypedData({
      chainId: written.chainId,
      kav10Address: written.kav10Address,
      merkleRoot: written.merkleRoot,
      authorAddress: written.authorAddress,
      reservedKaId: written.reservedKaId!,
      schemeVersion: AUTHOR_SCHEME_VERSION_V1,
    });
    const signature = ethers.Signature.from(await AUTHOR.signTypedData(typed.domain, typed.types, typed.message));
    await authorStore.delete(sealRows
      .filter((row) => row.predicate === ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_R
        || row.predicate === ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_VS)
      .map((row) => ({ ...row, graph: META_GRAPH })));
    await authorStore.insert([
      { subject: sealSubject, predicate: ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_R, object: `"${signature.r.slice(2)}"^^<http://www.w3.org/2001/XMLSchema#hexBinary>`, graph: META_GRAPH },
      { subject: sealSubject, predicate: ASSERTION_SEAL_PREDICATES.AUTHOR_ATTESTATION_VS, object: `"${signature.yParityAndS.slice(2)}"^^<http://www.w3.org/2001/XMLSchema#hexBinary>`, graph: META_GRAPH },
    ]);

    const promoted = await publisher.assertionPromote(CG, NAME, AUTHOR.address, {
      subGraphName: SUB,
      publisherPeerId: PEER_ID,
    });
    expect(promoted.gossipPayload?.message).toBeInstanceOf(Uint8Array);

    const receiverStore = new OxigraphStore();
    const receiver = new SharedMemoryHandler(receiverStore, new TypedEventBus());
    expect(await receiver.handle(await signed(promoted.gossipPayload!.message), PEER_ID)).toMatchObject({ applied: true });
    const kept = await keptSeal(receiverStore);
    expect(kept?.seal.kaUal).toBe(written.kaUal);
    expect(ethers.hexlify(kept!.seal.merkleRoot)).toBe(ethers.hexlify(written.merkleRoot));
    expect(ethers.hexlify(kept!.seal.authorAttestationR)).toBe(signature.r);
    expect(await hasShareCompleteMarker(receiverStore)).toBe(true);
  });
});
