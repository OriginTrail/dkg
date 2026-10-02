/**
 * GH#2958 — a finalized-but-never-published update must not burn the version number of the
 * next draft. `update()` (and the publisher, StorageACK handler, peers and the chain behind it)
 * require `confirmed + 1`; finalize used to number a draft of a published KA as
 * `lifecycle row + 1`, where the lifecycle row is "last FINALIZED", so every abandoned finalize
 * pushed all later drafts one number too high and the KA could never be updated again.
 *
 * Hermetic: a real DKGPublisher + the real agent facade over an in-memory store, a chain stub,
 * and a hand-seeded "A is published and confirmed" state (the same rows a real confirmed publish
 * leaves). The end-to-end proof on a real chain is in e2e-memory-layers.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTHOR_SCHEME_VERSION_V1,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  assertionLifecycleUri,
  buildAuthorAttestationTypedData,
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphSubGraphUri,
  createGraphKnowledgeAssetScope,
  generateEd25519Keypair,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher, computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/dkg-agent.js';
import { applyPublishedNamedKaVmLifecycle } from '../src/named-ka-vm-lifecycle.js';
import { makeTestKaNumberAllocator } from './_helpers/ka-allocator.js';
import { stubAgent } from './_helpers/foreign-author-resolution-fixtures.js';

const CG = 'finalize-version-gap';
const NAME = 'abandoned-update';
const CHAIN_ID = 'mock:31337';
const EVM_CHAIN_ID = 31337n;
const KAV_ADDRESS = '0x1111111111111111111111111111111111111111';
const WALLET = new ethers.Wallet(
  '0x59c6995e998f97a5a0044976f7d4b21ddc10b15f2b79366a0a69c3fcf4e7f5c2',
);
const AUTHOR = WALLET.address;
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

type Seal = {
  assertionVersion: string;
  kaUal: string;
  reservedKaId: bigint;
  merkleRoot: Uint8Array;
};

function q(subject: string, predicate: string, object: string, graph = ''): Quad {
  return { subject, predicate, object, graph };
}

function content(label: string): Quad[] {
  return [q('urn:abandoned:asset', 'urn:value', `"${label}"`)];
}

function int(value: bigint | number): string {
  return `"${value.toString()}"^^<${XSD_INTEGER}>`;
}

async function makeAgent(store: OxigraphStore) {
  const chain = {
    chainId: CHAIN_ID,
    getEvmChainId: async () => EVM_CHAIN_ID,
    getKnowledgeAssetsLifecycleAddress: async () => KAV_ADDRESS,
    hasContractCode: async () => false,
  };
  const agent = stubAgent(store, AUTHOR);
  agent.chain = chain;
  agent.publisher = new DKGPublisher({
    store,
    chain: chain as never,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    writeLocks: new Map(),
  });
  agent.kaNumberAllocator = makeTestKaNumberAllocator();
  agent.reconciledKaAuthors = new Set<string>();
  agent.localAgents = new Map();
  return agent as DKGAgent & any;
}

/** Sign the author attestation with a fixed key, exactly like a self-sovereign caller. */
async function signTypedData(typedData: any) {
  const signed = ethers.Signature.from(
    await WALLET.signTypedData(typedData.domain, typedData.types, typedData.message),
  );
  return { r: ethers.getBytes(signed.r), vs: ethers.getBytes(signed.yParityAndS) };
}

async function finalize(agent: any, subGraphName?: string, extra: Record<string, unknown> = {}): Promise<Seal> {
  return await agent.assertion.finalize(CG, NAME, {
    subGraphName,
    authorAgentAddress: AUTHOR,
    authorSignTypedData: signTypedData,
    ...extra,
  }) as Seal;
}

async function draft(agent: any, label: string, subGraphName?: string): Promise<void> {
  await agent.assertion.write(CG, NAME, content(label), { subGraphName });
}

async function lifecycleVersions(store: OxigraphStore, subGraphName?: string): Promise<string[]> {
  const result = await store.query(
    `SELECT ?v WHERE { GRAPH <${contextGraphMetaUri(CG)}> { <${assertionLifecycleUri(CG, AUTHOR, NAME, subGraphName)}> <${DKG}assertionVersion> ?v } }`,
  );
  return result.type === 'bindings'
    ? result.bindings.map((row) => String(row['v']).replace(/^"/, '').replace(/"(\^\^<[^>]+>)?$/, ''))
    : [];
}

