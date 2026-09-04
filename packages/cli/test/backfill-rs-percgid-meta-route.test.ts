import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { requestAuthentication } from './_helpers/request-authentication.js';

/**
 * Endpoint test for `POST /api/random-sampling/backfill-percgid-meta`.
 *
 * The endpoint reads the canonical `<cgName>/_meta` graph, picks the
 * per-KC subset (`generateKCMetadata` shape from
 * `packages/publisher/src/metadata.ts`):
 *
 *   - KC UAL subjects (`dkg:batchId` + many siblings).
 *   - KA UAL subjects (`<UAL/tokenId>`; carry `dkg:partOf <KC>`).
 *
 * RFC ka-metadata-trim Phase 1: the third arm that copied Publication
 * URIs (`urn:dkg:publication:<opId>`) was removed together with the
 * `dkg:Publication` writer — old-store publication nodes are no longer
 * copied (zero readers).
 *
 * Per-KC granularity is the headline contract: each KC is gated by an
 * independent `FILTER NOT EXISTS` against the target graph, so a
 * mixed-state CG (some pre-fix KCs orphaned at `<cg>/_meta`, some
 * post-fix KCs already in the per-cgId graph) gets only the missing
 * KCs copied. Earlier revisions of this endpoint short-circuited on
 * "any triple in target" — Codex review on PR #763 pointed out that
 * this would silently skip the rescue on every CG that received even
 * a single post-fix publish.
 */

const { handleStatusRoutes } = await import('../src/daemon/routes/status.js');

type KcEntry = {
  ual: string;
  batchId: number;
  rootEntity: string;
  tokenId: number;
  /** When set, emit a LEGACY (pre-trim) `dkg:Publication` node +
   *  `<KA> dkg:publication <pubUri>` link, simulating rows written by
   *  older nodes. The current writer no longer emits these. */
  publication?: { opId: string; author: string; merkleRootHex: string };
};

type CGEntry = {
  name: string;
  onChainId: string;
  kcEntries?: KcEntry[];
  cgLifecycleSubject?: { subject: string; predicate: string; object: string };
};

const DKG_NS = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * How many quads `seedCanonicalMeta` emits for one KC. Exposed so
 * counting assertions in the tests stay readable.
 *   3 KC triples (batchId, kaCount, status)
 * + 3 KA triples (partOf, rootEntity, tokenId)
 * + 1 KA→pub link (when legacy `publication` set)
 * + 5 publication triples (when legacy `publication` set)
 *
 * NB: this counts what the legacy-shape FIXTURE writes into source.
 * Since RFC ka-metadata-trim the backfill route copies only the KC/KA
 * subjects — the publication NODE's 5 triples are not copied (the
 * KA→pub link rides along: it sits on the KA subject).
 */
function tripleCountForKc(kc: KcEntry): number {
  return 6 + (kc.publication ? 1 + 5 : 0);
}

/** What the trimmed backfill route actually copies for one KC. */
function copiedTripleCountForKc(kc: KcEntry): number {
  return 6 + (kc.publication ? 1 : 0);
}

