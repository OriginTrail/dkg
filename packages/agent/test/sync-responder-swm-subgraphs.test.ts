import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';
import {
  filterSwmMetaSnapshotRows,
  type SyncRow,
} from '../src/sync/responder/graph-plan.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import type { OperationContext } from '@origintrail-official/dkg-core';

/**
 * Regression test for the SWM sub-graph blind spot in the sync responder.
 *
 * Pre-PR-X the workspace branch hardcoded the response to query
 * `contextGraphWorkspaceGraphUri(cgId)` / `...MetaGraphUri(cgId)`, both of
 * which alias the CG-root SWM URI:
 *   <cgPrefix>/_shared_memory
 *   <cgPrefix>/_shared_memory_meta
 *
 * Any publish that supplied a `subGraphName` lands in the per-sub-graph
 * variants instead:
 *   <cgPrefix>/<sub>/_shared_memory
 *   <cgPrefix>/<sub>/_shared_memory_meta
 *
 * The responder's static graph filter never saw those, so a sync requester
 * (e.g. a freshly approved late joiner running `runImmediatePostApprovalSync`
 * or any later `fetchSyncPages` round) received zero bytes of any sub-graph
 * SWM history. After PR-X the responder filters by URI shape under
 * `<cgPrefix>/`, so both root and sub-graph SWM flow through.
 *
 * See urn:dkg:finding:swm-gap-2-subgraph-blind-spot in the staking-ui-v10
 * decisions sub-graph for the full analysis.
 */

const CG_ID = 'devnet-test';
const CG_PREFIX = `did:dkg:context-graph:${CG_ID}`;
const ROOT_SWM = `${CG_PREFIX}/_shared_memory`;
const ROOT_SWM_META = `${CG_PREFIX}/_shared_memory_meta`;
const ROOT_SWM_DESCENDANT = `${ROOT_SWM}/0xabc/1`;
const ROOT_SWM_MALFORMED_DESCENDANT = `${ROOT_SWM}/0xabc/1/extra`;
const SUB_NAME = 'ai-tools';
const SUB_SWM = `${CG_PREFIX}/${SUB_NAME}/_shared_memory`;
const SUB_SWM_META = `${CG_PREFIX}/${SUB_NAME}/_shared_memory_meta`;
const OTHER_SUB = 'decisions';
const OTHER_SUB_SWM = `${CG_PREFIX}/${OTHER_SUB}/_shared_memory`;
const OTHER_SUB_SWM_META = `${CG_PREFIX}/${OTHER_SUB}/_shared_memory_meta`;

// A graph that lives at <cgPrefix>/<...>/_shared_memory_meta MUST NOT match
// the data-phase filter (STRENDS test on `_shared_memory` vs `_shared_memory_meta`
// is the structural guard). Conversely the meta-phase filter MUST match it.
// Per `validateSubGraphName` (dkg-core/constants.ts), sub-graph names cannot
// contain "/" and cannot start with "_", so there is no other URI shape that
// could land under `<cgPrefix>/.../_shared_memory[_meta]`.
const UNRELATED_DATA_GRAPH = `${CG_PREFIX}`;
const UNRELATED_DURABLE_META = `${CG_PREFIX}/_meta`;

const ROOT_ENTITY = 'urn:swm:root:r0';
const SUB_ROOT = 'urn:swm:root:s1';
const OTHER_SUB_ROOT = 'urn:swm:root:s2';
const SHARE_OP_ROOT = 'op-root-1';
const SHARE_OP_SUB = 'op-sub-1';
const SHARE_OP_OTHER_SUB = 'op-other-1';

const DKG_NS = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const REMOTE_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

const noopLog = (_ctx: OperationContext, _msg: string) => {};

