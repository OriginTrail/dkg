import { describe, expect, it, vi } from 'vitest';
import { ASSERTION_SEAL_PREDICATES, assertionLifecycleUri } from '@origintrail-official/dkg-core';
import { ChangelogStore, GraphManager, GraphSetIndexStore, OxigraphStore, UnsupportedTripleStoreCapabilityError, type Quad } from '@origintrail-official/dkg-storage';
import {
  RECOVERY_AUTHOR as AUTHOR, RECOVERY_CG as CG, RECOVERY_NAME as NAME,
  RECOVERY_ARCHIVE, RECOVERY_META, RECOVERY_PRIVATE, RECOVERY_SUBJECT,
  RECOVERY_PREDICATES, recoveryPublisher, seedRecoveryAsset, seedInterruptedSealClear,
} from './_helpers/pull-recovery.js';
import { resolveKnowledgeAssetWorkspaceHead } from '../src/workspace-resolution.js';

const content = (quads: { subject: string; predicate: string; object: string }[]) =>
  quads.map(q => JSON.stringify([q.subject, q.predicate, q.object])).sort();

const DKG = 'http://dkg.io/ontology/';
const lifecycle = assertionLifecycleUri(CG, AUTHOR, NAME);
async function inventory(store: OxigraphStore) {
  // sparql-scan-allow: R2 -- Complete snapshot of this small, isolated test fixture only.
  const result = await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }');
  if (result.type !== 'bindings') throw new Error('Fixture inventory unavailable');
  return result.bindings.map(q => JSON.stringify([q.g, q.s, q.p, q.o])).sort();
}
async function replace(store: OxigraphStore, graph: string, subject: string, predicate: string, object?: string) {
  await store.deleteByPattern({ graph, subject, predicate });
  if (object !== undefined) await store.insert([{ graph, subject, predicate, object }]);
}