async function seedCanonicalMeta(store: OxigraphStore, cg: CGEntry, graphOverride?: string): Promise<void> {
  if (!cg.kcEntries && !cg.cgLifecycleSubject) return;
  const metaGraph = graphOverride ?? `did:dkg:context-graph:${cg.name}/_meta`;
  const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];
  for (const kc of cg.kcEntries ?? []) {
    const kaUri = `${kc.ual}/${kc.tokenId}`;
    quads.push(
      { subject: kc.ual, predicate: `${DKG_NS}batchId`, object: `"${kc.batchId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: metaGraph },
      { subject: kc.ual, predicate: `${DKG_NS}kaCount`, object: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: metaGraph },
      { subject: kc.ual, predicate: `${DKG_NS}status`, object: '"confirmed"', graph: metaGraph },
      { subject: kaUri, predicate: `${DKG_NS}partOf`, object: kc.ual, graph: metaGraph },
      { subject: kaUri, predicate: `${DKG_NS}rootEntity`, object: kc.rootEntity, graph: metaGraph },
      { subject: kaUri, predicate: `${DKG_NS}tokenId`, object: `"${kc.tokenId}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: metaGraph },
    );
    if (kc.publication) {
      const pubUri = `urn:dkg:publication:${kc.publication.opId}`;
      quads.push(
        { subject: kaUri, predicate: `${DKG_NS}publication`, object: pubUri, graph: metaGraph },
        { subject: pubUri, predicate: RDF_TYPE, object: `${DKG_NS}Publication`, graph: metaGraph },
        { subject: pubUri, predicate: `${DKG_NS}publishOperationId`, object: `"${kc.publication.opId}"`, graph: metaGraph },
        { subject: pubUri, predicate: `${DKG_NS}contextGraphId`, object: `"${cg.name}"`, graph: metaGraph },
        { subject: pubUri, predicate: `${DKG_NS}merkleRoot`, object: `"${kc.publication.merkleRootHex}"^^<http://www.w3.org/2001/XMLSchema#hexBinary>`, graph: metaGraph },
        { subject: pubUri, predicate: `${DKG_NS}authoredBy`, object: `"${kc.publication.author}"`, graph: metaGraph },
      );
    }
  }
  if (cg.cgLifecycleSubject) {
    quads.push({ ...cg.cgLifecycleSubject, graph: metaGraph });
  }
  await store.insert(quads);
}

function makeAgentMock(opts: { store: OxigraphStore; cgs: Array<{ name: string; onChainId?: string }> }) {
  const subscribed = new Map<string, { subscribed: boolean; synced: boolean; onChainId?: string }>();
  for (const c of opts.cgs) {
    subscribed.set(c.name, { subscribed: true, synced: true, onChainId: c.onChainId });
  }
  return {
    peerId: '12D3KooBackfillTest',
    multiaddrs: [],
    node: { libp2p: { getConnections: () => [] } },
    publisher: { getIdentityId: () => 0n },
    store: opts.store,
    getSubscribedContextGraphs: () => subscribed,
    getRandomSamplingStatus: () => ({ enabled: false, role: 'edge' }),
  };
}

function makeCtx(path: string, agent: ReturnType<typeof makeAgentMock>) {
  const url = new URL(path, 'http://127.0.0.1');
  return {
    agent,
    publisherControl: {},
    publisherRuntime: null,
    config: {
      name: 'backfill-test',
      nodeRole: 'core',
      chain: { type: 'evm', rpcUrl: 'https://test.example/rpc', hubAddress: '0x0000000000000000000000000000000000000001', chainId: 'hardhat:31337' },
    },
    startedAt: Date.now() - 1000,
    dashDb: {},
    opWallets: { wallets: [] },
    network: null,
    tracker: {},
    memoryManager: {},
    bridgeAuthToken: undefined,
    nodeVersion: 'test',
    nodeCommit: 'abc123',
    catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
    extractionRegistry: {},
    fileStore: {},
    extractionStatus: new Map(),
    assertionImportLocks: new Map(),
    vectorStore: {},
    embeddingProvider: null,
    validTokens: new Set(),
    apiHost: '127.0.0.1',
    apiPortRef: { value: 0 },
    url,
    path: url.pathname,
    authentication: requestAuthentication({ kind: 'anonymous' }),
    requestAgentAddress: 'did:dkg:agent:test',
    emitMemoryGraphChanged: () => {},
  };
}

