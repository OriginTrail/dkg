import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import type { OperationContext } from '@origintrail-official/dkg-core';

/**
 * Phase C — `sinceBatchId` delta sync (responder side).
 *
 * The durable DATA responder, when handed an (unsigned, optional) `sinceBatchId`
 * high-water mark, must return ONLY the data triples of Knowledge Assets whose
 * owning KC has `dkg:batchId > sinceBatchId`, while never hiding metadata or
 * un-keyed subjects (a delta is always a safe subset). Omitting the field
 * yields a full scan (backward-compatible with pre-Phase-C requesters).
 */

const CG_ID = 'mfacts';
const CG_PREFIX = `did:dkg:context-graph:${CG_ID}`;
const PER_CG_DATA = `${CG_PREFIX}/context/1`;
const PER_CG_META = `${CG_PREFIX}/context/1/_meta`;
const DKG_NS = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
const REMOTE_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const noopLog = (_ctx: OperationContext, _msg: string) => {};

function intLit(n: number): string {
  return `"${n}"^^<${XSD_INT}>`;
}

function captureHandler() {
  let captured: ((data: Uint8Array, peerId: string) => Promise<Uint8Array>) | null = null;
  return {
    register: (_proto: string, h: (data: Uint8Array, peerId: string) => Promise<Uint8Array>) => { captured = h; },
    invoke: async (envelope: SyncRequestEnvelope): Promise<string> => {
      if (!captured) throw new Error('handler not registered');
      const out = await captured(new TextEncoder().encode(JSON.stringify(envelope)), REMOTE_PEER_ID);
      return new TextDecoder().decode(out);
    },
  };
}