describe('finalized SWM snapshot blocking', () => {
  it('blocks a marked head and its operation sibling by their shared lifecycle tuple', () => {
    const graph = 'did:dkg:context-graph:tuple-block/_shared_memory_meta';
    const ual = 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/7';
    const head = `${ual}#dkg-swm-head`;
    const operation = 'urn:dkg:share:tuple-block:operation-1';
    const unrelated = 'urn:dkg:share:tuple-block:unrelated';
    const tupleRows = (subject: string): SyncRow[] => [
      { g: graph, s: subject, p: `${DKG_NS}contentScopeVersion`, o: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' },
      { g: graph, s: subject, p: `${DKG_NS}kaUal`, o: ual },
      { g: graph, s: subject, p: `${DKG_NS}assertionVersion`, o: '"1"' },
      { g: graph, s: subject, p: `${DKG_NS}shareOperationId`, o: '"operation-1"' },
    ];
    const rows: SyncRow[] = [
      ...tupleRows(head),
      { g: graph, s: head, p: `${DKG_NS}finalizedSwmCleanupRoot`, o: '"sha256:abc"' },
      ...tupleRows(operation),
      { g: graph, s: unrelated, p: RDF_TYPE, o: `${DKG_NS}WorkspaceOperation` },
    ];

    const filtered = filterSwmMetaSnapshotRows(rows, null);

    expect(filtered.some((row) => row.s === head)).toBe(false);
    expect(filtered.some((row) => row.s === operation)).toBe(false);
    expect(filtered).toEqual([{
      g: graph,
      s: unrelated,
      p: RDF_TYPE,
      o: `${DKG_NS}WorkspaceOperation`,
    }]);
  });

  it('applies a valid freshness cutoff without a declaration-order failure', () => {
    const graph = 'did:dkg:context-graph:freshness/_shared_memory_meta';
    const subject = 'urn:dkg:share:freshness:operation-1';
    const rows: SyncRow[] = [{
      g: graph,
      s: subject,
      p: RDF_TYPE,
      o: `${DKG_NS}WorkspaceOperation`,
    }, {
      g: graph,
      s: subject,
      p: `${DKG_NS}publishedAt`,
      o: '"2026-07-31T09:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
    }];

    const filtered = filterSwmMetaSnapshotRows(
      rows,
      '2026-07-31T08:00:00.000Z',
    );
    expect(filtered).toHaveLength(2);
    expect(new Set(filtered.map((row) => row.p))).toEqual(new Set([
      RDF_TYPE,
      `${DKG_NS}publishedAt`,
    ]));
  });
});

function captureHandler(): {
  register: (proto: string, h: (data: Uint8Array, peerId: string) => Promise<Uint8Array>) => void;
  invoke: (envelope: SyncRequestEnvelope) => Promise<string>;
} {
  let captured: ((data: Uint8Array, peerId: string) => Promise<Uint8Array>) | null = null;
  return {
    register: (_proto, h) => {
      captured = h;
    },
    invoke: async (envelope) => {
      if (!captured) throw new Error('handler not registered');
      const bytes = new TextEncoder().encode(JSON.stringify(envelope));
      const out = await captured(bytes, REMOTE_PEER_ID);
      return new TextDecoder().decode(out);
    },
  };
}

function lineGraphsFromNquads(text: string): Set<string> {
  const graphs = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/<([^<>]+)>\s*\.\s*$/);
    if (m) graphs.add(m[1]);
  }
  return graphs;
}

function workspaceOpQuads(opId: string, rootEntity: string, metaGraph: string, publishedAt: string) {
  const subject = `urn:dkg:share:${CG_ID}:${opId}`;
  return [
    { graph: metaGraph, subject, predicate: RDF_TYPE, object: `${DKG_NS}WorkspaceOperation` },
    { graph: metaGraph, subject, predicate: `${DKG_NS}publishedAt`, object: `"${publishedAt}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` },
    { graph: metaGraph, subject, predicate: `${DKG_NS}rootEntity`, object: rootEntity },
    { graph: metaGraph, subject, predicate: `${DKG_NS}contextGraphId`, object: `"${CG_ID}"` },
    { graph: metaGraph, subject, predicate: `${DKG_NS}shareOperationId`, object: `"${opId}"` },
  ];
}

// Sub-graph registration triples in `<cgPrefix>/_meta`. Mirrors the
// shape that `DKGPublisher.isSubGraphRegistered` (dkg-publisher.ts:3828)
// looks for and `FinalizationHandler.ensureContextGraphAndSubGraph`
// (finalization-handler.ts:540) writes. The sync responder's boundary
// check (post-#885 Codex) requires this registration to admit the
// sub-graph SWM into a sync response, disambiguating it from a nested
// CG that shares the same URI prefix.
function subGraphRegistrationQuads(cgId: string, subGraphName: string) {
  const cgMeta = `did:dkg:context-graph:${cgId}/_meta`;
  const sgUri = `did:dkg:context-graph:${cgId}/${subGraphName}`;
  return [
    { graph: cgMeta, subject: sgUri, predicate: RDF_TYPE, object: `${DKG_NS}SubGraph` },
    { graph: cgMeta, subject: sgUri, predicate: 'http://schema.org/name', object: `"${subGraphName}"` },
    { graph: cgMeta, subject: sgUri, predicate: `${DKG_NS}createdBy`, object: '"test-creator"' },
  ];
}

