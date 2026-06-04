import { describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TypedEventBus,
  generateEd25519Keypair,
  contextGraphMetaUri,
  contextGraphAssertionUri,
  assertionLifecycleUri,
  buildAssertionSealQuads,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/index.js';

// OT-RFC-43 §10.5.3 — `wm/pull-from` seeds a fresh WM draft from the file's
// current SWM/VM state. These are store-backed (real OxigraphStore) so the
// entity-scoped gather + onConflict behavior is exercised end to end.

const CG = 'pull-from-test';
const AGENT = '0x00000000000000000000000000000000000000a1';
const NAME = 'meeting-notes';
const SWM_GRAPH = `did:dkg:context-graph:${CG}/_shared_memory`;
const SCHEMA = 'http://schema.org/name';
const DKG = 'http://dkg.io/ontology/';

const ENTITY_1 = 'urn:e:alice';
const ENTITY_2 = 'urn:e:bob';
const SKOLEM_1 = `${ENTITY_1}/.well-known/genid/n1`;
const OTHER_FILE_ENTITY = 'urn:e:carol-other-file';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const KAV10 = '0x2222222222222222222222222222222222222222';

async function makePublisher() {
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain: new NoChainAdapter(),
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
  });
  return { publisher, store };
}

function q(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

/** Seal: record the finalized file's member entities on the assertion URI in _meta. */
function sealEntities(entities: string[]): Quad[] {
  const assertionUri = contextGraphAssertionUri(CG, AGENT, NAME);
  const meta = contextGraphMetaUri(CG);
  return buildAssertionSealQuads({
    assertionUri,
    metaGraph: meta,
    merkleRoot: new Uint8Array(32).fill(0x11),
    authorAddress: AUTHOR,
    authorAttestationR: new Uint8Array(32).fill(0x22),
    authorAttestationVS: new Uint8Array(32).fill(0x33),
    authorSchemeVersion: 1,
    chainId: 31337n,
    kav10Address: KAV10,
    finalizedAtIso: '2026-06-03T00:00:00.000Z',
    rootEntities: entities,
  });
}

async function wmQuads(store: OxigraphStore): Promise<Quad[]> {
  const wm = contextGraphAssertionUri(CG, AGENT, NAME);
  const r = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${wm}> { ?s ?p ?o } }`);
  return r.type === 'quads' ? r.quads : [];
}

async function lifecycleEventUris(store: OxigraphStore): Promise<string[]> {
  const lifecycle = assertionLifecycleUri(CG, AGENT, NAME);
  const meta = contextGraphMetaUri(CG);
  const r = await store.query(
    `SELECT DISTINCT ?event WHERE { GRAPH <${meta}> {
       ?event ?p ?o .
       FILTER(STRSTARTS(STR(?event), "${lifecycle}/event/"))
     } }`,
  );
  return r.type === 'bindings' ? r.bindings.map((row) => row['event']).filter(Boolean) : [];
}

describe('assertionPullFrom (OT-RFC-43 §10.5.3 wm/pull-from)', () => {
  it('seeds a WM draft from SWM, scoped to the file\'s sealed entities (+ skolem children)', async () => {
    const { publisher, store } = await makePublisher();
    await store.insert([
      // this file's entities in SWM
      q(ENTITY_1, SCHEMA, '"Alice"', SWM_GRAPH),
      q(SKOLEM_1, SCHEMA, '"Alice detail"', SWM_GRAPH),
      q(ENTITY_2, SCHEMA, '"Bob"', SWM_GRAPH),
      // trust/ownership bookkeeping that must NOT land in the draft
      q(ENTITY_1, `${DKG}workspaceOwner`, '"peer-a"', SWM_GRAPH),
      // a DIFFERENT file's entity co-resident in the same SWM graph
      q(OTHER_FILE_ENTITY, SCHEMA, '"Carol"', SWM_GRAPH),
      ...sealEntities([ENTITY_1, ENTITY_2]),
    ]);

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');
    expect(result.fromLayer).toBe('swm');
    expect(result.entities).toBe(2);

    const draft = await wmQuads(store);
    const subjects = new Set(draft.map((d) => d.subject));
    // the file's entities + skolem child are present...
    expect(subjects.has(ENTITY_1)).toBe(true);
    expect(subjects.has(SKOLEM_1)).toBe(true);
    expect(subjects.has(ENTITY_2)).toBe(true);
    // ...the co-resident other-file entity is NOT pulled in...
    expect(subjects.has(OTHER_FILE_ENTITY)).toBe(false);
    // ...and the workspaceOwner bookkeeping is filtered out.
    expect(draft.some((d) => d.predicate === `${DKG}workspaceOwner`)).toBe(false);
  });

  it('rejects with WM_DRAFT_CONFLICT when a draft already exists (default onConflict)', async () => {
    const { publisher, store } = await makePublisher();
    await store.insert([q(ENTITY_1, SCHEMA, '"Alice"', SWM_GRAPH), ...sealEntities([ENTITY_1])]);
    // open + dirty a WM draft
    await publisher.assertionWrite(CG, NAME, AGENT, [{ subject: ENTITY_1, predicate: SCHEMA, object: '"local edit"' }]);

    const err = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as any).code).toBe('WM_DRAFT_CONFLICT');
  });

  it('onConflict:"replace" overwrites a dirty draft with the source layer', async () => {
    const { publisher, store } = await makePublisher();
    await store.insert([q(ENTITY_2, SCHEMA, '"Bob from SWM"', SWM_GRAPH), ...sealEntities([ENTITY_2])]);
    await publisher.assertionWrite(CG, NAME, AGENT, [{ subject: ENTITY_1, predicate: SCHEMA, object: '"stale local"' }]);

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' });
    expect(result.fromLayer).toBe('swm');

    const draft = await wmQuads(store);
    const subjects = new Set(draft.map((d) => d.subject));
    expect(subjects.has(ENTITY_2)).toBe(true);   // the SWM content
    expect(subjects.has(ENTITY_1)).toBe(false);  // the stale local edit is gone
  });

  it('reopens a draft without erasing lifecycle history or stale assertion metadata', async () => {
    const { publisher, store } = await makePublisher();
    const assertionUri = contextGraphAssertionUri(CG, AGENT, NAME);
    const lifecycleUri = assertionLifecycleUri(CG, AGENT, NAME);
    const meta = contextGraphMetaUri(CG);

    await publisher.assertionCreate(CG, NAME, AGENT);
    await publisher.assertionWrite(CG, NAME, AGENT, [{ subject: ENTITY_1, predicate: SCHEMA, object: '"Alice"' }]);
    await publisher.assertionPromote(CG, NAME, AGENT);
    await store.insert([
      ...sealEntities([ENTITY_1]),
      q(assertionUri, `${DKG}sourceFileHash`, '"old-source-hash"', meta),
    ]);

    const beforeEvents = await lifecycleEventUris(store);
    expect(beforeEvents.length).toBeGreaterThanOrEqual(2);

    await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm');

    const afterEvents = await lifecycleEventUris(store);
    for (const eventUri of beforeEvents) {
      expect(afterEvents).toContain(eventUri);
    }

    const staleAssertionMeta = await store.query(
      `ASK { GRAPH <${meta}> {
         <${assertionUri}> <${DKG}sourceFileHash>|<${DKG}assertionMerkleRoot> ?o
       } }`,
    );
    expect(staleAssertionMeta.type).toBe('boolean');
    if (staleAssertionMeta.type === 'boolean') {
      expect(staleAssertionMeta.value).toBe(false);
    }

    const currentLifecycleState = await store.query(
      `SELECT ?state ?layer WHERE { GRAPH <${meta}> {
         <${lifecycleUri}> <${DKG}state> ?state ;
           <${DKG}memoryLayer> ?layer .
       } } LIMIT 1`,
    );
    expect(currentLifecycleState.type).toBe('bindings');
    if (currentLifecycleState.type === 'bindings') {
      expect(currentLifecycleState.bindings[0]['state']).toBe('"created"');
      expect(currentLifecycleState.bindings[0]['layer']).toBe('"WM"');
    }

    const draft = await wmQuads(store);
    expect(draft.some((quad) => quad.subject === ENTITY_1 && quad.object === '"Alice"')).toBe(true);
  });

  it('onConflict:"replace" does not clobber a dirty draft when the source layer is empty', async () => {
    const { publisher, store } = await makePublisher();
    await store.insert(sealEntities([ENTITY_1]));
    await publisher.assertionWrite(CG, NAME, AGENT, [{ subject: ENTITY_2, predicate: SCHEMA, object: '"local edit"' }]);

    const err = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm', { onConflict: 'replace' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as any).code).toBe('PULL_FROM_EMPTY_SOURCE');

    const draft = await wmQuads(store);
    expect(draft).toHaveLength(1);
    expect(draft[0]).toMatchObject({ subject: ENTITY_2, predicate: SCHEMA, object: '"local edit"' });
  });

  it('rejects unsafe root entities from a corrupted seal before building the source query', async () => {
    const { publisher, store } = await makePublisher();
    const corruptedSeal = sealEntities([ENTITY_1]).map((quad) =>
      quad.predicate === `${DKG}assertionRootEntity`
        ? { ...quad, object: '"urn:e:bad root"' }
        : quad,
    );
    await store.insert([
      q(ENTITY_1, SCHEMA, '"Alice"', SWM_GRAPH),
      ...corruptedSeal,
    ]);

    const err = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as any).code).toBe('PULL_FROM_INVALID_SEAL');
    expect((err as Error).message).toMatch(/invalid assertionRootEntity IRI/i);
    expect(await wmQuads(store)).toHaveLength(0);
  });

  it('throws when the file has no sealed entity list (never finalized)', async () => {
    const { publisher, store } = await makePublisher();
    await store.insert([q(ENTITY_1, SCHEMA, '"Alice"', SWM_GRAPH)]); // no seal entities
    const err = await publisher.assertionPullFrom(CG, NAME, AGENT, 'swm').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as any).code).toBe('PULL_FROM_UNFINALIZED_ASSERTION');
    expect((err as Error).message).toMatch(/no sealed entity list/i);
  });
});
