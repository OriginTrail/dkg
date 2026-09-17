import { describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  ASSERTION_SEAL_PREDICATES,
  TypedEventBus,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { finalizeRootlessAssertionForTest } from './_helpers/rootless-lifecycle.js';

const CG = 'sealed-create-retry';
const AUTHOR = '0x00000000000000000000000000000000000000a1';
const NAME = 'evidence-pack-retry';
const quad = (value: string) => ({
  subject: 'urn:test:evidence-pack',
  predicate: 'https://umanitek.ai/dkg/evidence-pack/createdAt',
  object: JSON.stringify(value),
  graph: '',
});

async function sealedDraft() {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store, chain: new NoChainAdapter(), eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  await publisher.assertionCreate(CG, NAME, AUTHOR);
  await publisher.assertionWrite(CG, NAME, AUTHOR, [quad('original')]);
  await finalizeRootlessAssertionForTest({ publisher, store, contextGraphId: CG, name: NAME, agentAddress: AUTHOR });
  return { publisher, store };
}

async function snapshot(store: OxigraphStore) {
  return JSON.stringify(await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o'));
}

async function moveActiveSealToNumberedSubject(publisher: DKGPublisher, store: OxigraphStore) {
  const nameKeyedSubject = contextGraphAssertionUri(CG, AUTHOR, NAME);
  const numberedSubject = await publisher.wmGraphUri(CG, AUTHOR, NAME);
  const metaGraph = contextGraphMetaUri(CG);
  const result = await store.query(`CONSTRUCT { <${nameKeyedSubject}> ?p ?o } WHERE {
    GRAPH <${metaGraph}> { <${nameKeyedSubject}> ?p ?o }
  }`);
  const predicates = new Set<string>(Object.values(ASSERTION_SEAL_PREDICATES));
  const sealQuads = result.type === 'quads'
    ? result.quads.filter((candidate) => predicates.has(candidate.predicate))
    : [];
  expect(sealQuads.some(
    (candidate) => candidate.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT,
  )).toBe(true);
  await store.delete(sealQuads);
  await store.insert(sealQuads.map((candidate) => ({ ...candidate, subject: numberedSubject })));
  return numberedSubject;
}

describe('sealed Knowledge Asset create retry', () => {
  it('returns the existing graph without changing its seal, lifecycle or content', async () => {
    const { publisher, store } = await sealedDraft();
    const before = await snapshot(store);
    const graph = await publisher.wmGraphUri(CG, AUTHOR, NAME);
    expect(await publisher.assertionCreate(CG, NAME, AUTHOR)).toBe(graph);
    expect(await snapshot(store)).toBe(before);
  });

  it('rejects an appended timestamp before changing the sealed draft', async () => {
    const { publisher, store } = await sealedDraft();
    await publisher.assertionCreate(CG, NAME, AUTHOR);
    const before = await snapshot(store);
    await expect(publisher.assertionWrite(CG, NAME, AUTHOR, [quad('retry')]))
      .rejects.toMatchObject({ code: 'KA_ASSERTION_ALREADY_FINALIZED' });
    expect(await snapshot(store)).toBe(before);
  });

  it('also rejects private writes before changing any graph', async () => {
    const { publisher, store } = await sealedDraft();
    const before = await snapshot(store);
    await expect(publisher.assertionWritePrivate(CG, NAME, AUTHOR, [quad('retry')]))
      .rejects.toMatchObject({ code: 'KA_ASSERTION_ALREADY_FINALIZED' });
    expect(await snapshot(store)).toBe(before);
  });

  it('treats a numbered-WM-only seal as active for create and both write paths', async () => {
    const { publisher, store } = await sealedDraft();
    const numberedSubject = await moveActiveSealToNumberedSubject(publisher, store);
    const before = await snapshot(store);

    expect(await publisher.assertionCreate(CG, NAME, AUTHOR)).toBe(numberedSubject);
    expect(await snapshot(store)).toBe(before);
    await expect(publisher.assertionWrite(CG, NAME, AUTHOR, [quad('retry')]))
      .rejects.toMatchObject({ code: 'KA_ASSERTION_ALREADY_FINALIZED' });
    await expect(publisher.assertionWritePrivate(CG, NAME, AUTHOR, [quad('private retry')]))
      .rejects.toMatchObject({ code: 'KA_ASSERTION_ALREADY_FINALIZED' });
    expect(await snapshot(store)).toBe(before);
  });

  it('allows an unpublished sealed draft to be explicitly discarded and recreated', async () => {
    const { publisher } = await sealedDraft();
    const graph = await publisher.wmGraphUri(CG, AUTHOR, NAME);
    await publisher.assertionDiscard(CG, NAME, AUTHOR);
    expect(await publisher.assertionCreate(CG, NAME, AUTHOR)).toBe(graph);
    await publisher.assertionWrite(CG, NAME, AUTHOR, [quad('replacement')]);
    expect((await publisher.assertionQuery(CG, NAME, AUTHOR)).map(q => q.object)).toEqual(['"replacement"']);
  });

  it('keeps unrelated asset creation writable', async () => {
    const { publisher } = await sealedDraft();
    await publisher.assertionCreate(CG, 'another-asset', AUTHOR);
    await publisher.assertionWrite(CG, 'another-asset', AUTHOR, [quad('new')]);
    expect(await publisher.assertionQuery(CG, 'another-asset', AUTHOR)).toHaveLength(1);
  });
});