describe('sync responder — Phase C sinceBatchId delta filter', () => {
  let store: OxigraphStore;
  let cap: ReturnType<typeof captureHandler>;

  beforeEach(async () => {
    store = new OxigraphStore();
    const quads = [] as { graph: string; subject: string; predicate: string; object: string }[];
    // 10 KCs, batchId 1..10, each with one KA root entity carrying data.
    for (let i = 1; i <= 10; i++) {
      const kc = `did:dkg:evm:31337/0xkc${i}`;
      const ka = `${kc}/1`;
      const root = `urn:root:${i}`;
      quads.push(
        { graph: PER_CG_META, subject: kc, predicate: RDF_TYPE, object: `${DKG_NS}KnowledgeCollection` },
        { graph: PER_CG_META, subject: kc, predicate: `${DKG_NS}batchId`, object: intLit(i) },
        { graph: PER_CG_META, subject: ka, predicate: `${DKG_NS}partOf`, object: kc },
        { graph: PER_CG_META, subject: ka, predicate: `${DKG_NS}rootEntity`, object: root },
        { graph: PER_CG_DATA, subject: root, predicate: `${DKG_NS}label`, object: `"data-${i}"` },
      );
    }
    // A skolemized child subject under root 8 — must follow its parent KA's fate.
    quads.push({ graph: PER_CG_DATA, subject: `urn:root:8/.well-known/genid/abc`, predicate: `${DKG_NS}note`, object: '"skolem-8"' });
    await store.insert(quads);

    cap = captureHandler();
    registerSyncHandler({
      register: cap.register,
      protocolSync: '/origintrail/dkg/sync/1.0.0',
      syncDeniedResponse: 'sync-denied',
      syncPageSize: 5000,
      sharedMemoryTtlMs: 0,
      store,
      peerId: 'self-peer',
      parseSyncRequest: (data) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
      authorizeSyncRequest: async () => true,
      logWarn: noopLog,
      logDebug: noopLog,
    });
  });

  it('with no sinceBatchId, returns the full data set (backward compatible)', async () => {
    const out = await cap.invoke({ contextGraphId: CG_ID, offset: 0, limit: 5000, includeSharedMemory: false, phase: 'data' });
    for (let i = 1; i <= 10; i++) expect(out).toContain(`"data-${i}"`);
  });

  it('with sinceBatchId=5, returns only data for KCs with batchId > 5', async () => {
    const out = await cap.invoke({ contextGraphId: CG_ID, offset: 0, limit: 5000, includeSharedMemory: false, phase: 'data', sinceBatchId: '5' });
    // Excluded: batchId 1..5
    for (let i = 1; i <= 5; i++) expect(out).not.toContain(`"data-${i}"`);
    // Included: batchId 6..10
    for (let i = 6; i <= 10; i++) expect(out).toContain(`"data-${i}"`);
  });

  it('follows skolemized subjects to their parent KA (root 8 kept when since=5)', async () => {
    const out = await cap.invoke({ contextGraphId: CG_ID, offset: 0, limit: 5000, includeSharedMemory: false, phase: 'data', sinceBatchId: '5' });
    expect(out).toContain('"skolem-8"');
  });

  it('drops skolemized subjects of excluded KAs (root 8 child dropped when since=8)', async () => {
    const out = await cap.invoke({ contextGraphId: CG_ID, offset: 0, limit: 5000, includeSharedMemory: false, phase: 'data', sinceBatchId: '8' });
    expect(out).not.toContain('"skolem-8"');
    expect(out).toContain('"data-9"');
    expect(out).toContain('"data-10"');
  });

  it('never hides KC/KA metadata rows (subset is always safe)', async () => {
    const out = await cap.invoke({ contextGraphId: CG_ID, offset: 0, limit: 5000, includeSharedMemory: false, phase: 'data', sinceBatchId: '5' });
    // batchId meta for an EXCLUDED KC (batchId 3) is still present — meta is
    // un-keyed by rootEntity, so the never-hide branch keeps it.
    expect(out).toContain('0xkc3');
    expect(out).toContain(`${DKG_NS}batchId`);
  });

  it('with sinceBatchId at/over head returns no data triples (caught up)', async () => {
    const out = await cap.invoke({ contextGraphId: CG_ID, offset: 0, limit: 5000, includeSharedMemory: false, phase: 'data', sinceBatchId: '10' });
    for (let i = 1; i <= 10; i++) expect(out).not.toContain(`"data-${i}"`);
  });

  it('ignores a malformed sinceBatchId (falls back to full scan)', async () => {
    const out = await cap.invoke({ contextGraphId: CG_ID, offset: 0, limit: 5000, includeSharedMemory: false, phase: 'data', sinceBatchId: 'not-a-number' as unknown as string });
    for (let i = 1; i <= 10; i++) expect(out).toContain(`"data-${i}"`);
  });

  it('honors an UNTYPED batchId literal (legacy shape) in the delta comparison', async () => {
    // Legacy replicated data may carry batchId as a plain string literal, not
    // xsd:integer. A typed `>` comparison would error/skip it; the numeric
    // coercion must place it correctly relative to sinceBatchId.
    const kc = 'did:dkg:evm:31337/0xkcU';
    const ka = `${kc}/1`;
    const root = 'urn:root:U';
    await store.insert([
      { graph: PER_CG_META, subject: kc, predicate: RDF_TYPE, object: `${DKG_NS}KnowledgeCollection` },
      { graph: PER_CG_META, subject: kc, predicate: `${DKG_NS}batchId`, object: '"12"' },
      { graph: PER_CG_META, subject: ka, predicate: `${DKG_NS}partOf`, object: kc },
      { graph: PER_CG_META, subject: ka, predicate: `${DKG_NS}rootEntity`, object: root },
      { graph: PER_CG_DATA, subject: root, predicate: `${DKG_NS}label`, object: '"data-U"' },
    ]);
    const included = await cap.invoke({ contextGraphId: CG_ID, offset: 0, limit: 5000, includeSharedMemory: false, phase: 'data', sinceBatchId: '11' });
    expect(included).toContain('"data-U"');
    const excluded = await cap.invoke({ contextGraphId: CG_ID, offset: 0, limit: 5000, includeSharedMemory: false, phase: 'data', sinceBatchId: '12' });
    expect(excluded).not.toContain('"data-U"');
  });

  it('honors a legacy batchId placed directly on the KA (not the KC)', async () => {
    // Some legacy shapes attach `dkg:batchId` to the KA subject rather than its
    // owning KC; the join must accept either placement.
    const kc = 'did:dkg:evm:31337/0xkcK';
    const ka = `${kc}/1`;
    const root = 'urn:root:K';
    await store.insert([
      { graph: PER_CG_META, subject: kc, predicate: RDF_TYPE, object: `${DKG_NS}KnowledgeCollection` },
      { graph: PER_CG_META, subject: ka, predicate: `${DKG_NS}partOf`, object: kc },
      { graph: PER_CG_META, subject: ka, predicate: `${DKG_NS}rootEntity`, object: root },
      { graph: PER_CG_META, subject: ka, predicate: `${DKG_NS}batchId`, object: intLit(13) },
      { graph: PER_CG_DATA, subject: root, predicate: `${DKG_NS}label`, object: '"data-K"' },
    ]);
    const included = await cap.invoke({ contextGraphId: CG_ID, offset: 0, limit: 5000, includeSharedMemory: false, phase: 'data', sinceBatchId: '5' });
    expect(included).toContain('"data-K"');
    const excluded = await cap.invoke({ contextGraphId: CG_ID, offset: 0, limit: 5000, includeSharedMemory: false, phase: 'data', sinceBatchId: '13' });
    expect(excluded).not.toContain('"data-K"');
  });

  it('honors collapsed single-root KA metadata without dkg:partOf', async () => {
    const ual = 'did:dkg:evm:31337/0xcollapsed';
    const root = 'urn:root:collapsed';
    await store.insert([
      { graph: PER_CG_META, subject: ual, predicate: `${DKG_NS}rootEntity`, object: root },
      { graph: PER_CG_META, subject: ual, predicate: `${DKG_NS}batchId`, object: intLit(14) },
      { graph: PER_CG_DATA, subject: root, predicate: `${DKG_NS}label`, object: '"data-collapsed"' },
    ]);

    const included = await cap.invoke({ contextGraphId: CG_ID, offset: 0, limit: 5000, includeSharedMemory: false, phase: 'data', sinceBatchId: '13' });
    expect(included).toContain('"data-collapsed"');

    const excluded = await cap.invoke({ contextGraphId: CG_ID, offset: 0, limit: 5000, includeSharedMemory: false, phase: 'data', sinceBatchId: '14' });
    expect(excluded).not.toContain('"data-collapsed"');
  });

  it('does not let another CG reusing the same rootEntity IRI leak into the delta', async () => {
    // Regression: the KA→KC→batchId join must be scoped to THIS CG's meta
    // graphs. Pollute a DIFFERENT CG's per-cgId meta with the SAME rootEntity
    // (urn:root:8) bound to a KC with a high batchId (99). With since=8,
    // root:8's real batchId in mfacts is 8 (NOT > 8) so it must be excluded —
    // the foreign batchId 99 must NOT pull root:8's data back in.
    const OTHER_META = 'did:dkg:context-graph:other/context/1/_meta';
    await store.insert([
      { graph: OTHER_META, subject: 'did:dkg:evm:31337/0xother/1', predicate: `${DKG_NS}partOf`, object: 'did:dkg:evm:31337/0xother' },
      { graph: OTHER_META, subject: 'did:dkg:evm:31337/0xother/1', predicate: `${DKG_NS}rootEntity`, object: 'urn:root:8' },
      { graph: OTHER_META, subject: 'did:dkg:evm:31337/0xother', predicate: `${DKG_NS}batchId`, object: intLit(99) },
    ]);
    const out = await cap.invoke({ contextGraphId: CG_ID, offset: 0, limit: 5000, includeSharedMemory: false, phase: 'data', sinceBatchId: '8' });
    expect(out).not.toContain('"data-8"');
    expect(out).toContain('"data-9"');
    expect(out).toContain('"data-10"');
  });

  it('uses bounded store queries for caught-up delta pages', async () => {
    const extra = [] as { graph: string; subject: string; predicate: string; object: string }[];
    for (let i = 0; i < 80; i++) {
      const kc = `did:dkg:evm:31337/0xextra${i}`;
      const ka = `${kc}/1`;
      const root = `urn:extra:${i}`;
      extra.push(
        { graph: PER_CG_META, subject: kc, predicate: RDF_TYPE, object: `${DKG_NS}KnowledgeCollection` },
        { graph: PER_CG_META, subject: kc, predicate: `${DKG_NS}batchId`, object: intLit(i + 1) },
        { graph: PER_CG_META, subject: ka, predicate: `${DKG_NS}partOf`, object: kc },
        { graph: PER_CG_META, subject: ka, predicate: `${DKG_NS}rootEntity`, object: root },
        { graph: PER_CG_DATA, subject: root, predicate: `${DKG_NS}label`, object: `"extra-${i}"` },
      );
    }
    await store.insert(extra);

    const query = store.query.bind(store);
    let queryCount = 0;
    store.query = (async (...args: Parameters<typeof store.query>) => {
      queryCount += 1;
      return query(...args);
    }) as typeof store.query;

    const out = await cap.invoke({
      contextGraphId: CG_ID,
      offset: 0,
      limit: 5000,
      includeSharedMemory: false,
      phase: 'data',
      sinceBatchId: '999',
    });

    expect(out).not.toContain('"extra-');
    expect(queryCount).toBeLessThan(20);
  });
});
