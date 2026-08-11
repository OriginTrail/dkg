import { afterAll, describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import {
  SYNC_BYTE_BUDGET_PAGE_MODE,
  SYNC_BYTE_BUDGET_RESPONSE_BYTES,
  SYNC_PAGE_SIZE,
  SYNC_REQUEST_PAGE_SIZE,
  SYNC_REQUEST_SAFE_PAGE_SIZE,
} from '../src/dkg-agent-constants.js';
import { buildSyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import { encodeExactAssetUals, MAX_EXACT_SYNC_ASSETS } from '../src/sync/exact-assets.js';
import {
  readDurableDataPage,
  serializeResponderRows,
} from '../src/sync/responder/graph-plan.js';
import {
  linesFromNquads,
  registerTestSyncHandler,
} from './_helpers/sync-responder.js';

// #1871 — the exact-KA filter is only as safe as the production wire parsing
// that feeds registerSyncHandler. These tests pin ContextGraphResolveMethods.
// parseSyncRequest end to end for both wire formats: valid filters survive
// normalization, present-but-invalid filters fail closed to [] (responder
// serves nothing), and absent filters stay undefined (full sync).
const UAL_7 = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7';
const UAL_8 = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/8';
const DKG = 'http://dkg.io/ontology/';
const AUTHOR = '0x00000000000000000000000000000000000000ab';
const integer = (value: number) =>
  `"${value}"^^<http://www.w3.org/2001/XMLSchema#integer>`;

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

describe('exact-asset wire parsing (parseSyncRequest)', () => {
  let agentPromise: Promise<DKGAgent> | undefined;
  const getAgent = async (): Promise<DKGAgent> => {
    agentPromise ??= DKGAgent.create({ name: 'ExactAssetWireParse', chainAdapter: new MockChainAdapter() });
    return agentPromise;
  };
  afterAll(async () => {
    await (await getAgent()).stop().catch(() => {});
  });

  const parse = async (value: unknown) =>
    (await getAgent() as any).parseSyncRequest(encode(value));
  const parseBytes = async (value: Uint8Array) =>
    (await getAgent() as any).parseSyncRequest(value);

  it('preserves a valid assetUals filter from a JSON envelope', async () => {
    const parsed = await parse({ contextGraphId: 'cg', phase: 'data', assetUals: [UAL_7, UAL_8] });
    expect(parsed.assetUals).toEqual([UAL_7, UAL_8]);
  });

  it('fail-closes present-but-invalid JSON filters to an empty filter, never undefined', async () => {
    for (const bad of [
      ['not-a-ual'],
      [UAL_7, 'not-a-ual'],
      [],
      'not-an-array',
      Array.from({ length: MAX_EXACT_SYNC_ASSETS + 1 }, (_, i) =>
        `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${i}`),
    ]) {
      const parsed = await parse({ contextGraphId: 'cg', phase: 'data', assetUals: bad });
      expect(parsed.assetUals, JSON.stringify(bad)).toEqual([]);
    }
  });

  it('leaves assetUals undefined when a JSON envelope omits it', async () => {
    const parsed = await parse({ contextGraphId: 'cg', phase: 'data' });
    expect(parsed.assetUals).toBeUndefined();
  });

  it('parses the |assets| tail token after legacy session/since tokens', async () => {
    const parsed = await parse(
      `mfacts|0|100|data|session|s-1|since|42|assets|${encodeExactAssetUals([UAL_7])}`,
    );
    expect(parsed.contextGraphId).toBe('mfacts');
    expect(parsed.syncSessionId).toBe('s-1');
    expect(parsed.sinceBatchId).toBe('42');
    expect(parsed.assetUals).toEqual([UAL_7]);
  });

  it('round-trips public exact-fetch byte-budget negotiation through the pipe wire form', async () => {
    const encoded = await buildSyncRequestEnvelope({
      contextGraphId: 'mfacts',
      offset: 0,
      limit: SYNC_REQUEST_PAGE_SIZE,
      includeSharedMemory: false,
      targetPeerId: 'peer-responder',
      requesterPeerId: 'peer-requester',
      phase: 'data',
      syncSessionId: 's-1',
      sinceBatchId: '42',
      assetUals: [UAL_7, UAL_8],
      needsAuth: false,
      computeSyncDigest: () => new Uint8Array(32),
      getIdentityId: async () => 0n,
    });
    expect(new TextDecoder().decode(encoded)).toBe(
      `mfacts|0|${SYNC_REQUEST_PAGE_SIZE}|data`
      + `|page-mode|${SYNC_BYTE_BUDGET_PAGE_MODE}|page-rows|${SYNC_REQUEST_PAGE_SIZE}`
      + `|session|s-1|since|42|assets|${encodeExactAssetUals([UAL_7, UAL_8])}`,
    );
    const parsed = await parseBytes(encoded);

    expect(parsed.phase).toBe('data');
    expect(parsed.limit).toBe(SYNC_PAGE_SIZE);
    expect(parsed.pageMode).toBe(SYNC_BYTE_BUDGET_PAGE_MODE);
    expect(parsed.pageRowsHint).toBe(SYNC_REQUEST_PAGE_SIZE);
    expect(parsed.syncSessionId).toBe('s-1');
    expect(parsed.sinceBatchId).toBe('42');
    expect(parsed.assetUals).toEqual([UAL_7, UAL_8]);
  });

  it('keeps malformed or unnegotiated pipe page hints inert without losing legacy tail fields', async () => {
    const missingMode = await parse(
      `mfacts|0|${SYNC_REQUEST_PAGE_SIZE}|data|page-rows|${SYNC_REQUEST_PAGE_SIZE}`
      + `|session|s-1|since|42|assets|${encodeExactAssetUals([UAL_7])}`,
    );
    expect(missingMode.pageMode).toBeUndefined();
    expect(missingMode.pageRowsHint).toBeUndefined();
    expect(missingMode.syncSessionId).toBe('s-1');
    expect(missingMode.sinceBatchId).toBe('42');
    expect(missingMode.assetUals).toEqual([UAL_7]);

    const malformedRows = await parse(
      `mfacts|0|${SYNC_REQUEST_PAGE_SIZE}|data`
      + `|page-mode|${SYNC_BYTE_BUDGET_PAGE_MODE}|page-rows|not-a-number`
      + `|session|s-1|since|42|assets|${encodeExactAssetUals([UAL_7])}`,
    );
    expect(malformedRows.pageMode).toBe(SYNC_BYTE_BUDGET_PAGE_MODE);
    expect(malformedRows.pageRowsHint).toBeUndefined();
    expect(malformedRows.syncSessionId).toBe('s-1');
    expect(malformedRows.assetUals).toEqual([UAL_7]);

    const wrongMode = await parse(
      `mfacts|0|${SYNC_REQUEST_PAGE_SIZE}|data`
      + `|page-mode|unknown-v2|page-rows|${SYNC_REQUEST_PAGE_SIZE}`,
    );
    expect(wrongMode.pageMode).toBeUndefined();
    expect(wrongMode.pageRowsHint).toBeUndefined();

    const stringJsonRows = await parse({
      contextGraphId: 'mfacts',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: String(SYNC_REQUEST_PAGE_SIZE),
    });
    expect(stringJsonRows.pageMode).toBe(SYNC_BYTE_BUDGET_PAGE_MODE);
    expect(stringJsonRows.pageRowsHint).toBeUndefined();
  });

  it('parses the |assets| token without session/since tokens', async () => {
    const parsed = await parse(`mfacts|0|100|data|assets|${encodeExactAssetUals([UAL_7, UAL_8])}`);
    expect(parsed.assetUals).toEqual([UAL_7, UAL_8]);
    expect(parsed.sinceBatchId).toBeUndefined();
    expect(parsed.syncSessionId).toBeUndefined();
  });

  it('fail-closes a malformed pipe assets token to an empty filter', async () => {
    for (const badToken of ['%%%not-json', encodeURIComponent(JSON.stringify(['not-a-ual']))]) {
      const parsed = await parse(`mfacts|0|100|data|assets|${badToken}`);
      expect(parsed.assetUals, badToken).toEqual([]);
    }
  });

  it('leaves assetUals undefined for a legacy pipe request without the token', async () => {
    const parsed = await parse('mfacts|0|100|data|session|s-1|since|42');
    expect(parsed.assetUals).toBeUndefined();
    expect(parsed.sinceBatchId).toBe('42');
  });

  it('paginates exactly MAX_EXACT_SYNC_ASSETS through the production wire and responder', async () => {
    const contextGraphId = 'max-ka-public-exact';
    const rowsPerKa = 77;
    const store = new OxigraphStore();
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const payload = `"${'x'.repeat(40_000)}"`;
    const assetUals: string[] = [];
    const payloadGraphs: string[] = [];
    const manifestQuads: Quad[] = [];
    const expectedRows: Array<{ s: string; p: string; o: string; g: string }> = [];

    for (let assetIndex = 0; assetIndex < MAX_EXACT_SYNC_ASSETS; assetIndex += 1) {
      const ual = `did:dkg:base:84532/${AUTHOR}/${assetIndex + 1}`;
      const graph = knowledgeAssetLayerGraphUri(
        contextGraphId,
        MemoryLayer.VerifiableMemory,
        createGraphKnowledgeAssetScope(ual, 1),
      );
      assetUals.push(ual);
      payloadGraphs.push(graph);
      manifestQuads.push(
        { graph: metaGraph, subject: ual, predicate: `${DKG}contentScopeVersion`, object: integer(GRAPH_KA_CONTENT_SCOPE_VERSION) },
        { graph: metaGraph, subject: ual, predicate: `${DKG}kaUal`, object: ual },
        { graph: metaGraph, subject: ual, predicate: `${DKG}assertionVersion`, object: integer(1) },
        { graph: metaGraph, subject: ual, predicate: `${DKG}assertionGraph`, object: graph },
        { graph: metaGraph, subject: ual, predicate: `${DKG}contextGraph`, object: contextGraphDataGraphUri(contextGraphId) },
        { graph: metaGraph, subject: ual, predicate: `${DKG}publicTripleCount`, object: integer(rowsPerKa) },
        { graph: metaGraph, subject: ual, predicate: `${DKG}privateTripleCount`, object: integer(0) },
        { graph: metaGraph, subject: ual, predicate: `${DKG}status`, object: '"confirmed"' },
      );
      for (let rowIndex = 0; rowIndex < rowsPerKa; rowIndex += 1) {
        expectedRows.push({
          g: graph,
          s: `urn:entity:${String(assetIndex * rowsPerKa + rowIndex).padStart(4, '0')}`,
          p: 'urn:predicate',
          o: payload,
        });
      }
    }
    await store.insert([
      ...manifestQuads,
      ...expectedRows.map((row) => ({
        graph: row.g,
        subject: row.s,
        predicate: row.p,
        object: row.o,
      })),
    ]);

    const directPage = await readDurableDataPage({
      store,
      graphList: payloadGraphs,
      contextGraphId,
      sinceBatchId: null,
      offset: 0,
      limit: SYNC_REQUEST_SAFE_PAGE_SIZE,
      assetUals,
      exactGraphReadMode: 'page-only',
    });
    expect(directPage).toHaveLength(SYNC_REQUEST_SAFE_PAGE_SIZE);

    const originalQuery = store.query.bind(store);
    const payloadReadLimits: number[] = [];
    let maxPayloadBindings = 0;
    store.query = (async (
      sparql: string,
      options?: Parameters<OxigraphStore['query']>[1],
    ) => {
      const result = await originalQuery(sparql, options);
      const isPagedPayloadRead = sparql.includes('ORDER BY ?s ?p ?o') &&
        payloadGraphs.some((graph) => sparql.includes(`<${graph}>`));
      if (isPagedPayloadRead) {
        const limit = /\bLIMIT\s+(\d+)/i.exec(sparql);
        if (limit) payloadReadLimits.push(Number(limit[1]));
        if (result.type === 'bindings') {
          maxPayloadBindings = Math.max(maxPayloadBindings, result.bindings.length);
        }
      }
      return result;
    }) as OxigraphStore['query'];

    const agent = await getAgent();
    const parsedAssetUalPages: string[][] = [];
    const cap = registerTestSyncHandler(store, {
      syncPageSize: SYNC_PAGE_SIZE,
      parseSyncRequest: (data) => {
        const parsed = (agent as any).parseSyncRequest(data);
        parsedAssetUalPages.push([...(parsed.assetUals ?? [])]);
        return parsed;
      },
    });
    const received: string[] = [];
    const requestedOffsets: number[] = [];
    let offset = 0;
    for (let page = 0; page < 20; page += 1) {
      requestedOffsets.push(offset);
      const request = await buildSyncRequestEnvelope({
        contextGraphId,
        offset,
        limit: SYNC_REQUEST_PAGE_SIZE,
        includeSharedMemory: false,
        targetPeerId: 'peer-responder',
        requesterPeerId: 'peer-requester',
        phase: 'data',
        syncSessionId: 'max-ka-session',
        assetUals,
        needsAuth: false,
        computeSyncDigest: () => new Uint8Array(32),
        getIdentityId: async () => 0n,
      });
      const response = await cap.invokeBytes(request);
      const lines = linesFromNquads(response);
      expect(new TextEncoder().encode(response).byteLength)
        .toBeLessThanOrEqual(SYNC_BYTE_BUDGET_RESPONSE_BYTES);
      expect(lines.length).toBeLessThanOrEqual(SYNC_REQUEST_SAFE_PAGE_SIZE);
      if (lines.length === 0) break;
      received.push(...lines);
      offset += lines.length;
    }

    const expected = linesFromNquads(serializeResponderRows(expectedRows));
    expect(parsedAssetUalPages[0]).toHaveLength(MAX_EXACT_SYNC_ASSETS);
    expect(received).toHaveLength(MAX_EXACT_SYNC_ASSETS * rowsPerKa);
    expect(new Set(received)).toEqual(new Set(expected));
    expect(parsedAssetUalPages).toHaveLength(requestedOffsets.length);
    const canonicalAssetUals = [...assetUals].sort();
    expect(parsedAssetUalPages.every((page) =>
      page.length === MAX_EXACT_SYNC_ASSETS
      && page.every((ual, index) => ual === canonicalAssetUals[index]))).toBe(true);
    const totalRows = MAX_EXACT_SYNC_ASSETS * rowsPerKa;
    expect(requestedOffsets).toEqual([
      ...Array.from(
        { length: Math.ceil(totalRows / SYNC_REQUEST_SAFE_PAGE_SIZE) },
        (_, index) => index * SYNC_REQUEST_SAFE_PAGE_SIZE,
      ),
      totalRows,
    ]);
    expect(payloadReadLimits.length).toBeGreaterThan(0);
    expect(Math.max(...payloadReadLimits)).toBeLessThanOrEqual(SYNC_REQUEST_SAFE_PAGE_SIZE);
    expect(maxPayloadBindings).toBeLessThanOrEqual(SYNC_REQUEST_SAFE_PAGE_SIZE);

    await store.close();
  }, 60_000);

  it('keeps fake signature fields on the 64-row page-only exact-fetch policy', async () => {
    const contextGraphId = 'fake-signature-public-exact';
    const store = new OxigraphStore();
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const ual = `did:dkg:base:84532/${AUTHOR}/99`;
    const graph = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.VerifiableMemory,
      createGraphKnowledgeAssetScope(ual, 1),
    );
    const rowCount = 200;
    await store.insert([
      { graph: metaGraph, subject: ual, predicate: `${DKG}contentScopeVersion`, object: integer(GRAPH_KA_CONTENT_SCOPE_VERSION) },
      { graph: metaGraph, subject: ual, predicate: `${DKG}kaUal`, object: ual },
      { graph: metaGraph, subject: ual, predicate: `${DKG}assertionVersion`, object: integer(1) },
      { graph: metaGraph, subject: ual, predicate: `${DKG}assertionGraph`, object: graph },
      { graph: metaGraph, subject: ual, predicate: `${DKG}contextGraph`, object: contextGraphDataGraphUri(contextGraphId) },
      { graph: metaGraph, subject: ual, predicate: `${DKG}publicTripleCount`, object: integer(rowCount) },
      { graph: metaGraph, subject: ual, predicate: `${DKG}privateTripleCount`, object: integer(0) },
      { graph: metaGraph, subject: ual, predicate: `${DKG}status`, object: '"confirmed"' },
      ...Array.from({ length: rowCount }, (_, i) => ({
        graph,
        subject: `urn:fake-signature-entity:${i.toString().padStart(3, '0')}`,
        predicate: 'urn:predicate',
        object: `"value-${i}"`,
      })),
    ]);

    const originalQuery = store.query.bind(store);
    const payloadReadLimits: number[] = [];
    let maxPayloadBindings = 0;
    let payloadSnapshotQueries = 0;
    store.query = (async (
      sparql: string,
      options?: Parameters<OxigraphStore['query']>[1],
    ) => {
      const result = await originalQuery(sparql, options);
      const isPayloadRead = sparql.includes(`GRAPH <${graph}> { ?s ?p ?o }`);
      if (isPayloadRead && sparql.includes('ORDER BY ?s ?p ?o')) {
        const limit = /\bLIMIT\s+(\d+)/i.exec(sparql);
        if (limit) payloadReadLimits.push(Number(limit[1]));
        if (result.type === 'bindings') {
          maxPayloadBindings = Math.max(maxPayloadBindings, result.bindings.length);
        }
      } else if (isPayloadRead) {
        payloadSnapshotQueries += 1;
      }
      return result;
    }) as OxigraphStore['query'];

    const agent = await getAgent();
    const cap = registerTestSyncHandler(store, {
      syncPageSize: SYNC_PAGE_SIZE,
      parseSyncRequest: (data) => (agent as any).parseSyncRequest(data),
    });
    const response = await cap.invokeBytes(encode({
      contextGraphId,
      offset: 0,
      limit: SYNC_PAGE_SIZE,
      includeSharedMemory: false,
      phase: 'data',
      syncSessionId: 'fake-signature-session',
      pageMode: SYNC_BYTE_BUDGET_PAGE_MODE,
      pageRowsHint: SYNC_REQUEST_PAGE_SIZE,
      assetUals: [ual],
      requesterSignatureR: 'attacker-controlled-r',
      requesterSignatureVS: 'attacker-controlled-vs',
    }));

    expect(linesFromNquads(response)).toHaveLength(SYNC_REQUEST_SAFE_PAGE_SIZE);
    expect(new TextEncoder().encode(response).byteLength)
      .toBeLessThanOrEqual(SYNC_BYTE_BUDGET_RESPONSE_BYTES);
    expect(payloadReadLimits.length).toBeGreaterThan(0);
    expect(Math.max(...payloadReadLimits)).toBeLessThanOrEqual(SYNC_REQUEST_SAFE_PAGE_SIZE);
    expect(maxPayloadBindings).toBeLessThanOrEqual(SYNC_REQUEST_SAFE_PAGE_SIZE);
    expect(payloadSnapshotQueries).toBe(0);

    await store.close();
  });
});