async function countTriples(store: OxigraphStore, graphUri: string): Promise<number> {
  const r = await store.query(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${graphUri}> { ?s ?p ?o } }`);
  if (r.type !== 'bindings') return 0;
  const raw = r.bindings[0]?.['n'] as string | undefined;
  if (!raw) return 0;
  const match = /^"(\d+)"/.exec(raw);
  return match ? Number(match[1]) : 0;
}

describe('POST /api/random-sampling/backfill-percgid-meta', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let store: OxigraphStore;
  let agent: ReturnType<typeof makeAgentMock>;

  beforeEach(async () => {
    store = new OxigraphStore();
    agent = makeAgentMock({ store, cgs: [] });
    server = createServer(async (req, res) => {
      const ctx = { ...makeCtx(req.url ?? '/', agent), req, res };
      try {
        await handleStatusRoutes(ctx as any);
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
      } catch (err) {
        // Test-harness only: emit a fixed body so the test cannot leak
        // exception text into a CodeQL stack-disclosure alert. Route
        // under test sets its own body upstream; this catch is a safety
        // net. Diagnostics still surface via console.error.
        // eslint-disable-next-line no-console
        console.error('[test-harness] unhandled route error:', err);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('server did not bind');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server!.close((err) => (err ? reject(err) : resolve())));
      server = undefined;
    }
  });

  it('copies per-KC meta from <cg>/_meta to <cg>/context/<cgId>/_meta for an on-chain CG', async () => {
    const cgName = 'rs-backfill-happy';
    const onChainId = '42';
    const kas: KcEntry[] = [
      { ual: 'did:dkg:base:84532/0xAAA/1000001', batchId: 7, rootEntity: 'urn:test:e1', tokenId: 1 },
      { ual: 'did:dkg:base:84532/0xAAA/2000001', batchId: 8, rootEntity: 'urn:test:e2', tokenId: 1 },
    ];
    await seedCanonicalMeta(store, { name: cgName, onChainId, kcEntries: kas });
    agent.getSubscribedContextGraphs = () => new Map([[cgName, { subscribed: true, synced: true, onChainId }]]);

    const expectedTriples = kas.reduce((acc, kc) => acc + tripleCountForKc(kc), 0);
    const before = await countTriples(store, `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta`);
    expect(before).toBe(0);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.summary).toMatchObject({ backfilled: 1, alreadyPopulated: 0, failed: 0 });
    expect(body.reports[0]).toMatchObject({
      contextGraphId: cgName,
      onChainId,
      status: 'backfilled',
      sourceKcCount: 2,
      copiedKcCount: 2,
      copiedTriples: expectedTriples,
    });

    const after = await countTriples(store, `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta`);
    expect(after).toBe(expectedTriples);
  });

  it('per-KC granularity: mixed-state CG only backfills KCs missing from target', async () => {
    // Regression for Codex review on PR #763: an earlier revision
    // short-circuited the whole CG when COUNT(*) > 0 in target,
    // which silently skipped historical KCs on any CG that had
    // received even one post-fix publish.
    const cgName = 'rs-backfill-mixed-state';
    const onChainId = '101';
    const kcAlreadyInTarget: KcEntry = {
      ual: 'did:dkg:base:84532/0xMIX/1000001', batchId: 51, rootEntity: 'urn:mix:already', tokenId: 1,
    };
    const kcOrphaned: KcEntry = {
      ual: 'did:dkg:base:84532/0xMIX/2000001', batchId: 52, rootEntity: 'urn:mix:orphan', tokenId: 1,
    };

    // Source has BOTH KCs (canonical `<cg>/_meta` is the catch-all
    // where every receiver landing wrote before the publisher fix).
    await seedCanonicalMeta(store, { name: cgName, onChainId, kcEntries: [kcAlreadyInTarget, kcOrphaned] });

    // Target has only the first KC (simulating one post-fix publish).
    await seedCanonicalMeta(
      store,
      { name: cgName, onChainId, kcEntries: [kcAlreadyInTarget] },
      `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta`,
    );
    const targetBefore = await countTriples(store, `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta`);
    expect(targetBefore).toBe(tripleCountForKc(kcAlreadyInTarget));

    agent.getSubscribedContextGraphs = () => new Map([[cgName, { subscribed: true, synced: true, onChainId }]]);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.reports[0]).toMatchObject({
      contextGraphId: cgName,
      onChainId,
      status: 'backfilled',
      sourceKcCount: 2,
      copiedKcCount: 1,
      copiedTriples: tripleCountForKc(kcOrphaned),
    });

    const target = `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta`;
    const targetAfter = await countTriples(store, target);
    // Target = (1 KC pre-existing) + (1 KC backfilled). De-duplicated by set semantics.
    expect(targetAfter).toBe(tripleCountForKc(kcAlreadyInTarget) + tripleCountForKc(kcOrphaned));

    // Tripwire: the originally-present KC's triples were NOT re-copied
    // (FILTER NOT EXISTS gated it out) — only the orphan KC's were.
    const ask = await store.query(
      `ASK { GRAPH <${target}> { <${kcOrphaned.ual}> <${DKG_NS}batchId> ?o } }`,
    );
    expect(ask.type).toBe('boolean');
    if (ask.type === 'boolean') expect(ask.value).toBe(true);
  });

  it('RFC ka-metadata-trim: legacy dkg:Publication nodes are NOT copied (KC/KA rows still are)', async () => {
    // The pre-trim route had a third UNION arm copying the publication
    // node reached via `<KA> dkg:publication <pub>`. The writer was
    // dropped (zero readers), and the repair tool dropped the arm with
    // it. Legacy-shape sources (rows from older nodes) must still get
    // their KC/KA rows rescued — the publication node simply stays
    // behind in `<cg>/_meta`.
    const cgName = 'rs-backfill-provenance';
    const onChainId = '202';
    const opId = 'op-fixture-2026';
    const author = '0x600AB8102eB4EFA9De4eFF2f4069D7a2D4c8A8fe';
    const kc: KcEntry = {
      ual: 'did:dkg:base:84532/0xPRV/9000001', batchId: 73, rootEntity: 'urn:prov:root', tokenId: 1,
      publication: { opId, author, merkleRootHex: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff' },
    };
    await seedCanonicalMeta(store, { name: cgName, onChainId, kcEntries: [kc] });
    agent.getSubscribedContextGraphs = () => new Map([[cgName, { subscribed: true, synced: true, onChainId }]]);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.summary).toMatchObject({ backfilled: 1 });
    expect(body.reports[0]).toMatchObject({
      copiedKcCount: 1,
      copiedTriples: copiedTripleCountForKc(kc),
    });

    const target = `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta`;
    const pubUri = `urn:dkg:publication:${opId}`;

    // KC row rescued.
    const kcAsk = await store.query(
      `ASK { GRAPH <${target}> { <${kc.ual}> <${DKG_NS}batchId> ?o } }`,
    );
    expect(kcAsk.type).toBe('boolean');
    if (kcAsk.type === 'boolean') expect(kcAsk.value).toBe(true);

    // Publication node NOT copied.
    const pubAsk = await store.query(
      `ASK { GRAPH <${target}> { <${pubUri}> ?p ?o } }`,
    );
    expect(pubAsk.type).toBe('boolean');
    if (pubAsk.type === 'boolean') expect(pubAsk.value).toBe(false);

    // The legacy KA→pub edge rides along (it sits on the KA subject,
    // which the second UNION arm copies wholesale).
    const kaPubAsk = await store.query(
      `ASK { GRAPH <${target}> { <${kc.ual}/${kc.tokenId}> <${DKG_NS}publication> <${pubUri}> } }`,
    );
    expect(kaPubAsk.type).toBe('boolean');
    if (kaPubAsk.type === 'boolean') expect(kaPubAsk.value).toBe(true);
  });

  it('reports already-populated when every source KC is already in target (idempotent)', async () => {
    const cgName = 'rs-backfill-idempotent';
    const onChainId = '99';
    const kc: KcEntry = {
      ual: 'did:dkg:base:84532/0xBBB/3000001', batchId: 11, rootEntity: 'urn:test:e3', tokenId: 1,
    };
    await seedCanonicalMeta(store, { name: cgName, onChainId, kcEntries: [kc] });
    // Pre-seed the per-cgId graph with the SAME KC's `dkg:batchId` —
    // that's the anchor the endpoint's FILTER NOT EXISTS uses to gate
    // each KC. Re-running on this state must be a no-op.
    await seedCanonicalMeta(
      store,
      { name: cgName, onChainId, kcEntries: [kc] },
      `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta`,
    );
    const targetBefore = await countTriples(store, `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta`);
    agent.getSubscribedContextGraphs = () => new Map([[cgName, { subscribed: true, synced: true, onChainId }]]);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.summary).toMatchObject({ backfilled: 0, alreadyPopulated: 1 });
    expect(body.reports[0]).toMatchObject({
      contextGraphId: cgName,
      status: 'already-populated',
      sourceKcCount: 1,
      copiedKcCount: 0,
      copiedTriples: 0,
    });

    const targetAfter = await countTriples(store, `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta`);
    expect(targetAfter).toBe(targetBefore);
  });

  it('reports no-source-meta when canonical _meta has no KCs', async () => {
    // Belt-and-braces test: a CG that's registered on-chain but
    // whose canonical meta carries only CG-lifecycle subjects (no
    // KCs) should report cleanly, not crash.
    const cgName = 'rs-backfill-empty-source';
    const onChainId = '7';
    await seedCanonicalMeta(store, {
      name: cgName,
      onChainId,
      cgLifecycleSubject: {
        subject: `did:dkg:context-graph:${cgName}`,
        predicate: 'http://schema.org/dateCreated',
        object: '"2026-05-26T18:18:00Z"',
      },
    });
    agent.getSubscribedContextGraphs = () => new Map([[cgName, { subscribed: true, synced: true, onChainId }]]);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.summary).toMatchObject({ noSourceMeta: 1, backfilled: 0 });
    expect(body.reports[0]).toMatchObject({
      contextGraphId: cgName,
      status: 'no-source-meta',
      sourceKcCount: 0,
    });
  });

  it('reports not-on-chain for subscribed CGs lacking onChainId', async () => {
    const cgName = 'rs-backfill-local-only';
    agent.getSubscribedContextGraphs = () => new Map([[cgName, { subscribed: true, synced: true }]]);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.summary).toMatchObject({ backfilled: 0, notOnChain: 1 });
    expect(body.reports[0]).toMatchObject({ contextGraphId: cgName, status: 'not-on-chain' });
  });

  it('dry-run reports copy count without writing', async () => {
    const cgName = 'rs-backfill-dryrun';
    const onChainId = '17';
    const kc: KcEntry = { ual: 'did:dkg:base:84532/0xCCC/4000001', batchId: 19, rootEntity: 'urn:test:e4', tokenId: 1 };
    await seedCanonicalMeta(store, { name: cgName, onChainId, kcEntries: [kc] });
    agent.getSubscribedContextGraphs = () => new Map([[cgName, { subscribed: true, synced: true, onChainId }]]);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.dryRun).toBe(true);
    expect(body.summary).toMatchObject({ backfilled: 1 });
    expect(body.reports[0]).toMatchObject({
      status: 'backfilled',
      copiedKcCount: 1,
      copiedTriples: tripleCountForKc(kc),
    });

    const after = await countTriples(store, `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta`);
    expect(after).toBe(0);
  });

  it('filters out CG-lifecycle subjects (only copies KC/KA URIs)', async () => {
    // Subjects without `dkg:batchId` (and not reached via `dkg:partOf`)
    // belong to CG-level metadata — accessPolicy, createdAt on the
    // cgEntity, etc. The publisher doesn't promote them into per-cgId;
    // neither should the backfill.
    const cgName = 'rs-backfill-filter';
    const onChainId = '23';
    const kc: KcEntry = { ual: 'did:dkg:base:84532/0xDDD/5000001', batchId: 31, rootEntity: 'urn:test:e5', tokenId: 1 };
    await seedCanonicalMeta(store, {
      name: cgName,
      onChainId,
      kcEntries: [kc],
      cgLifecycleSubject: {
        subject: `did:dkg:context-graph:${cgName}`,
        predicate: 'http://schema.org/dateCreated',
        object: '"2026-05-26T18:18:00Z"',
      },
    });
    agent.getSubscribedContextGraphs = () => new Map([[cgName, { subscribed: true, synced: true, onChainId }]]);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.summary.backfilled).toBe(1);

    const target = `did:dkg:context-graph:${cgName}/context/${onChainId}/_meta`;
    const lifecycleProbe = await store.query(
      `ASK { GRAPH <${target}> { <did:dkg:context-graph:${cgName}> <http://schema.org/dateCreated> ?o } }`,
    );
    expect(lifecycleProbe.type).toBe('boolean');
    if (lifecycleProbe.type === 'boolean') expect(lifecycleProbe.value).toBe(false);

    const kcProbe = await store.query(
      `ASK { GRAPH <${target}> { <${kc.ual}> <${DKG_NS}batchId> ?o } }`,
    );
    expect(kcProbe.type).toBe('boolean');
    if (kcProbe.type === 'boolean') expect(kcProbe.value).toBe(true);
  });

  it('restricts to specific CG names when contextGraphIds is provided', async () => {
    const cgA = 'rs-backfill-restrict-a';
    const cgB = 'rs-backfill-restrict-b';
    await seedCanonicalMeta(store, { name: cgA, onChainId: '1', kcEntries: [{ ual: 'did:dkg:base:84532/0xEEE/6000001', batchId: 41, rootEntity: 'urn:e:a', tokenId: 1 }] });
    await seedCanonicalMeta(store, { name: cgB, onChainId: '2', kcEntries: [{ ual: 'did:dkg:base:84532/0xFFF/7000001', batchId: 43, rootEntity: 'urn:e:b', tokenId: 1 }] });
    agent.getSubscribedContextGraphs = () => new Map([
      [cgA, { subscribed: true, synced: true, onChainId: '1' }],
      [cgB, { subscribed: true, synced: true, onChainId: '2' }],
    ]);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextGraphIds: [cgA] }),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.processed).toBe(1);
    expect(body.reports[0].contextGraphId).toBe(cgA);
    expect(body.unknownContextGraphIds).toEqual([]);

    const aCount = await countTriples(store, `did:dkg:context-graph:${cgA}/context/1/_meta`);
    const bCount = await countTriples(store, `did:dkg:context-graph:${cgB}/context/2/_meta`);
    expect(aCount).toBeGreaterThan(0);
    expect(bCount).toBe(0);
  });

  it('surfaces unknown contextGraphIds when none of the requested names match a subscribed CG', async () => {
    // Regression for Codex round-2 review on PR #763: a typo'd CG
    // name used to yield `processed: 0` and looked identical to a
    // successful no-op. Now the endpoint reports the unknown names
    // explicitly so the operator script can fail loudly.
    const cgA = 'rs-backfill-known-cg';
    await seedCanonicalMeta(store, { name: cgA, onChainId: '1', kcEntries: [{ ual: 'did:dkg:base:84532/0xAAA/1', batchId: 1, rootEntity: 'urn:e:a', tokenId: 1 }] });
    agent.getSubscribedContextGraphs = () => new Map([[cgA, { subscribed: true, synced: true, onChainId: '1' }]]);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextGraphIds: ['rs-backfill-typo', 'another-typo'] }),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.processed).toBe(0);
    expect(body.unknownContextGraphIds).toEqual(['rs-backfill-typo', 'another-typo']);
  });

  it('reports unknownContextGraphIds even when some requested names DO match', async () => {
    // Mixed case: operator passes a typo alongside a real CG name —
    // the real one is processed, the typo is reported as unknown so
    // the partial-success run is fully diagnosable.
    const cgA = 'rs-backfill-mixed-known';
    await seedCanonicalMeta(store, { name: cgA, onChainId: '1', kcEntries: [{ ual: 'did:dkg:base:84532/0xAAA/1', batchId: 1, rootEntity: 'urn:e:m', tokenId: 1 }] });
    agent.getSubscribedContextGraphs = () => new Map([[cgA, { subscribed: true, synced: true, onChainId: '1' }]]);

    const res = await fetch(`${baseUrl}/api/random-sampling/backfill-percgid-meta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contextGraphIds: [cgA, 'mistyped'] }),
    });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.processed).toBe(1);
    expect(body.reports[0]).toMatchObject({ contextGraphId: cgA, status: 'backfilled' });
    expect(body.unknownContextGraphIds).toEqual(['mistyped']);
  });
});