/**
 * Leave the store exactly as a confirmed publish of `seal` leaves it: the sealed content in the
 * VM graph, the lifecycle VM pointer, and the confirmed KA-UAL record `update()` validates.
 */
async function seedPublished(
  store: OxigraphStore,
  agent: any,
  seal: Seal,
  opts: { subGraphName?: string; status?: string; record?: boolean } = {},
): Promise<void> {
  const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
  const vmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, scope, opts.subGraphName);
  const sealed = await agent.publisher.assertionQuery(CG, NAME, AUTHOR, opts.subGraphName);
  await store.insert(sealed.map((quad: Quad) => ({ ...quad, graph: vmGraph })));
  await applyPublishedNamedKaVmLifecycle(store, {
    contextGraphId: CG,
    agentAddress: AUTHOR,
    name: NAME,
    subGraphName: opts.subGraphName,
    publishedUal: seal.kaUal,
    merkleRoot: ethers.hexlify(seal.merkleRoot),
    packedKaId: seal.reservedKaId,
  });
  if (opts.record === false) return;
  await seedConfirmedRecord(store, seal, opts);
}

/** The confirmed KA record `update()` validates: every row, so it can really answer. */
async function seedConfirmedRecord(
  store: OxigraphStore,
  seal: Seal,
  opts: { subGraphName?: string; status?: string; version?: number | string } = {},
): Promise<void> {
  const metaGraph = contextGraphMetaUri(CG);
  const scope = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
  const vmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, scope, opts.subGraphName);
  await store.insert([
    q(seal.kaUal, `${DKG}contentScopeVersion`, int(GRAPH_KA_CONTENT_SCOPE_VERSION), metaGraph),
    q(seal.kaUal, `${DKG}kaUal`, seal.kaUal, metaGraph),
    q(seal.kaUal, `${DKG}assertionVersion`, int(opts.version ?? seal.assertionVersion), metaGraph),
    q(seal.kaUal, `${DKG}batchId`, int(seal.reservedKaId), metaGraph),
    q(seal.kaUal, `${DKG}status`, `"${opts.status ?? 'confirmed'}"`, metaGraph),
    q(seal.kaUal, `${DKG}contextGraph`, contextGraphDataUri(CG), metaGraph),
    q(seal.kaUal, `${DKG}assertionGraph`, vmGraph, metaGraph),
  ]);
}