describe('interrupted SWM pull recovery', () => {
  it.each(['copy', 'move'])('inventory detects %s of identical content across SWM and WM', async action => {
    const store = new OxigraphStore();
    const { finalized } = await seedRecoveryAsset(store);
    const before = await inventory(store);
    const quad = finalized.publicQuads[0]!;
    await store.insert([{ ...quad, graph: finalized.graphUri }]);
    if (action === 'move') await store.delete([{ ...quad, graph: finalized.sharedGraphUri }]);
    expect(await inventory(store)).not.toEqual(before);
    await store.close();
  });

  it.each(RECOVERY_PREDICATES.map((_, index) => index + 1))(
    'recovers after %i legacy active-seal predicate deletions with a fresh publisher', async deletedCount => {
      const store = new OxigraphStore();
      const { finalized } = await seedRecoveryAsset(store);
      await seedInterruptedSealClear(store, deletedCount);
      const restarted = await recoveryPublisher(store);
      await expect(restarted.assertionPullFrom(CG, NAME, AUTHOR, 'swm')).resolves.toMatchObject({
        seededPublic: 1, seededPrivate: 1, kaUal: finalized.kaUal,
        assertionVersion: finalized.assertionVersion,
      });
      expect(content(await restarted.assertionQuery(CG, NAME, AUTHOR))).toEqual(content(finalized.publicQuads));
      expect(content(await restarted.assertionQueryPrivate(CG, NAME, AUTHOR))).toEqual(content(finalized.privateQuads));
      await store.close();
    },
  );
  it.each([
    'completion marker', 'operation record', 'operation digest', 'operation count',
    'newer head', 'conflicting head', 'pending operation', 'corrupt intent',
    'different intent access', 'different lifecycle KA', 'newer lifecycle version',
    'newer active residue', 'duplicate pointer', 'malformed pointer', 'operation private root', 'tampered archive', 'tampered public', 'tampered private',
  ])('refuses %s without changing any persisted data', async fault => {
    const store = new OxigraphStore();
    const { finalized } = await seedRecoveryAsset(store);
    await seedInterruptedSealClear(store, 4);
    const graphManager = new GraphManager(store);
    const head = (await resolveKnowledgeAssetWorkspaceHead({ store, graphManager,
      contextGraphId: CG, kaUal: finalized.kaUal }))!;
    const swmMeta = graphManager.sharedMemoryMetaUri(CG);
    const operation = `urn:dkg:share:${CG}:${head.shareOperationId}`;
    const headSubject = `${finalized.kaUal}#dkg-swm-head`;
    switch (fault) {
      case 'completion marker': await replace(store, RECOVERY_META, lifecycle, `${DKG}swmShareComplete`); break;
      case 'operation record': await store.deleteByPattern({ graph: swmMeta, subject: operation }); break;
      case 'operation digest': await replace(store, swmMeta, operation, `${DKG}publicQuadsDigest`, '"sha256:wrong"'); break;
      case 'operation count': await replace(store, swmMeta, operation, `${DKG}publicQuadsCount`, '"99"^^<http://www.w3.org/2001/XMLSchema#integer>'); break;
      case 'newer head': await replace(store, swmMeta, headSubject, `${DKG}assertionVersion`, '"2"^^<http://www.w3.org/2001/XMLSchema#integer>'); break;
      case 'conflicting head': await store.insert([{ graph: swmMeta, subject: headSubject,
        predicate: `${DKG}shareOperationId`, object: '"different-operation"' }]); break;
      case 'pending operation': await replace(store, RECOVERY_META, lifecycle, `${DKG}shareOperationId`, '"different-operation"'); break;
      case 'corrupt intent': await replace(store, RECOVERY_META, lifecycle, `${DKG}promoteOperationIntent`, '"invalid"'); break;
      case 'different intent access': {
        const result = await store.query(`SELECT ?o WHERE { GRAPH <${RECOVERY_META}> { <${lifecycle}> <${DKG}promoteOperationIntent> ?o } }`);
        if (result.type !== 'bindings') throw new Error('Missing intent fixture');
        const intent = JSON.parse(JSON.parse(result.bindings[0]!['o']!));
        intent.accessPolicy = 'public';
        await replace(store, RECOVERY_META, lifecycle, `${DKG}promoteOperationIntent`, JSON.stringify(JSON.stringify(intent)));
        break;
      }
      case 'different lifecycle KA': await replace(store, RECOVERY_META, lifecycle, `${DKG}reservedUal`, '"did:dkg:31337/0x00000000000000000000000000000000000000a1/99"'); break;
      case 'newer lifecycle version': await replace(store, RECOVERY_META, lifecycle, `${DKG}assertionVersion`, '"2"^^<http://www.w3.org/2001/XMLSchema#integer>'); break;
      case 'newer active residue': await replace(store, RECOVERY_META, RECOVERY_SUBJECT, ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION, '"2"^^<http://www.w3.org/2001/XMLSchema#integer>'); break;
      case 'duplicate pointer': await store.insert([{ graph: RECOVERY_META, subject: lifecycle, predicate: `${DKG}wmCurrentAssertion`, object: '"other-root"' }]); break;
      case 'malformed pointer': await replace(store, RECOVERY_META, lifecycle, `${DKG}wmCurrentAssertion`, 'urn:not-a-literal'); break;
      case 'operation private root': await replace(store, swmMeta, operation, `${DKG}privateMerkleRoot`, `"0x${'ab'.repeat(32)}"`); break;
      case 'tampered archive': await replace(store, RECOVERY_PRIVATE, RECOVERY_ARCHIVE, ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT, '"invalid"'); break;
      case 'tampered public': await store.insert([{ ...finalized.publicQuads[0]!, object: '"tampered"', graph: finalized.sharedGraphUri }]); break;
      case 'tampered private': {
        const graphs = await store.listGraphs();
        const privateGraph = graphs.find(g => g.includes('/_private/') && g.endsWith('/1'));
        if (!privateGraph) throw new Error(`Private fixture graph missing: ${graphs}`);
        await store.insert([{ ...finalized.privateQuads[0]!, object: '"tampered"', graph: privateGraph }]); break;
      }
    }
    const before = await inventory(store);
    const restarted = await recoveryPublisher(store);
    await expect(restarted.assertionPullFrom(CG, NAME, AUTHOR, 'swm', { onConflict: 'replace' })).rejects.toThrow();
    expect(await inventory(store)).toEqual(before);
    await store.close();
  });

  it('preserves the recovery-required error when no candidate proves a safe recovery', async () => {
    const store = new OxigraphStore();
    const { finalized } = await seedRecoveryAsset(store);
    await seedInterruptedSealClear(store, 4);
    await store.deleteByPattern({ graph: finalized.sharedGraphUri });
    for (const graph of await store.listGraphs()) {
      if (graph.includes('/_private/') && graph.endsWith('/1')) await store.deleteByPattern({ graph });
    }
    const before = await inventory(store);
    const publisher = await recoveryPublisher(store);
    await expect(publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm')).rejects.toMatchObject({
      code: 'KA_PROMOTE_RECOVERY_REQUIRED',
    });
    expect(await inventory(store)).toEqual(before);
    await store.close();
  });

  it.each(['consumed pointer and intent', 'legacy pointer without intent'])(
    'recovers the completed %s shape', async shape => {
      const store = new OxigraphStore();
      await seedRecoveryAsset(store);
      await seedInterruptedSealClear(store, 4);
      await replace(store, RECOVERY_META, lifecycle, `${DKG}promoteOperationIntent`);
      if (shape === 'consumed pointer and intent') await replace(store, RECOVERY_META, lifecycle, `${DKG}shareOperationId`);
      const publisher = await recoveryPublisher(store);
      await expect(publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm')).resolves.toMatchObject({ seeded: 2 });
      await store.close();
    },
  );

  it('recovers through the composed changelog and graph-index store', async () => {
    const raw = new OxigraphStore();
    const store = new ChangelogStore(new GraphSetIndexStore(raw));
    const { finalized } = await seedRecoveryAsset(store);
    await seedInterruptedSealClear(store, 4);
    const publisher = await recoveryPublisher(store);
    await expect(publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm')).resolves.toMatchObject({ seeded: 2 });
    expect(content(await publisher.assertionQuery(CG, NAME, AUTHOR))).toEqual(content(finalized.publicQuads));
    expect(await store.hasGraph(finalized.graphUri)).toBe(true);
    await store.close();
  });

  it('preserves a conflicting public draft and keeps other mutations blocked', async () => {
    const store = new OxigraphStore();
    const { finalized } = await seedRecoveryAsset(store);
    await seedInterruptedSealClear(store, 4);
    await store.insert([{ ...finalized.publicQuads[0]!, object: '"precious local draft"', graph: finalized.graphUri }]);
    const restarted = await recoveryPublisher(store);
    const before = await inventory(store);
    await expect(restarted.assertionPullFrom(CG, NAME, AUTHOR, 'swm')).rejects.toMatchObject({ code: 'WM_DRAFT_CONFLICT' });
    await expect(restarted.assertionCreate(CG, NAME, AUTHOR)).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
    await expect(restarted.assertionWrite(CG, NAME, AUTHOR, finalized.publicQuads)).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
    await expect(restarted.assertionDiscard(CG, NAME, AUTHOR)).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
    expect(await inventory(store)).toEqual(before);
    await expect(restarted.assertionPullFrom(CG, NAME, AUTHOR, 'swm', { onConflict: 'replace' })).resolves.toMatchObject({ seeded: 2 });
    await store.close();
  });

  it.each(['before clear', 'after clear', 'legacy partial clear', 'partial archive'])(
    'retries a failed pull at %s after reconnecting', async stage => {
      const store = new OxigraphStore();
      const { publisher } = await seedRecoveryAsset(store);
      const fault = new Error(`test interruption: ${stage}`);
      const update = store.update.bind(store);
      const remove = store.deleteByPatternWithoutCount.bind(store);
      const insert = store.insert.bind(store);
      let observed = false;
      vi.spyOn(store, 'update').mockImplementation(async (query, options) => {
        if (options?.source !== 'publisher.pullFrom.clearActiveSeal') return update(query, options);
        if (stage === 'legacy partial clear') throw new UnsupportedTripleStoreCapabilityError('update', 'test');
        if (stage === 'before clear' || stage === 'after clear') {
          if (stage === 'after clear') await update(query, options);
          observed = true; throw fault;
        }
        return update(query, options);
      });
      let deletes = 0;
      vi.spyOn(store, 'deleteByPatternWithoutCount').mockImplementation(async pattern => {
        if (stage === 'legacy partial clear' && pattern.graph === RECOVERY_META && pattern.subject === RECOVERY_SUBJECT) {
          if (++deletes === 5) { observed = true; throw fault; }
        }
        return remove(pattern);
      });
      vi.spyOn(store, 'insert').mockImplementation(async quads => {
        if (stage === 'partial archive' && quads.some(q => q.subject === RECOVERY_ARCHIVE)) {
          await insert(quads.slice(0, 4)); observed = true; throw fault;
        }
        return insert(quads);
      });
      await expect(publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm')).rejects.toBe(fault);
      expect(observed).toBe(true);
      vi.restoreAllMocks();
      const restarted = await recoveryPublisher(store);
      await expect(restarted.assertionPullFrom(CG, NAME, AUTHOR, 'swm')).resolves.toMatchObject({ seeded: 2 });
      await store.close();
    },
  );

  it('clears both active subjects in one update and retains unrelated metadata', async () => {
    const store = new OxigraphStore();
    const { publisher, finalized } = await seedRecoveryAsset(store);
    const unrelated: Quad = { subject: RECOVERY_SUBJECT, predicate: 'urn:test:annotation', object: '"keep"', graph: RECOVERY_META };
    const active = await store.query(`CONSTRUCT { <${RECOVERY_SUBJECT}> ?p ?o } WHERE {
      GRAPH <${RECOVERY_META}> { <${RECOVERY_SUBJECT}> ?p ?o } }`);
    if (active.type !== 'quads') throw new Error('Missing active seal');
    const sealQuads = active.quads.filter(q => RECOVERY_PREDICATES.includes(q.predicate));
    expect(sealQuads.length).toBeGreaterThan(0);
    await store.insert([unrelated, ...sealQuads.map(q => ({ ...q, subject: finalized.graphUri, graph: RECOVERY_META }))]);
    const update = vi.spyOn(store, 'update');
    await publisher.assertionPullFrom(CG, NAME, AUTHOR, 'swm');
    const clears = update.mock.calls.filter(([, options]) => options?.source === 'publisher.pullFrom.clearActiveSeal');
    expect(clears).toHaveLength(1);
    for (const subject of [RECOVERY_SUBJECT, finalized.graphUri]) {
      const remaining = await store.query(`SELECT ?p ?o WHERE { GRAPH <${RECOVERY_META}> { <${subject}> ?p ?o } }`);
      if (remaining.type !== 'bindings') throw new Error('Missing metadata query result');
      expect(remaining.bindings.filter(row => RECOVERY_PREDICATES.includes(row['p']!))).toEqual([]);
    }
    await expect(publisher.assertionWrite(CG, NAME, AUTHOR, [
      { subject: 'urn:test:next-draft', predicate: 'urn:test:value', object: '"editable"', graph: '' },
    ])).resolves.toBeUndefined();
    expect(await store.query(`ASK { GRAPH <${RECOVERY_META}> { <${RECOVERY_SUBJECT}> <urn:test:annotation> "keep" } }`)).toMatchObject({ type: 'boolean', value: true });
    vi.restoreAllMocks();
    await store.close();
  });
});