describe('sync responder workspace branch — sub-graph SWM coverage', () => {
  let store: OxigraphStore;
  let cap: ReturnType<typeof captureHandler>;

  beforeEach(async () => {
    store = new OxigraphStore();

    const NOW_ISO = '2026-06-01T00:00:00.000Z';

    await store.insert([
      // --- ROOT SWM ---
      // root-entity payload + a skolemized child (the FILTER in the TTL
      // branch widens past the root URI to genid descendants).
      { graph: ROOT_SWM, subject: ROOT_ENTITY, predicate: 'http://schema.org/name', object: '"root-payload"' },
      { graph: ROOT_SWM, subject: `${ROOT_ENTITY}/.well-known/genid/abc`, predicate: 'http://schema.org/value', object: '"root-child"' },
      { graph: ROOT_SWM_DESCENDANT, subject: ROOT_ENTITY, predicate: 'http://schema.org/description', object: '"root-promoted-descendant"' },
      { graph: ROOT_SWM_MALFORMED_DESCENDANT, subject: ROOT_ENTITY, predicate: 'http://schema.org/description', object: '"malformed-descendant-leak"' },
      ...workspaceOpQuads(SHARE_OP_ROOT, ROOT_ENTITY, ROOT_SWM_META, NOW_ISO),

      // --- SUB-GRAPH SWM (the gap target) ---
      { graph: SUB_SWM, subject: SUB_ROOT, predicate: 'http://schema.org/name', object: '"sub-ai-tools-payload"' },
      ...workspaceOpQuads(SHARE_OP_SUB, SUB_ROOT, SUB_SWM_META, NOW_ISO),
      ...subGraphRegistrationQuads(CG_ID, SUB_NAME),

      // --- ANOTHER SUB-GRAPH (covers fan-out across multiple subs) ---
      { graph: OTHER_SUB_SWM, subject: OTHER_SUB_ROOT, predicate: 'http://schema.org/name', object: '"sub-decisions-payload"' },
      ...workspaceOpQuads(SHARE_OP_OTHER_SUB, OTHER_SUB_ROOT, OTHER_SUB_SWM_META, NOW_ISO),
      ...subGraphRegistrationQuads(CG_ID, OTHER_SUB),

      // --- NOISE: durable-tier graphs that share the CG prefix but are
      //     not SWM. The shape filter must exclude these from BOTH the
      //     workspace meta and data phases.
      { graph: UNRELATED_DATA_GRAPH, subject: 'urn:durable:1', predicate: `${DKG_NS}label`, object: '"durable"' },
      { graph: UNRELATED_DURABLE_META, subject: CG_PREFIX, predicate: `${DKG_NS}createdAt`, object: '"2026-05-10T00:00:00Z"' },
    ]);

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

  describe('phase=data (no TTL)', () => {
    it('returns root SWM AND every sub-graph SWM in one response', async () => {
      const out = await cap.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'data',
      });

      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(ROOT_SWM)).toBe(true);
      expect(graphs.has(ROOT_SWM_DESCENDANT)).toBe(true);
      expect(graphs.has(ROOT_SWM_MALFORMED_DESCENDANT)).toBe(false);
      expect(graphs.has(SUB_SWM)).toBe(true);
      expect(graphs.has(OTHER_SUB_SWM)).toBe(true);

      // Spot-check the actual payloads landed.
      expect(out).toContain('"root-payload"');
      expect(out).toContain('"sub-ai-tools-payload"');
      expect(out).toContain('"sub-decisions-payload"');
      expect(out).toContain('"root-child"');
      expect(out).toContain('"root-promoted-descendant"');
      expect(out).not.toContain('"malformed-descendant-leak"');
    });

    it('does NOT return SWM meta graphs (those are the meta phase)', async () => {
      const out = await cap.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'data',
      });

      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(ROOT_SWM_META)).toBe(false);
      expect(graphs.has(SUB_SWM_META)).toBe(false);
      expect(graphs.has(OTHER_SUB_SWM_META)).toBe(false);
    });

    it('does NOT bleed durable-tier graphs into the workspace data response', async () => {
      const out = await cap.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'data',
      });

      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(UNRELATED_DATA_GRAPH)).toBe(false);
      expect(graphs.has(UNRELATED_DURABLE_META)).toBe(false);
      expect(out).not.toContain('"durable"');
    });
  });

  describe('phase=meta (no TTL)', () => {
    it('returns root SWM meta AND every sub-graph SWM meta', async () => {
      const out = await cap.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'meta',
      });

      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(ROOT_SWM_META)).toBe(true);
      expect(graphs.has(SUB_SWM_META)).toBe(true);
      expect(graphs.has(OTHER_SUB_SWM_META)).toBe(true);

      // Spot-check that each WorkspaceOperation rode along.
      expect(out).toContain(`urn:dkg:share:${CG_ID}:${SHARE_OP_ROOT}`);
      expect(out).toContain(`urn:dkg:share:${CG_ID}:${SHARE_OP_SUB}`);
      expect(out).toContain(`urn:dkg:share:${CG_ID}:${SHARE_OP_OTHER_SUB}`);
    });

    it('does NOT return SWM data graphs (those are the data phase)', async () => {
      const out = await cap.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'meta',
      });

      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(ROOT_SWM)).toBe(false);
      expect(graphs.has(SUB_SWM)).toBe(false);
      expect(graphs.has(OTHER_SUB_SWM)).toBe(false);
    });

    it('does NOT include durable top-level _meta registration rows', async () => {
      const out = await cap.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'meta',
      });

      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(UNRELATED_DURABLE_META)).toBe(false);
      expect(out).not.toContain(`${DKG_NS}SubGraph`);
      expect(out).not.toContain('http://schema.org/name');
      expect(out).not.toContain(`${DKG_NS}createdAt`);
      expect(out).not.toContain('"2026-05-10T00:00:00Z"');
    });
  });

  describe('phase=data (TTL on)', () => {
    let storeTtl: OxigraphStore;
    let capTtl: ReturnType<typeof captureHandler>;

    beforeEach(async () => {
      // Two ops per graph: one fresh (within cutoff), one stale (older
      // than cutoff). The TTL branch must keep the fresh root/sub
      // entities and drop the stale ones — even though the stale ones
      // physically still live in the store. Verifies both:
      //   (a) the (?gMeta = ?g + "_meta") binding correctly pairs the
      //       per-sub-graph op graph with its data graph, and
      //   (b) the ?ts >= cutoff filter is applied per sub-graph.
      storeTtl = new OxigraphStore();
      const FRESH_ISO = new Date(Date.now() - 1_000).toISOString();
      const STALE_ISO = new Date(Date.now() - 10_000).toISOString();

      await storeTtl.insert([
        // root: fresh entity (kept), stale entity (dropped)
        { graph: ROOT_SWM, subject: 'urn:swm:fresh:root', predicate: 'http://schema.org/n', object: '"fresh-root"' },
        { graph: ROOT_SWM, subject: 'urn:swm:stale:root', predicate: 'http://schema.org/n', object: '"stale-root"' },
        ...workspaceOpQuads('op-fresh-root', 'urn:swm:fresh:root', ROOT_SWM_META, FRESH_ISO),
        ...workspaceOpQuads('op-stale-root', 'urn:swm:stale:root', ROOT_SWM_META, STALE_ISO),

        // sub: fresh entity (kept), stale entity (dropped)
        { graph: SUB_SWM, subject: 'urn:swm:fresh:sub', predicate: 'http://schema.org/n', object: '"fresh-sub"' },
        { graph: SUB_SWM, subject: 'urn:swm:stale:sub', predicate: 'http://schema.org/n', object: '"stale-sub"' },
        ...workspaceOpQuads('op-fresh-sub', 'urn:swm:fresh:sub', SUB_SWM_META, FRESH_ISO),
        ...workspaceOpQuads('op-stale-sub', 'urn:swm:stale:sub', SUB_SWM_META, STALE_ISO),
        ...subGraphRegistrationQuads(CG_ID, SUB_NAME),
      ]);

      capTtl = captureHandler();
      registerSyncHandler({
        register: capTtl.register,
        protocolSync: '/origintrail/dkg/sync/1.0.0',
        syncDeniedResponse: 'sync-denied',
        syncPageSize: 5000,
        sharedMemoryTtlMs: 5_000,
        store: storeTtl,
        peerId: 'self-peer',
        parseSyncRequest: (data) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
        authorizeSyncRequest: async () => true,
        logWarn: noopLog,
        logDebug: noopLog,
      });
    });

    it('keeps fresh root + sub entities and drops stale ones, scoped by sub-graph', async () => {
      const out = await capTtl.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'data',
      });

      expect(out).toContain('"fresh-root"');
      expect(out).toContain('"fresh-sub"');
      expect(out).not.toContain('"stale-root"');
      expect(out).not.toContain('"stale-sub"');

      // Both sub-graph variants of `_shared_memory` MUST appear in the
      // graph-id position of the emitted nquads — the regression target.
      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(ROOT_SWM)).toBe(true);
      expect(graphs.has(SUB_SWM)).toBe(true);
    });
  });

  describe('phase=meta (TTL on, graph-scoped heads)', () => {
    it('serves an untimestamped rootless head when its selected operation is fresh', async () => {
      const storeTtl = new OxigraphStore();
      const freshIso = new Date(Date.now() - 1_000).toISOString();
      const staleIso = new Date(Date.now() - 10_000).toISOString();
      const freshUal = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/7';
      const staleUal = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/8';
      const graphScopedRows = (ual: string, opId: string, timestamp: string) => {
        const op = `urn:dkg:share:${CG_ID}:${opId}`;
        const head = `${ual}#dkg-swm-head`;
        return [
          { graph: ROOT_SWM_META, subject: op, predicate: RDF_TYPE, object: `${DKG_NS}WorkspaceOperation` },
          { graph: ROOT_SWM_META, subject: op, predicate: `${DKG_NS}publishedAt`, object: `"${timestamp}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` },
          { graph: ROOT_SWM_META, subject: op, predicate: `${DKG_NS}shareOperationId`, object: `"${opId}"` },
          { graph: ROOT_SWM_META, subject: op, predicate: `${DKG_NS}contentScopeVersion`, object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' },
          { graph: ROOT_SWM_META, subject: op, predicate: `${DKG_NS}kaUal`, object: ual },
          { graph: ROOT_SWM_META, subject: op, predicate: `${DKG_NS}assertionVersion`, object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>' },
          { graph: ROOT_SWM_META, subject: head, predicate: `${DKG_NS}contentScopeVersion`, object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' },
          { graph: ROOT_SWM_META, subject: head, predicate: `${DKG_NS}kaUal`, object: ual },
          { graph: ROOT_SWM_META, subject: head, predicate: `${DKG_NS}assertionVersion`, object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>' },
          { graph: ROOT_SWM_META, subject: head, predicate: `${DKG_NS}shareOperationId`, object: `"${opId}"` },
          { graph: ROOT_SWM_META, subject: head, predicate: `${DKG_NS}assertionGraph`, object: `${ROOT_SWM}/0x00000000000000000000000000000000000000ab/${ual.endsWith('/7') ? '7' : '8'}` },
        ];
      };
      await storeTtl.insert([
        ...graphScopedRows(freshUal, 'fresh-rootless', freshIso),
        ...graphScopedRows(staleUal, 'stale-rootless', staleIso),
      ]);
      const capTtl = captureHandler();
      registerSyncHandler({
        register: capTtl.register,
        protocolSync: '/origintrail/dkg/sync/1.0.0',
        syncDeniedResponse: 'sync-denied',
        syncPageSize: 5000,
        sharedMemoryTtlMs: 5_000,
        store: storeTtl,
        peerId: 'self-peer',
        parseSyncRequest: (data) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
        authorizeSyncRequest: async () => true,
        logWarn: noopLog,
        logDebug: noopLog,
      });

      const out = await capTtl.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'meta',
      });

      expect(out).toContain(`${freshUal}#dkg-swm-head`);
      expect(out).toContain('urn:dkg:share:devnet-test:fresh-rootless');
      expect(out).not.toContain(`${staleUal}#dkg-swm-head`);
      expect(out).not.toContain('urn:dkg:share:devnet-test:stale-rootless');
      await storeTtl.close();
    });

    it.each([0, 5_000])(
      'does not advertise finalized SWM marked for deferred cleanup (ttl=%s)',
      async (sharedMemoryTtlMs) => {
        const markedStore = new OxigraphStore();
        const publishedAt = new Date(Date.now() - 1_000).toISOString();
        const ual = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/9';
        const opId = 'finalized-deferred-cleanup';
        const op = `urn:dkg:share:${CG_ID}:${opId}`;
        const head = `${ual}#dkg-swm-head`;
        const assertionGraph = `${ROOT_SWM}/0x00000000000000000000000000000000000000ab/9`;
        const markedEntity = 'urn:swm:finalized:must-not-sync';
        const unmarkedGraph = `${ROOT_SWM}/0x00000000000000000000000000000000000000ac/10`;
        const unmarkedRoot = 'urn:swm:unmarked:must-sync';
        const unmarkedOp = `urn:dkg:share:${CG_ID}:unmarked-data`;
        const tupleRows = (subject: string) => [
          { graph: ROOT_SWM_META, subject, predicate: `${DKG_NS}contentScopeVersion`, object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' },
          { graph: ROOT_SWM_META, subject, predicate: `${DKG_NS}kaUal`, object: ual },
          { graph: ROOT_SWM_META, subject, predicate: `${DKG_NS}assertionVersion`, object: '"9"^^<http://www.w3.org/2001/XMLSchema#integer>' },
          { graph: ROOT_SWM_META, subject, predicate: `${DKG_NS}shareOperationId`, object: `"${opId}"` },
        ];
        await markedStore.insert([
          { graph: ROOT_SWM_META, subject: op, predicate: RDF_TYPE, object: `${DKG_NS}WorkspaceOperation` },
          { graph: ROOT_SWM_META, subject: op, predicate: `${DKG_NS}publishedAt`, object: `"${publishedAt}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` },
          ...tupleRows(op),
          ...tupleRows(head),
          { graph: ROOT_SWM_META, subject: head, predicate: `${DKG_NS}assertionGraph`, object: assertionGraph },
          { graph: ROOT_SWM_META, subject: head, predicate: `${DKG_NS}finalizedSwmCleanupRoot`, object: `"0x${'ab'.repeat(32)}"` },
          { graph: assertionGraph, subject: markedEntity, predicate: 'http://schema.org/name', object: '"finalized-copy"' },
          { graph: unmarkedGraph, subject: unmarkedRoot, predicate: 'http://schema.org/name', object: '"live-copy"' },
          { graph: ROOT_SWM_META, subject: unmarkedOp, predicate: RDF_TYPE, object: `${DKG_NS}WorkspaceOperation` },
          { graph: ROOT_SWM_META, subject: unmarkedOp, predicate: `${DKG_NS}publishedAt`, object: `"${publishedAt}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` },
          { graph: ROOT_SWM_META, subject: unmarkedOp, predicate: `${DKG_NS}rootEntity`, object: unmarkedRoot },
        ]);
        const markedCap = captureHandler();
        registerSyncHandler({
          register: markedCap.register,
          protocolSync: '/origintrail/dkg/sync/1.0.0',
          syncDeniedResponse: 'sync-denied',
          syncPageSize: 5000,
          sharedMemoryTtlMs,
          store: markedStore,
          peerId: 'self-peer',
          parseSyncRequest: (data) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
          authorizeSyncRequest: async () => true,
          logWarn: noopLog,
          logDebug: noopLog,
        });

        const out = await markedCap.invoke({
          contextGraphId: CG_ID,
          offset: 0,
          limit: 5000,
          includeSharedMemory: true,
          phase: 'meta',
        });

        expect(out).not.toContain(head);
        expect(out).not.toContain(op);
        expect(out).not.toContain('finalizedSwmCleanupRoot');

        const dataOut = await markedCap.invoke({
          contextGraphId: CG_ID,
          syncSessionId: `finalized-cleanup-data-${sharedMemoryTtlMs}`,
          offset: 0,
          limit: 5000,
          includeSharedMemory: true,
          phase: 'data',
        });
        expect(dataOut).not.toContain(markedEntity);
        expect(dataOut).not.toContain('"finalized-copy"');
        expect(dataOut).toContain(unmarkedRoot);
        expect(dataOut).toContain('"live-copy"');

        // After idle cleanup removes the active head, the immutable operation
        // keeps the marker for recovery but must remain outside sync.
        await markedStore.deleteByPattern({
          graph: ROOT_SWM_META,
          subject: head,
        });
        await markedStore.insert([{
          graph: ROOT_SWM_META,
          subject: op,
          predicate: `${DKG_NS}finalizedSwmCleanupRoot`,
          object: `"0x${'ab'.repeat(32)}"`,
        }]);
        const afterCleanup = await markedCap.invoke({
          contextGraphId: CG_ID,
          syncSessionId: `finalized-cleanup-drained-${sharedMemoryTtlMs}`,
          offset: 0,
          limit: 5000,
          includeSharedMemory: true,
          phase: 'meta',
        });
        expect(afterCleanup).not.toContain(op);
        expect(afterCleanup).not.toContain('finalizedSwmCleanupRoot');
        await markedStore.close();
      },
    );
  });

  // Codex review on #885 — URI shape alone is NOT a sufficient CG
  // boundary because `validateContextGraphId` permits `/` in the CG
  // ID (wallet-scoped IDs do, e.g. `0xabc/project`). For a request on
  // `cg-A`, the URI `<cgPrefix>/child/_shared_memory` is structurally
  // indistinguishable from a sub-graph "child" of cg-A AND from the
  // root SWM of a different CG `cg-A/child` — even with a tightened
  // STRBEFORE/STRAFTER segment check that allows exactly one path
  // segment.
  //
  // The fix: admit the CG's root SWM unconditionally and admit a
  // sub-graph SWM only if the sub-graph is REGISTERED in this CG's
  // `<cgPrefix>/_meta` graph (via the `<sgUri> a SubGraph; schema:name
  // "<name>"` triples that `DKGPublisher.isSubGraphRegistered` looks
  // for). The nested CG `cg-A/child` puts its registration in its
  // OWN `<cg-A/child-prefix>/_meta` graph, not cg-A's, so it is
  // naturally excluded. This test pins that contract: with no
  // registration of "child" or "child/extra" in cg-A's `_meta`, the
  // nested-CG SWM data and meta MUST NOT leak into a sync of cg-A.
  describe('CG boundary tightening — nested CGs sharing a prefix do not leak (#885 Codex)', () => {
    const NESTED_CG_ID = `${CG_ID}/child`;
    const NESTED_PREFIX = `did:dkg:context-graph:${NESTED_CG_ID}`;
    const NESTED_META = `${NESTED_PREFIX}/_meta`;
    const NESTED_ROOT_SWM = `${NESTED_PREFIX}/_shared_memory`;
    const NESTED_ROOT_SWM_META = `${NESTED_PREFIX}/_shared_memory_meta`;
    const NESTED_SUB_SWM = `${NESTED_PREFIX}/extra/_shared_memory`;
    const NESTED_SUB_SWM_META = `${NESTED_PREFIX}/extra/_shared_memory_meta`;

    let storeNested: OxigraphStore;
    let capNested: ReturnType<typeof captureHandler>;

    beforeEach(async () => {
      storeNested = new OxigraphStore();
      const NOW_ISO = '2026-06-01T00:00:00.000Z';
      await storeNested.insert([
        // The CG we are syncing.
        { graph: ROOT_SWM, subject: ROOT_ENTITY, predicate: 'http://schema.org/n', object: '"keep-me-root"' },
        ...workspaceOpQuads(SHARE_OP_ROOT, ROOT_ENTITY, ROOT_SWM_META, NOW_ISO),
        // A DIFFERENT CG whose ID extends the queried CG's prefix —
        // pre-fix, this leaked because the prefix filter matched it.
        { graph: NESTED_ROOT_SWM, subject: 'urn:nested:root', predicate: 'http://schema.org/n', object: '"NESTED-ROOT-LEAK"' },
        { graph: NESTED_ROOT_SWM_META, subject: 'urn:dkg:share:nested-root-op', predicate: RDF_TYPE, object: `${DKG_NS}WorkspaceOperation` },
        { graph: NESTED_ROOT_SWM_META, subject: 'urn:dkg:share:nested-root-op', predicate: `${DKG_NS}publishedAt`, object: `"${NOW_ISO}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` },
        { graph: NESTED_ROOT_SWM_META, subject: 'urn:dkg:share:nested-root-op', predicate: `${DKG_NS}rootEntity`, object: 'urn:nested:root' },
        // Sub-graph of the OTHER CG — also must not leak.
        { graph: NESTED_SUB_SWM, subject: 'urn:nested:sub', predicate: 'http://schema.org/n', object: '"NESTED-SUB-LEAK"' },
        { graph: NESTED_SUB_SWM_META, subject: 'urn:dkg:share:nested-sub-op', predicate: RDF_TYPE, object: `${DKG_NS}WorkspaceOperation` },
        { graph: NESTED_SUB_SWM_META, subject: 'urn:dkg:share:nested-sub-op', predicate: `${DKG_NS}publishedAt`, object: `"${NOW_ISO}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` },
        { graph: NESTED_SUB_SWM_META, subject: 'urn:dkg:share:nested-sub-op', predicate: `${DKG_NS}rootEntity`, object: 'urn:nested:sub' },
      ]);
      capNested = captureHandler();
      registerSyncHandler({
        register: capNested.register,
        protocolSync: '/origintrail/dkg/sync/1.0.0',
        syncDeniedResponse: 'sync-denied',
        syncPageSize: 5000,
        sharedMemoryTtlMs: 0,
        store: storeNested,
        peerId: 'self-peer',
        parseSyncRequest: (data) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
        authorizeSyncRequest: async () => true,
        logWarn: noopLog,
        logDebug: noopLog,
      });
    });

    it('phase=data: nested-CG SWM (root and sub-graph) must NOT leak into a sync of the parent CG', async () => {
      const out = await capNested.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'data',
      });

      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(ROOT_SWM)).toBe(true);
      // The pre-fix regression: NESTED_ROOT_SWM and NESTED_SUB_SWM
      // would both have appeared because their URIs start with the
      // queried CG prefix. The tightened FILTER rejects them.
      expect(graphs.has(NESTED_ROOT_SWM)).toBe(false);
      expect(graphs.has(NESTED_SUB_SWM)).toBe(false);
      expect(out).not.toContain('"NESTED-ROOT-LEAK"');
      expect(out).not.toContain('"NESTED-SUB-LEAK"');
      expect(out).toContain('"keep-me-root"');
    });

    it('phase=meta: nested-CG SWM meta must NOT leak into a sync of the parent CG', async () => {
      const out = await capNested.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'meta',
      });

      const graphs = lineGraphsFromNquads(out);
      expect(graphs.has(ROOT_SWM_META)).toBe(true);
      expect(graphs.has(NESTED_ROOT_SWM_META)).toBe(false);
      expect(graphs.has(NESTED_SUB_SWM_META)).toBe(false);
    });

    it('rejects a parent sub-graph candidate when the same URI is a known child CG', async () => {
      const storeCollision = new OxigraphStore();
      const capCollision = captureHandler();
      const NOW_ISO = '2026-06-01T00:00:00.000Z';

      await storeCollision.insert([
        { graph: ROOT_SWM, subject: ROOT_ENTITY, predicate: 'http://schema.org/n', object: '"keep-me-root"' },
        ...workspaceOpQuads(SHARE_OP_ROOT, ROOT_ENTITY, ROOT_SWM_META, NOW_ISO),

        // Parent CG registers a sub-graph named "child". That makes the
        // graph URI below look valid as parent sub-graph SWM.
        ...subGraphRegistrationQuads(CG_ID, 'child'),

        // The same URI is also the root SWM graph for a known child CG
        // `${CG_ID}/child`. The responder must reject this ambiguous
        // partition during a sync of the parent CG, matching
        // dkg-query-engine's known-child-CG exclusion.
        { graph: NESTED_META, subject: NESTED_PREFIX, predicate: RDF_TYPE, object: 'https://dkg.network/ontology#ContextGraph' },
        { graph: NESTED_ROOT_SWM, subject: 'urn:nested:root', predicate: 'http://schema.org/n', object: '"NESTED-COLLISION-LEAK"' },
        { graph: NESTED_ROOT_SWM_META, subject: 'urn:dkg:share:nested-root-op', predicate: RDF_TYPE, object: `${DKG_NS}WorkspaceOperation` },
        { graph: NESTED_ROOT_SWM_META, subject: 'urn:dkg:share:nested-root-op', predicate: `${DKG_NS}publishedAt`, object: `"${NOW_ISO}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` },
        { graph: NESTED_ROOT_SWM_META, subject: 'urn:dkg:share:nested-root-op', predicate: `${DKG_NS}rootEntity`, object: 'urn:nested:root' },
      ]);

      registerSyncHandler({
        register: capCollision.register,
        protocolSync: '/origintrail/dkg/sync/1.0.0',
        syncDeniedResponse: 'sync-denied',
        syncPageSize: 5000,
        sharedMemoryTtlMs: 0,
        store: storeCollision,
        peerId: 'self-peer',
        parseSyncRequest: (data) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
        authorizeSyncRequest: async () => true,
        logWarn: noopLog,
        logDebug: noopLog,
      });

      const dataOut = await capCollision.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'data',
      });
      const dataGraphs = lineGraphsFromNquads(dataOut);
      expect(dataGraphs.has(ROOT_SWM)).toBe(true);
      expect(dataGraphs.has(NESTED_ROOT_SWM)).toBe(false);
      expect(dataOut).toContain('"keep-me-root"');
      expect(dataOut).not.toContain('"NESTED-COLLISION-LEAK"');

      const metaOut = await capCollision.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'meta',
      });
      const metaGraphs = lineGraphsFromNquads(metaOut);
      expect(metaGraphs.has(ROOT_SWM_META)).toBe(true);
      expect(metaGraphs.has(NESTED_ROOT_SWM_META)).toBe(false);
    });
  });

  describe('graph URI is emitted per binding (not the static wsGraph alias)', () => {
    it('serializes each n-quad with the source graph URI, so a sub-graph entity lands back in the sub-graph on the requester', async () => {
      const out = await cap.invoke({
        contextGraphId: CG_ID,
        offset: 0,
        limit: 5000,
        includeSharedMemory: true,
        phase: 'data',
      });

      // Every line ending in <SUB_SWM> . MUST carry a sub-graph subject,
      // never a root subject (and vice versa). This guards against the
      // pre-fix bug where the responder serialized everything as
      // `<root_swm> .` regardless of where it came from.
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        if (line.endsWith(`<${SUB_SWM}> .`)) {
          expect(line).toContain(SUB_ROOT);
        }
        if (line.endsWith(`<${OTHER_SUB_SWM}> .`)) {
          expect(line).toContain(OTHER_SUB_ROOT);
        }
        if (line.endsWith(`<${ROOT_SWM}> .`)) {
          expect(line).toContain(ROOT_ENTITY);
        }
      }
    });
  });
});