async function registerSubGraph(store: OxigraphStore, subGraphName: string): Promise<void> {
  const metaGraph = contextGraphMetaUri(CG);
  const subGraphUri = contextGraphSubGraphUri(CG, subGraphName);
  await store.createGraph(metaGraph);
  await store.insert([
    q(subGraphUri, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${DKG}SubGraph`, metaGraph),
    q(subGraphUri, 'http://schema.org/name', `"${subGraphName}"`, metaGraph),
    q(subGraphUri, `${DKG}createdBy`, 'did:dkg:agent:test-agent', metaGraph),
  ]);
}

/** create + write(A) + finalize(A) + "A is published and confirmed" at version 1. */
async function publishedKa(opts: { subGraphName?: string; status?: string; record?: boolean } = {}) {
  const store = new OxigraphStore();
  if (opts.subGraphName) await registerSubGraph(store, opts.subGraphName);
  const agent = await makeAgent(store);
  await agent.assertion.create(CG, NAME, { subGraphName: opts.subGraphName });
  await draft(agent, 'A', opts.subGraphName);
  const sealA = await finalize(agent, opts.subGraphName);
  expect(sealA.assertionVersion).toBe('1');
  await seedPublished(store, agent, sealA, opts);
  return { store, agent, sealA };
}

/** Re-open the published content as an editable draft, edit it and finalize the edit. */
async function editAndFinalize(agent: any, label: string, subGraphName?: string, extra: Record<string, unknown> = {}) {
  await agent.assertion.pullFrom(CG, NAME, 'vm', { subGraphName, onConflict: 'replace' });
  await draft(agent, label, subGraphName);
  return await finalize(agent, subGraphName, extra);
}

describe('GH#2958 finalize numbers a draft of a published KA from the confirmed version', () => {
  it('numbers the first update of a published KA confirmed + 1', async () => {
    const { agent, store } = await publishedKa();
    const sealB = await editAndFinalize(agent, 'B');
    expect(sealB.assertionVersion).toBe('2');
    expect(await lifecycleVersions(store)).toEqual(['2']);
  });

  it('an abandoned finalized update does not burn its number: the next draft is confirmed + 1 again', async () => {
    const { agent, store } = await publishedKa();
    const sealB = await editAndFinalize(agent, 'B'); // finalized, never published: abandoned
    expect(sealB.assertionVersion).toBe('2');

    const sealC = await editAndFinalize(agent, 'C');
    // The lifecycle row is "last finalized"; update() needs the confirmed version (1) + 1.
    expect(sealC.assertionVersion).toBe('2');
    expect(sealC.kaUal).toBe(sealB.kaUal);
    expect(await lifecycleVersions(store)).toEqual(['2']);
  });

  it('stays at confirmed + 1 across any number of abandoned drafts', async () => {
    const { agent } = await publishedKa();
    for (const label of ['B', 'C', 'D', 'E']) {
      expect((await editAndFinalize(agent, label)).assertionVersion).toBe('2');
    }
  });

  it('numbers a sub-graph KA the same way', async () => {
    const { agent } = await publishedKa({ subGraphName: 'notes' });
    expect((await editAndFinalize(agent, 'B', 'notes')).assertionVersion).toBe('2');
    expect((await editAndFinalize(agent, 'C', 'notes')).assertionVersion).toBe('2');
  });

  it('derives the same number on the pre-signed author branch', async () => {
    const { agent, sealA } = await publishedKa();
    expect((await editAndFinalize(agent, 'B')).assertionVersion).toBe('2');

    // C is finalized with an attestation signed up front over the exact content it will seal
    // (pull-from re-seeds the published content A, the edit adds C).
    await agent.assertion.pullFrom(CG, NAME, 'vm', { onConflict: 'replace' });
    await draft(agent, 'C');
    const merkleRoot = computeFlatKCRootV10([...content('A'), ...content('C')], []);
    const typedData = buildAuthorAttestationTypedData({
      chainId: EVM_CHAIN_ID,
      kav10Address: KAV_ADDRESS,
      merkleRoot,
      authorAddress: AUTHOR,
      reservedKaId: sealA.reservedKaId,
      schemeVersion: AUTHOR_SCHEME_VERSION_V1,
    });
    const signature = await signTypedData(typedData);
    const sealC = await agent.assertion.finalize(CG, NAME, {
      preSignedAuthorAttestation: {
        address: AUTHOR,
        reservedKaId: sealA.reservedKaId,
        expectedMerkleRoot: merkleRoot,
        signature,
        schemeVersion: AUTHOR_SCHEME_VERSION_V1,
      },
    }) as Seal;
    expect(sealC.assertionVersion).toBe('2');
  });

  it('an idempotent re-finalize of an unchanged seal returns its stored number', async () => {
    const { agent } = await publishedKa();
    const sealB = await editAndFinalize(agent, 'B');
    const again = await finalize(agent);
    expect(again.assertionVersion).toBe(sealB.assertionVersion);
    expect(again.merkleRoot).toEqual(sealB.merkleRoot);
  });

  it('a never-published KA keeps reusing its number (mints are always version 1)', async () => {
    const store = new OxigraphStore();
    const agent = await makeAgent(store);
    await agent.assertion.create(CG, NAME);
    await draft(agent, 'first');
    expect((await finalize(agent)).assertionVersion).toBe('1');
    await agent.assertion.discard(CG, NAME);
    await agent.assertion.create(CG, NAME);
    await draft(agent, 'second');
    expect((await finalize(agent)).assertionVersion).toBe('1');
    expect(await lifecycleVersions(store)).toEqual(['1']);
  });

  describe('when the confirmed record cannot answer, finalize keeps the previous formula (it never starts failing)', () => {
    it('record not materialised locally: last finalized + 1', async () => {
      const { agent } = await publishedKa({ record: false });
      expect((await editAndFinalize(agent, 'B')).assertionVersion).toBe('2');
      expect((await editAndFinalize(agent, 'C')).assertionVersion).toBe('3');
    });

    it('record not confirmed yet (an update in flight): last finalized + 1', async () => {
      const { agent } = await publishedKa({ status: 'tentative' });
      expect((await editAndFinalize(agent, 'B')).assertionVersion).toBe('2');
      expect((await editAndFinalize(agent, 'C')).assertionVersion).toBe('3');
    });

    it('record ambiguous (two statuses): last finalized + 1', async () => {
      const { store, agent, sealA } = await publishedKa();
      await store.insert([q(sealA.kaUal, `${DKG}status`, '"tentative"', contextGraphMetaUri(CG))]);
      expect((await editAndFinalize(agent, 'B')).assertionVersion).toBe('2');
      expect((await editAndFinalize(agent, 'C')).assertionVersion).toBe('3');
    });

    it('record legacy (content scope 1): last finalized + 1', async () => {
      const { store, agent, sealA } = await publishedKa();
      const metaGraph = contextGraphMetaUri(CG);
      await store.deleteByPattern({ graph: metaGraph, subject: sealA.kaUal, predicate: `${DKG}contentScopeVersion` });
      await store.insert([q(sealA.kaUal, `${DKG}contentScopeVersion`, int(1), metaGraph)]);
      expect((await editAndFinalize(agent, 'B')).assertionVersion).toBe('2');
      expect((await editAndFinalize(agent, 'C')).assertionVersion).toBe('3');
    });
  });

  it('a store failure while reading the confirmed record fails the finalize and writes nothing', async () => {
    const { store, agent, sealA } = await publishedKa();
    const sealB = await editAndFinalize(agent, 'B');
    await agent.assertion.pullFrom(CG, NAME, 'vm', { onConflict: 'replace' });
    await draft(agent, 'C');

    const realQuery = store.query.bind(store);
    store.query = (async (sparql: string, options?: { source?: string }) => {
      if (options?.source === 'agent.publish.rootlessUpdate.currentMetadata') {
        throw new Error('store queue wait timeout');
      }
      return realQuery(sparql, options as never);
    }) as typeof store.query;
    const wmBefore = await agent.publisher.assertionQuery(CG, NAME, AUTHOR);
    await expect(finalize(agent)).rejects.toThrow(/store queue wait timeout/);
    store.query = realQuery as typeof store.query;

    // No seal was written for C, the lifecycle counter is untouched and the draft is intact.
    expect(await lifecycleVersions(store)).toEqual([sealB.assertionVersion]);
    expect(await agent.publisher.assertionQuery(CG, NAME, AUTHOR)).toEqual(wmBefore);
    expect(sealA.assertionVersion).toBe('1');
    // ... and finalize works again once the store recovers.
    expect((await finalize(agent)).assertionVersion).toBe('2');
  });
});

/** Make the confirmed record say `version` (as if that update had been published meanwhile). */
async function setConfirmedRecord(
  store: OxigraphStore,
  sealA: Seal,
  patch: { version?: number; status?: string },
): Promise<void> {
  const metaGraph = contextGraphMetaUri(CG);
  for (const [predicate, object] of [
    ['assertionVersion', patch.version === undefined ? undefined : int(patch.version)],
    ['status', patch.status === undefined ? undefined : `"${patch.status}"`],
  ] as const) {
    if (object === undefined) continue;
    await store.deleteByPattern({ graph: metaGraph, subject: sealA.kaUal, predicate: `${DKG}${predicate}` });
    await store.insert([q(sealA.kaUal, `${DKG}${predicate}`, object, metaGraph)]);
  }
}

async function share(agent: any, subGraphName?: string): Promise<void> {
  await agent.publisher.assertionPromote(CG, NAME, AUTHOR, { subGraphName });
}

async function enqueueIntent(agent: any, subGraphName?: string) {
  return await agent.resolveFinalizedAssertionVmPublishIntent(CG, NAME, {
    agentAddress: AUTHOR,
    ...(subGraphName ? { subGraphName } : {}),
  });
}

describe('GH#2958 enqueue refuses a seal that is not confirmed + 1 (typed, before any job exists)', () => {
  /** A seal the old numbering produced: finalized while the confirmed record could not answer. */
  async function staleSeal(opts: { subGraphName?: string } = {}) {
    const ka = await publishedKa({ status: 'tentative', ...opts });
    await editAndFinalize(ka.agent, 'B', opts.subGraphName); // abandoned: numbered 2
    const sealC = await editAndFinalize(ka.agent, 'C', opts.subGraphName); // numbered 3
    expect(sealC.assertionVersion).toBe('3');
    await setConfirmedRecord(ka.store, ka.sealA, { status: 'confirmed' }); // the record can answer now: 1
    await share(ka.agent, opts.subGraphName);
    return { ...ka, sealC };
  }

  it('accepts a seal numbered confirmed + 1', async () => {
    const { agent, store } = await publishedKa();
    await editAndFinalize(agent, 'B');
    await editAndFinalize(agent, 'C');
    await share(agent);
    const intent = await enqueueIntent(agent);
    expect(intent.assertionVersion).toBe('2');
    expect(await lifecycleVersions(store)).toEqual(['2']);
  });

  it('refuses a seal numbered above confirmed + 1 and says how to recover', async () => {
    const { agent } = await staleSeal();
    const error = await enqueueIntent(agent).catch((err: unknown) => err) as Error & { code?: string };
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('PUBLISH_INTENT_STALE');
    expect(error.message).toMatch(/numbered 3/);
    expect(error.message).toMatch(/next publishable version is 2/);
    expect(error.message).toMatch(/confirmed version is 1/);
    expect(error.message).toMatch(/pull-from \(layer "swm"/);
  });

  it('refuses a seal numbered below confirmed + 1 and points at the published version instead', async () => {
    const { agent, store, sealA } = await publishedKa();
    await editAndFinalize(agent, 'C'); // numbered 2
    await share(agent);
    await setConfirmedRecord(store, sealA, { version: 2 }); // another update was published meanwhile
    const error = await enqueueIntent(agent).catch((err: unknown) => err) as Error & { code?: string };
    expect(error.code).toBe('PUBLISH_INTENT_STALE');
    expect(error.message).toMatch(/numbered 2/);
    expect(error.message).toMatch(/next publishable version is 3/);
    expect(error.message).toMatch(/pull-from \(layer "vm"/);
  });

  it('refuses a stale sub-graph seal too', async () => {
    const { agent } = await staleSeal({ subGraphName: 'notes' });
    await expect(enqueueIntent(agent, 'notes')).rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });
  });

  it('does not judge what it cannot read: an unresolvable confirmed record leaves the call to update()', async () => {
    const ka = await publishedKa({ record: false });
    await editAndFinalize(ka.agent, 'B');
    expect((await editAndFinalize(ka.agent, 'C')).assertionVersion).toBe('3');
    await share(ka.agent);
    expect((await enqueueIntent(ka.agent)).assertionVersion).toBe('3');
  });

  it('never judges a mint, whatever record exists', async () => {
    const store = new OxigraphStore();
    const agent = await makeAgent(store);
    await agent.assertion.create(CG, NAME);
    await draft(agent, 'first');
    const seal = await finalize(agent);
    // A record complete enough to answer (confirmed v5), with no VM pointer: a mint is not judged.
    await seedConfirmedRecord(store, seal, { version: 5 });
    await share(agent);
    expect((await enqueueIntent(agent)).assertionVersion).toBe('1');
  });

  it('recovery: re-open from the shared copy, finalize again (now confirmed + 1), share, enqueue', async () => {
    const { agent, store } = await staleSeal();
    await expect(enqueueIntent(agent)).rejects.toMatchObject({ code: 'PUBLISH_INTENT_STALE' });

    await agent.assertion.pullFrom(CG, NAME, 'swm');
    expect((await finalize(agent)).assertionVersion).toBe('2');
    await share(agent);
    expect((await enqueueIntent(agent)).assertionVersion).toBe('2');
    expect(await lifecycleVersions(store)).toEqual(['2']);
  });
});
