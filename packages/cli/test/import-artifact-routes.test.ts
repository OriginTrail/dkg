import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contextGraphAssertionUri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import { FileStore } from '../src/file-store.js';
import type { ExtractionStatusRecord } from '../src/extraction-status.js';
import { handleAssertionRoutes } from '../src/daemon/routes/assertion.js';

const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';

type Quad = { subject: string; predicate: string; object: string };

describe('import artifact daemon routes', () => {
  let tempDir: string;
  let fileStore: FileStore;
  let server: Server | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dkg-import-artifact-routes-'));
    fileStore = new FileStore(join(tempDir, 'files'));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => (err ? reject(err) : resolve()));
      });
      server = undefined;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  async function startRoutes(args: {
    agent: any;
    extractionStatus?: Map<string, ExtractionStatusRecord>;
    events?: unknown[];
  }) {
    const events = args.events ?? [];
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      try {
        await handleAssertionRoutes({
          req,
          res,
          agent: args.agent,
          publisherControl: {},
          publisherRuntime: null,
          config: {},
          startedAt: Date.now(),
          dashDb: {},
          opWallets: {},
          network: {},
          tracker: {},
          memoryManager: {},
          bridgeAuthToken: undefined,
          nodeVersion: 'test',
          nodeCommit: 'test',
          catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() },
          extractionRegistry: {},
          fileStore,
          extractionStatus: args.extractionStatus ?? new Map(),
          assertionImportLocks: new Map(),
          vectorStore: {},
          embeddingProvider: null,
          validTokens: new Set(),
          apiHost: '127.0.0.1',
          apiPortRef: { value: 0 },
          url,
          path: url.pathname,
          requestToken: undefined,
          requestAgentAddress: 'did:dkg:agent:test',
          emitMemoryGraphChanged: (event) => events.push(event),
        } as any);
        if (!res.writableEnded) {
          res.statusCode = 404;
          res.end();
        }
      } catch (err) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Unhandled test route error' }));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function post(path: string, body: Record<string, unknown>) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  function makeAgent(args: {
    contextGraphId: string;
    assertionName: string;
    assertionUri: string;
    fileHash: string;
    markdownHash: string;
    markdownForm: string | string[];
    contentType?: string | null;
    extractionStatus?: string;
    omitExtractionStatus?: boolean;
    structuralTripleCount?: string;
    mdIntermediateHash?: string;
    publisherCreateError?: Error;
    publisherWriteError?: Error;
    publisherDiscardError?: Error;
    targetGraphExists?: boolean;
    queryQuads?: Quad[];
  }) {
    const created: Array<{
      contextGraphId: string;
      name: string;
      agentAddress?: string;
      subGraphName?: string;
      opts?: unknown;
    }> = [];
    const writes: Array<{
      contextGraphId: string;
      name: string;
      agentAddress?: string;
      quads: Quad[];
      subGraphName?: string;
      opts?: unknown;
    }> = [];
    const discards: Array<{
      contextGraphId: string;
      name: string;
      agentAddress?: string;
      subGraphName?: string;
    }> = [];
    const queries: string[] = [];
    const queryQuads = args.queryQuads ?? [
      { subject: 'urn:z', predicate: 'urn:p', object: 'urn:o' },
      { subject: 'urn:a', predicate: 'urn:p', object: '"A"' },
    ];
    const agent = {
      assertion: {
        async create(contextGraphId: string, name: string, opts?: unknown) {
          created.push({ contextGraphId, name, opts });
          return contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', name);
        },
        async write(contextGraphId: string, name: string, quads: Quad[], opts?: unknown) {
          writes.push({ contextGraphId, name, quads, opts });
        },
        async query() {
          return queryQuads;
        },
      },
      publisher: {
        async assertionCreate(
          contextGraphId: string,
          name: string,
          agentAddress: string,
          subGraphName?: string,
        ) {
          if (args.publisherCreateError) throw args.publisherCreateError;
          created.push({ contextGraphId, name, agentAddress, subGraphName });
          return contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName);
        },
        async assertionWrite(
          contextGraphId: string,
          name: string,
          agentAddress: string,
          quads: Quad[],
          subGraphName?: string,
        ) {
          if (args.publisherWriteError) throw args.publisherWriteError;
          writes.push({ contextGraphId, name, agentAddress, quads, subGraphName });
        },
        async assertionDiscard(
          contextGraphId: string,
          name: string,
          agentAddress: string,
          subGraphName?: string,
        ) {
          if (args.publisherDiscardError) throw args.publisherDiscardError;
          discards.push({ contextGraphId, name, agentAddress, subGraphName });
        },
      },
      store: {
        async hasGraph() {
          return Boolean(args.targetGraphExists);
        },
        async query(sparql: string) {
          queries.push(sparql);
          if (sparql.includes('SELECT ?p ?o')) {
            return { type: 'bindings', bindings: [] };
          }
          if (sparql.includes('SELECT ?fileHash')) {
            expect(sparql).toContain(`<${contextGraphMetaUri(args.contextGraphId)}>`);
            expect(sparql).toContain(`<${args.assertionUri}> <${DKG}sourceFileHash>`);
            return {
              type: 'bindings',
              bindings: [{
                fileHash: args.fileHash,
                ...(args.contentType !== null ? { contentType: args.contentType ?? 'text/markdown' } : {}),
                rootEntity: 'urn:doc:imported',
                structuralTripleCount: args.structuralTripleCount ?? '3',
                semanticTripleCount: '0',
                extractionMethod: 'text/markdown',
                ...(args.omitExtractionStatus ? {} : { extractionStatus: args.extractionStatus ?? 'completed' }),
                ...(args.mdIntermediateHash ? { mdIntermediateHash: args.mdIntermediateHash } : {}),
                sourceFileName: 'imported.md',
              }],
            };
          }
          if (sparql.includes('?markdownForm')) {
            const markdownForms = Array.isArray(args.markdownForm)
              ? args.markdownForm
              : [args.markdownForm];
            expect(sparql).toContain(`GRAPH <${args.assertionUri}>`);
            return {
              type: 'bindings',
              bindings: markdownForms.map((markdownForm) => ({ markdownForm })),
            };
          }
          throw new Error(`unexpected query: ${sparql}`);
        },
      },
    };
    return { agent, created, writes, discards, queries };
  }

  it('resolves and safely reads a completed Markdown import artifact by content hash', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n\nHello DKG.\n'), 'text/markdown');
    const contextGraphId = 'cg-import-artifact';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const markdownForm = `urn:dkg:file:${entry.keccak256}`;
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm,
    });
    await startRoutes({ agent });

    const resolved = await post('/api/assertion/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
      assertionName,
      fileHash: entry.keccak256,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.artifact).toMatchObject({
      contextGraphId,
      assertionUri,
      assertionName,
      assertionAgentAddress: 'did:dkg:agent:test',
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm,
      canReadMarkdown: true,
      extractionStatus: 'completed',
    });

    const read = await post('/api/assertion/import-artifact/read-markdown', {
      contextGraphId,
      assertionUri,
      maxBytes: 1024,
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      markdownHash: entry.keccak256,
      contentType: 'text/markdown',
      bytes: Buffer.byteLength('# Imported\n\nHello DKG.\n'),
      markdown: '# Imported\n\nHello DKG.\n',
    });
  });

  it('accepts legacy ownerless attachment assertion URIs by resolving them to the requesting agent assertion', async () => {
    const entry = await fileStore.put(Buffer.from('# Legacy Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-import-artifact-legacy-uri';
    const assertionName = 'legacy-md';
    const legacyAssertionUri = `did:dkg:context-graph:${contextGraphId}/assertion/${assertionName}`;
    const canonicalAssertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const markdownForm = `urn:dkg:file:${entry.keccak256}`;
    const { agent, writes } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri: canonicalAssertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm,
    });
    await startRoutes({ agent });

    const resolved = await post('/api/assertion/import-artifact/resolve', {
      contextGraphId,
      assertionUri: legacyAssertionUri,
      assertionName,
      fileHash: entry.keccak256,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.artifact).toMatchObject({
      contextGraphId,
      assertionUri: canonicalAssertionUri,
      assertionAgentAddress: 'did:dkg:agent:test',
      assertionName,
      markdownHash: entry.keccak256,
    });

    const read = await post('/api/assertion/import-artifact/read-markdown', {
      contextGraphId,
      assertionUri: legacyAssertionUri,
    });
    expect(read.status).toBe(200);
    expect(read.body.markdown).toBe('# Legacy Imported\n');

    const enriched = await post('/api/assertion/semantic-enrichment/write', {
      contextGraphId,
      assertionUri: legacyAssertionUri,
      semanticQuads: [
        { subject: 'urn:doc:legacy', predicate: 'http://schema.org/about', object: 'Legacy topic' },
      ],
    });
    expect(enriched.status).toBe(200);
    expect(enriched.body).toMatchObject({
      sourceAssertionUri: canonicalAssertionUri,
      assertionUri: canonicalAssertionUri,
      semanticTripleCount: 1,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      contextGraphId,
      name: assertionName,
      agentAddress: 'did:dkg:agent:test',
    });
  });

  it('accepts legacy completed import metadata that predates durable extractionStatus', async () => {
    const entry = await fileStore.put(Buffer.from('# Legacy Completed\n'), 'text/markdown');
    const contextGraphId = 'cg-import-artifact-legacy-status';
    const assertionName = 'legacy-completed-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
      omitExtractionStatus: true,
    });
    await startRoutes({ agent });

    const result = await post('/api/assertion/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
    });

    expect(result.status).toBe(200);
    expect(result.body.artifact).toMatchObject({
      assertionUri,
      extractionStatus: 'completed',
      structuralTripleCount: 3,
      canReadMarkdown: true,
    });
  });

  for (const structuralTripleCount of ['0', '1.5', '1junk']) {
    it(`still rejects missing durable extractionStatus when structuralTripleCount is ${structuralTripleCount}`, async () => {
      const entry = await fileStore.put(Buffer.from('# Ambiguous\n'), 'text/markdown');
      const suffix = structuralTripleCount.replace(/[^a-z0-9]+/gi, '-');
      const contextGraphId = `cg-import-artifact-missing-status-${suffix}`;
      const assertionName = `ambiguous-md-${suffix}`;
      const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
      const { agent } = makeAgent({
        contextGraphId,
        assertionName,
        assertionUri,
        fileHash: entry.keccak256,
        markdownHash: entry.keccak256,
        markdownForm: `urn:dkg:file:${entry.keccak256}`,
        omitExtractionStatus: true,
        structuralTripleCount,
      });
      await startRoutes({ agent });

      const result = await post('/api/assertion/import-artifact/resolve', {
        contextGraphId,
        assertionUri,
      });

      expect(result.status).toBe(409);
      expect(result.body.error).toMatch(/missing completed extraction status/);
    });
  }

  it('rejects cross-agent import artifact metadata and Markdown reads', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-import-artifact-cross-agent-read';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const { agent, queries } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
    });
    const extractionStatus = new Map<string, ExtractionStatusRecord>([[
      assertionUri,
      {
        status: 'skipped',
        assertionName,
        assertionUri,
        fileHash: entry.keccak256,
        detectedContentType: 'application/octet-stream',
        pipelineUsed: null,
        tripleCount: 0,
        startedAt: '2026-05-11T00:00:00.000Z',
        completedAt: '2026-05-11T00:00:01.000Z',
      },
    ]]);
    await startRoutes({ agent, extractionStatus });

    const resolved = await post('/api/assertion/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
      fileHash: entry.keccak256,
    });
    expect(resolved.status).toBe(403);
    expect(resolved.body.error).toMatch(/owned by the requesting agent/);

    const read = await post('/api/assertion/import-artifact/read-markdown', {
      contextGraphId,
      assertionUri,
      maxBytes: 1024,
    });
    expect(read.status).toBe(403);
    expect(read.body.error).toMatch(/owned by the requesting agent/);
    expect(queries).toHaveLength(0);
  });

  it('requires full assertionUri instead of guessing the source author from assertionName', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-import-artifact-uri-required';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
    });
    await startRoutes({ agent });

    const result = await post('/api/assertion/import-artifact/resolve', {
      contextGraphId,
      assertionName,
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/"assertionUri" is required/);
  });

  it('appends semantic enrichment to the imported assertion with explicit provenance', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-semantic-enrichment';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const markdownForm = `urn:dkg:file:${entry.keccak256}`;
    const events: unknown[] = [];
    const { agent, created, writes } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm,
    });
    await startRoutes({ agent, events });

    const result = await post('/api/assertion/semantic-enrichment/write', {
      contextGraphId,
      assertionUri,
      semanticQuads: [
        { subject: 'urn:doc:imported', predicate: 'http://schema.org/about', object: '"Semantic topic"' },
      ],
      generationMethod: 'unit-test-model',
      agentIdentity: 'did:dkg:agent:reviewer',
      generatedAt: '2026-05-11T00:00:00.000Z',
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      assertionUri,
      assertionName,
      sourceAssertionUri: assertionUri,
      sourceFileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm,
      semanticTripleCount: 1,
      promoted: false,
      published: false,
    });
    expect(created).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.name).toBe(assertionName);
    expect(writes[0]!.agentAddress).toBe('did:dkg:agent:test');
    expect(writes[0]!.quads).toEqual(expect.arrayContaining([
      { subject: 'urn:doc:imported', predicate: 'http://schema.org/about', object: '"Semantic topic"' },
      { subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}sourceAssertion`, object: assertionUri },
      { subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}sourceFileHash`, object: `"${entry.keccak256}"` },
      { subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}markdownHash`, object: `"${entry.keccak256}"` },
      { subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}markdownForm`, object: markdownForm },
      { subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}generationMethod`, object: '"unit-test-model"' },
      { subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}generatedBy`, object: 'did:dkg:agent:reviewer' },
      { subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${PROV}wasAttributedTo`, object: 'did:dkg:agent:reviewer' },
      { subject: 'urn:doc:imported', predicate: `${PROV}wasDerivedFrom`, object: assertionUri },
    ]));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'semantic_enrichment_written', layers: ['wm'] }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'assertion_created', layers: ['wm'] }),
    ]));
  });

  it('rejects semantic enrichment of imported assertions owned by another agent', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-semantic-enrichment-cross-agent';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const { agent, writes, queries } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
    });
    const extractionStatus = new Map<string, ExtractionStatusRecord>([[
      assertionUri,
      {
        status: 'skipped',
        assertionName,
        assertionUri,
        fileHash: entry.keccak256,
        detectedContentType: 'application/octet-stream',
        pipelineUsed: null,
        tripleCount: 0,
        startedAt: '2026-05-11T00:00:00.000Z',
        completedAt: '2026-05-11T00:00:01.000Z',
      },
    ]]);
    await startRoutes({ agent, extractionStatus });

    const result = await post('/api/assertion/semantic-enrichment/write', {
      contextGraphId,
      assertionUri,
      semanticQuads: [
        { subject: 'urn:doc:imported', predicate: 'http://schema.org/about', object: '"Semantic topic"' },
      ],
    });

    expect(result.status).toBe(403);
    expect(result.body.error).toMatch(/owned by the requesting agent/);
    expect(writes).toHaveLength(0);
    expect(queries).toHaveLength(0);
  });

  it('stores non-IRI agent identity labels without emitting prov attribution resources', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-semantic-enrichment-label-agent';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent, writes } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
    });
    await startRoutes({ agent });

    const result = await post('/api/assertion/semantic-enrichment/write', {
      contextGraphId,
      assertionUri,
      semanticQuads: [
        { subject: 'urn:doc:imported', predicate: 'http://schema.org/about', object: 'Semantic topic' },
      ],
      agentIdentity: 'Reviewer Bot',
    });

    expect(result.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.quads).toEqual(expect.arrayContaining([
      { subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}generatedBy`, object: '"Reviewer Bot"' },
    ]));
    expect(writes[0]!.quads.filter((quad) => quad.predicate === `${PROV}wasAttributedTo`)).toHaveLength(0);
  });

  it('escapes control bytes in direct semantic enrichment literal inputs', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-semantic-enrichment-control-literals';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent, writes } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
    });
    await startRoutes({ agent });

    const result = await post('/api/assertion/semantic-enrichment/write', {
      contextGraphId,
      assertionUri,
      semanticQuads: [
        {
          subject: 'urn:doc:imported',
          predicate: 'http://schema.org/about',
          object: 'Topic\u0000vertical\u000Bdel\u007F',
        },
      ],
      generationMethod: 'model\u0000unit\u007F',
      agentIdentity: 'Reviewer\u000BBot',
    });

    expect(result.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.quads).toEqual(expect.arrayContaining([
      { subject: 'urn:doc:imported', predicate: 'http://schema.org/about', object: '"Topic\\u0000vertical\\u000Bdel\\u007F"' },
      { subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}generationMethod`, object: '"model\\u0000unit\\u007F"' },
      { subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}generatedBy`, object: '"Reviewer\\u000BBot"' },
    ]));
    expect(writes[0]!.quads.filter((quad) => quad.predicate === `${PROV}wasAttributedTo`)).toHaveLength(0);
  });

  it('uses an existing DID request agent as fallback provenance without double-prefixing it', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-semantic-enrichment-default-agent';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent, writes } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
    });
    await startRoutes({ agent });

    const result = await post('/api/assertion/semantic-enrichment/write', {
      contextGraphId,
      assertionUri,
      semanticQuads: [
        { subject: 'urn:doc:imported', predicate: 'http://schema.org/about', object: 'Fallback topic' },
      ],
    });

    expect(result.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.quads).toEqual(expect.arrayContaining([
      { subject: 'urn:doc:imported', predicate: 'http://schema.org/about', object: '"Fallback topic"' },
      { subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}generatedBy`, object: 'did:dkg:agent:test' },
      { subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${PROV}wasAttributedTo`, object: 'did:dkg:agent:test' },
    ]));
    expect(writes[0]!.quads).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ object: 'did:dkg:agent:did:dkg:agent:test' }),
    ]));
  });

  it('does not create or discard assertions when same-assertion semantic append fails', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-semantic-enrichment-write-failure';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const events: unknown[] = [];
    const { agent, created, writes, discards } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
      publisherWriteError: new Error('simulated semantic write failure'),
    });
    await startRoutes({ agent, events });

    const result = await post('/api/assertion/semantic-enrichment/write', {
      contextGraphId,
      assertionUri,
      semanticQuads: [
        { subject: 'urn:doc:imported', predicate: 'http://schema.org/about', object: '"Semantic topic"' },
      ],
    });

    expect(result.status).toBe(500);
    expect(result.body.error).toBe('Unhandled test route error');
    expect(created).toEqual([]);
    expect(writes).toHaveLength(0);
    expect(discards).toEqual([]);
    expect(events).toEqual([]);
  });

  it('rejects target assertion names because enrichment appends to the source import assertion', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-semantic-enrichment-separate';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent, writes } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
    });
    await startRoutes({ agent });

    const result = await post('/api/assertion/semantic-enrichment/write', {
      contextGraphId,
      assertionUri,
      name: assertionName,
      semanticQuads: [
        { subject: 'urn:doc:imported', predicate: 'http://schema.org/about', object: '"Semantic topic"' },
      ],
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/target assertion names are not supported/);
    expect(writes).toHaveLength(0);
  });

  it('rejects semantic enrichment quads with graph fields instead of silently dropping them', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-semantic-enrichment-graph-reject';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent, writes } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
    });
    await startRoutes({ agent });

    const result = await post('/api/assertion/semantic-enrichment/write', {
      contextGraphId,
      assertionUri,
      semanticQuads: [
        {
          subject: 'urn:doc:imported',
          predicate: 'http://schema.org/about',
          object: '"Semantic topic"',
          graph: 'urn:graph:unexpected',
        },
      ],
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/graph is not supported/);
    expect(writes).toHaveLength(0);
  });

  it('rejects legacy semanticAssertionName target fields', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-semantic-enrichment-existing-target';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent, writes } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
    });
    await startRoutes({ agent });

    const result = await post('/api/assertion/semantic-enrichment/write', {
      contextGraphId,
      assertionUri,
      semanticAssertionName: 'semantic-imported-md',
      semanticQuads: [
        { subject: 'urn:doc:imported', predicate: 'http://schema.org/about', object: '"Semantic topic"' },
      ],
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/target assertion names are not supported/);
    expect(writes).toHaveLength(0);
  });

  it('rejects assertion markdownForm that points at a different hash than _meta', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-markdown-consistency';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:keccak256:${'0'.repeat(64)}`,
    });
    await startRoutes({ agent });

    const result = await post('/api/assertion/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
    });

    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/markdown hash does not match assertion markdownForm/);
  });

  it('rejects malformed assertion markdownForm instead of surfacing it as provenance', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-markdown-malformed';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: 'urn:dkg:file:not-a-content-hash',
    });
    await startRoutes({ agent });

    const result = await post('/api/assertion/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
    });

    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/markdown hash does not match assertion markdownForm/);
  });

  it('rejects any mismatched assertion markdownForm when multiple values are present', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-multiple-markdown-forms';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: [
        `urn:dkg:file:${entry.keccak256}`,
        `urn:dkg:file:keccak256:${'1'.repeat(64)}`,
      ],
    });
    await startRoutes({ agent });

    const result = await post('/api/assertion/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
    });

    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/markdown hash does not match assertion markdownForm/);
  });

  it('does not use transient extraction status as the authoritative Markdown intermediate hash', async () => {
    const originalEntry = await fileStore.put(Buffer.from('%PDF-1.4'), 'application/pdf');
    const markdownEntry = await fileStore.put(Buffer.from('# Converted\n'), 'text/markdown');
    const contextGraphId = 'cg-transient-md-hash';
    const assertionName = 'imported-pdf';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: originalEntry.keccak256,
      markdownHash: markdownEntry.keccak256,
      markdownForm: `urn:dkg:file:${markdownEntry.keccak256}`,
      contentType: 'application/pdf',
    });
    const extractionStatus = new Map<string, ExtractionStatusRecord>([
      [assertionUri, {
        status: 'completed',
        assertionName,
        assertionUri,
        fileHash: originalEntry.keccak256,
        fileName: 'imported.pdf',
        detectedContentType: 'application/pdf',
        pipelineUsed: 'application/pdf',
        tripleCount: 3,
        rootEntity: 'urn:doc:imported',
        mdIntermediateHash: markdownEntry.keccak256,
        startedAt: '2026-05-11T00:00:00.000Z',
        completedAt: '2026-05-11T00:00:01.000Z',
      }],
    ]);
    await startRoutes({ agent, extractionStatus });

    const result = await post('/api/assertion/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
    });

    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/markdown hash does not match assertion markdownForm/);
  });

  it('does not use transient extraction status as the authoritative native Markdown content type', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-transient-content-type';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
      contentType: null,
    });
    const extractionStatus = new Map<string, ExtractionStatusRecord>([
      [assertionUri, {
        status: 'completed',
        assertionName,
        assertionUri,
        fileHash: entry.keccak256,
        fileName: 'imported.md',
        detectedContentType: 'text/markdown',
        pipelineUsed: 'text/markdown',
        tripleCount: 3,
        rootEntity: 'urn:doc:imported',
        startedAt: '2026-05-11T00:00:00.000Z',
        completedAt: '2026-05-11T00:00:01.000Z',
      }],
    ]);
    await startRoutes({ agent, extractionStatus });

    const result = await post('/api/assertion/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
    });

    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/markdown hash does not match assertion markdownForm/);
  });

  it('rejects skipped imports and returns deterministic assertion quads in sorted order', async () => {
    const entry = await fileStore.put(Buffer.from('# Skipped\n'), 'text/markdown');
    const contextGraphId = 'cg-skipped-import';
    const assertionName = 'skipped-import';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
      extractionStatus: 'skipped',
    });
    const extractionStatus = new Map<string, ExtractionStatusRecord>([
      [assertionUri, {
        status: 'skipped',
        assertionName,
        assertionUri,
        fileHash: entry.keccak256,
        detectedContentType: 'application/octet-stream',
        pipelineUsed: null,
        tripleCount: 0,
        startedAt: '2026-05-11T00:00:00.000Z',
        completedAt: '2026-05-11T00:00:01.000Z',
      }],
    ]);
    await startRoutes({ agent, extractionStatus });

    const skipped = await post('/api/assertion/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
    });
    expect(skipped.status).toBe(409);
    expect(skipped.body.error).toMatch(/not a completed extraction/);

    const query = await post(`/api/assertion/${encodeURIComponent(assertionName)}/query`, {
      contextGraphId,
    });
    expect(query.status).toBe(200);
    expect(query.body.quads).toEqual([
      { subject: 'urn:a', predicate: 'urn:p', object: '"A"' },
      { subject: 'urn:z', predicate: 'urn:p', object: 'urn:o' },
    ]);
  });
});
