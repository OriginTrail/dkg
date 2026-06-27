import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DKG_CHUNK_INDEX,
  DKG_CHUNK_VALUE,
  DKG_HAS_TEXT_BODY,
  DKG_HAS_TEXT_CHUNK,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  contextGraphSharedMemoryUri,
  keccak256ContentHash,
  sharedMemoryReadBothFilter,
} from '@origintrail-official/dkg-core';
import { reconstructChunkedText } from '../../core/test/helpers/chunked-text.js';
import { FileStore } from '../src/file-store.js';
import type { ExtractionStatusRecord } from '../src/extraction-status.js';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';

const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';

type Quad = { subject: string; predicate: string; object: string; graph?: string };

function sha256Hash(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

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
        await handleKnowledgeAssetsRoutes({
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

  async function postMultipart(
    path: string,
    parts: Array<
      | { name: string; value: string }
      | { name: string; filename: string; contentType: string; value: string | Uint8Array }
    >,
  ) {
    const form = new FormData();
    for (const part of parts) {
      if ('filename' in part) {
        const bytes = typeof part.value === 'string' ? part.value : new Uint8Array(part.value);
        form.append(part.name, new Blob([bytes], { type: part.contentType }), part.filename);
      } else {
        form.append(part.name, part.value);
      }
    }
    const res = await fetch(`${baseUrl}${path}`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
  }

  async function get(path: string) {
    const res = await fetch(`${baseUrl}${path}`);
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
    omitImportMeta?: boolean;
    omitSharedMemoryArtifact?: boolean;
    allowedAgents?: string[];
    publisherCreateError?: Error;
    publisherWriteError?: Error;
    publisherDiscardError?: Error;
    targetGraphExists?: boolean;
    queryQuads?: Quad[];
    /**
     * Issue #872 — optional on-chain policy enum pair (`accessPolicy`,
     * `publishPolicy`) returned by the mock agent's
     * `getContextGraphOnChainPolicy`. When omitted, the method is not
     * exposed at all — exercising the "policy unknown, fail closed"
     * branch that preserves the legacy owner guard.
     */
    onChainPolicy?: { accessPolicy?: number; publishPolicy?: number };
    discoverAssertionArtifactCandidates?: (...args: any[]) => Promise<string[]>;
    fetchAndVerifyAssertionArtifact?: (...args: any[]) => Promise<any>;
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
    const insertedQuads: Quad[] = [];
    const queries: string[] = [];
    const queryQuads = args.queryQuads ?? [
      { subject: 'urn:z', predicate: 'urn:p', object: 'urn:o' },
      { subject: 'urn:a', predicate: 'urn:p', object: '"A"' },
    ];
    const agent: Record<string, unknown> = {
      async listContextGraphs() {
        return [{
          id: args.contextGraphId,
          uri: `did:dkg:context-graph:${args.contextGraphId}`,
          name: args.contextGraphId,
          subscribed: true,
          synced: true,
        }];
      },
      async contextGraphExists(contextGraphId: string) {
        return contextGraphId === args.contextGraphId;
      },
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
        async wmGraphUri(
          contextGraphId: string,
          agentAddress: string,
          name: string,
          subGraphName?: string,
        ) {
          return contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName);
        },
      },
      ...(args.onChainPolicy
        ? {
            async getContextGraphOnChainPolicy() {
              return args.onChainPolicy ?? {};
            },
          }
        : {}),
      ...(args.discoverAssertionArtifactCandidates
        ? { discoverAssertionArtifactCandidates: args.discoverAssertionArtifactCandidates }
        : {}),
      ...(args.fetchAndVerifyAssertionArtifact
        ? { fetchAndVerifyAssertionArtifact: args.fetchAndVerifyAssertionArtifact }
        : {}),
      async getContextGraphAllowedAgents(contextGraphId: string) {
        return contextGraphId === args.contextGraphId ? args.allowedAgents ?? [] : [];
      },
      async getContextGraphParticipantAgentAddresses(contextGraphId: string) {
        return contextGraphId === args.contextGraphId ? args.allowedAgents ?? [] : [];
      },
      store: {
        async hasGraph() {
          return Boolean(args.targetGraphExists);
        },
        async insert(quads: Quad[]) {
          insertedQuads.push(...quads);
        },
        async deleteByPattern() {
          return 0;
        },
        async dropGraph() {
          return undefined;
        },
        async query(sparql: string) {
          queries.push(sparql);
          if (sparql.includes('CONSTRUCT')) {
            return { type: 'quads', quads: [] };
          }
          if (sparql.includes('SELECT ?p ?o')) {
            return { type: 'bindings', bindings: [] };
          }
          if (sparql.includes('SELECT ?fileHash')) {
            expect(sparql).toContain(`<${contextGraphMetaUri(args.contextGraphId)}>`);
            expect(sparql).toContain(`<${args.assertionUri}> <${DKG}sourceFileHash>`);
            if (args.omitImportMeta) {
              return { type: 'bindings', bindings: [] };
            }
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
          if (sparql.includes('SELECT ?sourceFile')) {
            expect(sparql).toContain('GRAPH ?g');
            expect(sparql).toContain(sharedMemoryReadBothFilter(contextGraphSharedMemoryUri(args.contextGraphId)));
            expect(sparql).toContain(`<${args.assertionUri}> <${DKG}sourceFile>`);
            if (args.omitSharedMemoryArtifact) {
              return { type: 'bindings', bindings: [] };
            }
            return {
              type: 'bindings',
              bindings: [{
                sourceFile: `urn:dkg:file:${args.fileHash}`,
                ...(args.contentType !== null ? { contentType: args.contentType ?? 'text/markdown' } : {}),
                rootEntity: args.assertionUri,
                markdownForm: Array.isArray(args.markdownForm) ? args.markdownForm[0] : args.markdownForm,
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
    return { agent, created, writes, discards, queries, insertedQuads };
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

    const resolved = await post('/api/knowledge-assets/import-artifact/resolve', {
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

    const read = await post('/api/knowledge-assets/import-artifact/read-markdown', {
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

  it('wm/import-file chunks oversized schema:text through handleKaImportFile', async () => {
    const contextGraphId = 'cg-import-file-large-text';
    const assertionName = 'large-text-import';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent, insertedQuads } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: `keccak256:${'0'.repeat(64)}`,
      markdownHash: `keccak256:${'1'.repeat(64)}`,
      markdownForm: `urn:dkg:file:keccak256:${'1'.repeat(64)}`,
    });
    await startRoutes({ agent });

    const largeText = 'x'.repeat(60_000);
    const markdown = [
      '---',
      'id: route-large-text',
      `text: "${largeText}"`,
      '---',
      '',
      '# Large Text',
      '',
    ].join('\n');

    const result = await postMultipart(`/api/knowledge-assets/${assertionName}/wm/import-file`, [
      { name: 'contextGraphId', value: contextGraphId },
      { name: 'file', filename: 'large.md', contentType: 'text/markdown', value: markdown },
    ]);

    expect(result.status).toBe(200);
    expect(result.body.assertionUri).toBe(assertionUri);
    const assertionGraph = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const dataQuads = insertedQuads.filter((quad) => quad.graph === assertionGraph);
    expect(dataQuads.some((quad) =>
      quad.subject === assertionUri &&
      quad.predicate === 'http://schema.org/text'
    )).toBe(false);
    expect(dataQuads.some((quad) => quad.predicate === DKG_CHUNK_VALUE)).toBe(true);
    expect(reconstructChunkedText(dataQuads, assertionUri)).toBe(largeText);

    const chunkQuads = insertedQuads.filter((quad) =>
      quad.predicate === DKG_HAS_TEXT_BODY ||
      quad.predicate === DKG_HAS_TEXT_CHUNK ||
      quad.predicate === DKG_CHUNK_INDEX ||
      quad.predicate === DKG_CHUNK_VALUE
    );
    expect(chunkQuads.length).toBeGreaterThan(0);
    expect(chunkQuads.every((quad) => quad.graph === assertionGraph)).toBe(true);
    expect(insertedQuads.some((quad) =>
      quad.graph === contextGraphMetaUri(contextGraphId) &&
      quad.predicate === DKG_CHUNK_VALUE
    )).toBe(false);
  });

  it('reads a generic source artifact as bounded base64 bytes', async () => {
    const entry = await fileStore.put(Buffer.from('source bytes'), 'text/markdown');
    const contextGraphId = 'cg-generic-source-artifact';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
    });
    await startRoutes({ agent });

    const read = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash: entry.keccak256,
      offset: 0,
      maxBytes: 6,
    });

    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      status: 'local',
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash: entry.keccak256,
      contentType: 'text/markdown',
      size: Buffer.byteLength('source bytes'),
      offset: 0,
      nextOffset: 6,
      truncated: true,
      bytesB64: Buffer.from('source').toString('base64'),
    });

    const original = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'original',
      hash: entry.keccak256,
      offset: 7,
      maxBytes: 5,
    });
    expect(original.status).toBe(200);
    expect(original.body).toMatchObject({
      status: 'local',
      contextGraphId,
      assertionUri,
      kind: 'original',
      hash: entry.keccak256,
      offset: 7,
      truncated: false,
      bytesB64: Buffer.from('bytes').toString('base64'),
    });
  });

  it('reads a generic markdown artifact via mdIntermediateHash', async () => {
    const originalEntry = await fileStore.put(Buffer.from('%PDF-1.4'), 'application/pdf');
    const markdownEntry = await fileStore.put(Buffer.from('# Converted\n'), 'text/markdown');
    const contextGraphId = 'cg-generic-markdown-artifact';
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
      mdIntermediateHash: markdownEntry.keccak256,
    });
    await startRoutes({ agent });

    const read = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: markdownEntry.keccak256,
      maxBytes: 1024,
    });

    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      status: 'local',
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: markdownEntry.keccak256,
      contentType: 'text/markdown',
      truncated: false,
      bytesB64: Buffer.from('# Converted\n').toString('base64'),
    });
  });

  it('reports hash_mismatch for generic artifact hashes not linked to metadata', async () => {
    const entry = await fileStore.put(Buffer.from('source bytes'), 'text/markdown');
    const contextGraphId = 'cg-generic-artifact-mismatch';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
    });
    await startRoutes({ agent });

    const read = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: `keccak256:${'d'.repeat(64)}`,
    });

    expect(read.status).toBe(200);
    expect(read.body.status).toBe('hash_mismatch');

    const sourceRead = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash: `keccak256:${'e'.repeat(64)}`,
    });

    expect(sourceRead.status).toBe(200);
    expect(sourceRead.body.status).toBe('hash_mismatch');
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

    const resolved = await post('/api/knowledge-assets/import-artifact/resolve', {
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

    const read = await post('/api/knowledge-assets/import-artifact/read-markdown', {
      contextGraphId,
      assertionUri: legacyAssertionUri,
    });
    expect(read.status).toBe(200);
    expect(read.body.markdown).toBe('# Legacy Imported\n');

    const enriched = await post('/api/knowledge-assets/semantic-enrichment/write', {
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

    const result = await post('/api/knowledge-assets/import-artifact/resolve', {
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

      const result = await post('/api/knowledge-assets/import-artifact/resolve', {
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
    const discoverAssertionArtifactCandidates = vi.fn(async () => ['peer-with-blob']);
    const fetchAndVerifyAssertionArtifact = vi.fn();
    const { agent, queries } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
      discoverAssertionArtifactCandidates,
      fetchAndVerifyAssertionArtifact,
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

    const resolved = await post('/api/knowledge-assets/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
      fileHash: entry.keccak256,
    });
    expect(resolved.status).toBe(403);
    expect(resolved.body.error).toMatch(/owned by the requesting agent/);

    const read = await post('/api/knowledge-assets/import-artifact/read-markdown', {
      contextGraphId,
      assertionUri,
      maxBytes: 1024,
    });
    expect(read.status).toBe(403);
    expect(read.body.error).toMatch(/owned by the requesting agent/);

    const genericRead = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash: entry.keccak256,
      maxBytes: 4,
    });
    expect(genericRead.status).toBe(403);
    expect(genericRead.body.error).toMatch(/owned by the requesting agent/);
    expect(queries).toHaveLength(0);
    expect(discoverAssertionArtifactCandidates).not.toHaveBeenCalled();
    expect(fetchAndVerifyAssertionArtifact).not.toHaveBeenCalled();
  });

  // Issue #872 — public + open CGs gossip their SWM triples to every
  // subscribed peer, so the legacy owner guard at
  // `assertImportedArtifactOwnerAddress` contradicts the curator's
  // on-chain policy choice. The next three tests pin down the relaxed
  // shape: cross-agent reads succeed (200) when bytes are local, fail
  // cleanly (404) when bytes haven't been replicated, and the existing
  // 403 path stays in force for any other policy combo (covered above).
  it('allows non-owner reads on public + open CGs when bytes are locally available (#872)', async () => {
    const entry = await fileStore.put(Buffer.from('# Public Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-public-open-bytes-local';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
    });
    await startRoutes({ agent });

    const resolved = await post('/api/knowledge-assets/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
      fileHash: entry.keccak256,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.artifact).toMatchObject({
      assertionUri,
      assertionAgentAddress: 'did:dkg:agent:source',
      markdownHash: entry.keccak256,
      canReadMarkdown: true,
      ownerGuardRelaxed: true,
    });

    const read = await post('/api/knowledge-assets/import-artifact/read-markdown', {
      contextGraphId,
      assertionUri,
      maxBytes: 1024,
    });
    expect(read.status).toBe(200);
    expect(read.body.markdown).toBe('# Public Imported\n');
    expect(read.body.artifact.ownerGuardRelaxed).toBe(true);

    const genericRead = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: entry.keccak256,
      maxBytes: 1024,
    });
    expect(genericRead.status).toBe(200);
    expect(genericRead.body).toMatchObject({
      status: 'local',
      assertionUri,
      kind: 'markdown',
      hash: entry.keccak256,
      bytesB64: Buffer.from('# Public Imported\n').toString('base64'),
    });
  });

  it('returns 404 (not 403) for non-owner reads on public + open CGs when bytes are missing (#872)', async () => {
    // Use a deterministic, well-formed keccak256 hash that's never been
    // put into the test file store. The markdownForm URN matches the
    // meta `sourceFileHash`, so the 409 markdown-mismatch path stays
    // dormant — the only failure surface left is the file-store miss,
    // which is exactly the path peers will hit until source-artifact
    // bytes are gossipped (deferred follow-up for #872).
    const markdownHash = `keccak256:${'a'.repeat(64)}`;
    const contextGraphId = 'cg-public-open-bytes-missing';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: markdownHash,
      markdownHash,
      markdownForm: `urn:dkg:file:${markdownHash}`,
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
    });
    await startRoutes({ agent });

    const resolved = await post('/api/knowledge-assets/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.artifact.ownerGuardRelaxed).toBe(true);

    const read = await post('/api/knowledge-assets/import-artifact/read-markdown', {
      contextGraphId,
      assertionUri,
      maxBytes: 1024,
    });
    expect(read.status).toBe(404);
    expect(read.body.error).toMatch(/not replicated locally/);
    expect(read.body.error).not.toMatch(/owned by the requesting agent/);
    expect(read.body.artifact.ownerGuardRelaxed).toBe(true);
  });

  it('fetches a public + open imported artifact from a discovered peer when sourcePeerId is omitted, then serves the second read locally', async () => {
    const bytes = Buffer.from('# Discovered Public\n');
    const artifactHash = sha256Hash(bytes);
    const contextGraphId = 'cg-public-open-discovered-byte-read';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const discoverAssertionArtifactCandidates = vi.fn(async () => ['peer-with-blob']);
    const fetchAndVerifyAssertionArtifact = vi.fn(async () => ({
      response: {
        version: 1,
        contextGraphId,
        assertionUri,
        kind: 'markdown',
        hash: artifactHash,
        offset: 0,
        totalBytes: bytes.length,
        truncated: false,
        contentType: 'application/x-spoofed',
        bytesB64: bytes.toString('base64'),
      },
      verifiedBytes: bytes,
    }));
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: artifactHash,
      markdownHash: artifactHash,
      markdownForm: `urn:dkg:file:${artifactHash}`,
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
      discoverAssertionArtifactCandidates,
      fetchAndVerifyAssertionArtifact,
    });
    await startRoutes({ agent });

    const fetched = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      maxBytes: 1024,
    });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({
      status: 'fetched',
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      contentType: 'text/markdown',
      bytesB64: bytes.toString('base64'),
      source: { peerId: 'peer-with-blob', agentAddress: 'did:dkg:agent:source' },
    });
    expect(discoverAssertionArtifactCandidates).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
    }));
    expect(fetchAndVerifyAssertionArtifact).toHaveBeenCalledWith(expect.objectContaining({
      sourcePeerId: 'peer-with-blob',
      cache: true,
    }));

    const local = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      maxBytes: 1024,
    });
    expect(local.status).toBe(200);
    expect(local.body).toMatchObject({
      status: 'local',
      hash: artifactHash,
      bytesB64: bytes.toString('base64'),
    });
    expect(fetchAndVerifyAssertionArtifact).toHaveBeenCalledTimes(1);
  });

  it('cache-promotes a discovered peer artifact under its keccak256 graph hash', async () => {
    const bytes = Buffer.from('# Discovered Public Keccak\n');
    const artifactHash = keccak256ContentHash(bytes);
    const contextGraphId = 'cg-public-open-discovered-keccak-byte-read';
    const assertionName = 'imported-md-keccak';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const discoverAssertionArtifactCandidates = vi.fn(async () => ['peer-with-keccak-blob']);
    const fetchAndVerifyAssertionArtifact = vi.fn(async () => ({
      response: {
        version: 1,
        contextGraphId,
        assertionUri,
        kind: 'markdown',
        hash: artifactHash,
        offset: 0,
        totalBytes: bytes.length,
        truncated: false,
        contentType: 'application/x-spoofed',
        bytesB64: bytes.toString('base64'),
      },
      verifiedBytes: bytes,
    }));
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: artifactHash,
      markdownHash: artifactHash,
      markdownForm: `urn:dkg:file:${artifactHash}`,
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
      discoverAssertionArtifactCandidates,
      fetchAndVerifyAssertionArtifact,
    });
    await startRoutes({ agent });

    const fetched = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      maxBytes: 1024,
    });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({
      status: 'fetched',
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      contentType: 'text/markdown',
      bytesB64: bytes.toString('base64'),
      source: { peerId: 'peer-with-keccak-blob', agentAddress: 'did:dkg:agent:source' },
    });
    await expect(fileStore.get(artifactHash)).resolves.toEqual(bytes);

    const local = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      maxBytes: 1024,
    });
    expect(local.status).toBe(200);
    expect(local.body).toMatchObject({
      status: 'local',
      hash: artifactHash,
      bytesB64: bytes.toString('base64'),
    });
    expect(fetchAndVerifyAssertionArtifact).toHaveBeenCalledTimes(1);
  });

  it('lets an assertion owner fetch explicit remote bytes before local metadata has replicated', async () => {
    const bytes = Buffer.from('# Private Owner Remote\n');
    const artifactHash = keccak256ContentHash(bytes);
    const contextGraphId = 'cg-private-owner-explicit-remote-read';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const fetchAndVerifyAssertionArtifact = vi.fn(async () => ({
      response: {
        version: 1,
        contextGraphId,
        assertionUri,
        kind: 'source',
        hash: artifactHash,
        offset: 0,
        totalBytes: bytes.length,
        truncated: false,
        contentType: 'application/x-spoofed',
        bytesB64: bytes.toString('base64'),
      },
      verifiedBytes: bytes,
    }));
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: artifactHash,
      markdownHash: artifactHash,
      markdownForm: `urn:dkg:file:${artifactHash}`,
      omitImportMeta: true,
      omitSharedMemoryArtifact: true,
      fetchAndVerifyAssertionArtifact,
    });
    await startRoutes({ agent });

    const fetched = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash: artifactHash,
      sourcePeerId: 'peer-with-private-blob',
      maxBytes: 1024,
    });

    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({
      status: 'fetched',
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash: artifactHash,
      contentType: 'application/octet-stream',
      bytesB64: bytes.toString('base64'),
      source: { peerId: 'peer-with-private-blob', agentAddress: 'did:dkg:agent:test' },
    });
    expect(fetchAndVerifyAssertionArtifact).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      assertionUri,
      kind: 'source',
      hash: artifactHash,
      sourcePeerId: 'peer-with-private-blob',
      requestingAgentAddress: 'did:dkg:agent:test',
      cache: true,
    }));
    await expect(fileStore.get(artifactHash)).resolves.toEqual(bytes);
  });

  it('lets an allowlisted private CG member fetch imported artifact bytes from the owner peer', async () => {
    const bytes = Buffer.from('# Private Allowlisted Remote\n');
    const artifactHash = keccak256ContentHash(bytes);
    const contextGraphId = 'cg-private-allowlisted-byte-read';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const fetchAndVerifyAssertionArtifact = vi.fn(async () => ({
      response: {
        version: 1,
        contextGraphId,
        assertionUri,
        kind: 'markdown',
        hash: artifactHash,
        offset: 0,
        totalBytes: bytes.length,
        truncated: false,
        contentType: 'text/markdown',
        bytesB64: bytes.toString('base64'),
      },
      verifiedBytes: bytes,
    }));
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: artifactHash,
      markdownHash: artifactHash,
      markdownForm: `urn:dkg:file:${artifactHash}`,
      allowedAgents: ['did:dkg:agent:test'],
      fetchAndVerifyAssertionArtifact,
    });
    await startRoutes({ agent });

    const fetched = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      sourcePeerId: 'peer-owner',
      maxBytes: 1024,
    });

    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({
      status: 'fetched',
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      contentType: 'text/markdown',
      bytesB64: bytes.toString('base64'),
      source: { peerId: 'peer-owner', agentAddress: 'did:dkg:agent:source' },
    });
    expect(fetchAndVerifyAssertionArtifact).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      sourcePeerId: 'peer-owner',
      requestingAgentAddress: 'did:dkg:agent:test',
      cache: true,
    }));
    await expect(fileStore.get(artifactHash)).resolves.toEqual(bytes);
  });

  it('fetches verified Markdown remotely for an allowlisted private CG member before returning 404', async () => {
    const bytes = Buffer.from('# Private Allowlisted Markdown\n');
    const artifactHash = keccak256ContentHash(bytes);
    const contextGraphId = 'cg-private-allowlisted-markdown-read';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const fetchAndVerifyAssertionArtifact = vi.fn(async () => ({
      response: {
        version: 1,
        contextGraphId,
        assertionUri,
        kind: 'markdown',
        hash: artifactHash,
        offset: 0,
        totalBytes: bytes.length,
        truncated: false,
        contentType: 'text/markdown',
        bytesB64: bytes.toString('base64'),
      },
      verifiedBytes: bytes,
    }));
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: artifactHash,
      markdownHash: artifactHash,
      markdownForm: `urn:dkg:file:${artifactHash}`,
      allowedAgents: ['did:dkg:agent:test'],
      fetchAndVerifyAssertionArtifact,
    });
    await startRoutes({ agent });

    const read = await post('/api/knowledge-assets/import-artifact/read-markdown', {
      contextGraphId,
      assertionUri,
      sourcePeerId: 'peer-owner',
      maxBytes: 1024,
    });

    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      markdownHash: artifactHash,
      contentType: 'text/markdown',
      bytes: bytes.length,
      markdown: bytes.toString('utf8'),
      source: { peerId: 'peer-owner', agentAddress: 'did:dkg:agent:source' },
    });
    expect(fetchAndVerifyAssertionArtifact).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      sourcePeerId: 'peer-owner',
      requestingAgentAddress: 'did:dkg:agent:test',
      cache: true,
    }));
    await expect(fileStore.get(artifactHash)).resolves.toEqual(bytes);
  });

  it('fetches verified Markdown remotely for an allowlisted private CG member using synced shared-memory metadata', async () => {
    const bytes = Buffer.from('# Private Synced Metadata Markdown\n');
    const artifactHash = keccak256ContentHash(bytes);
    const contextGraphId = 'cg-private-allowlisted-swm-metadata-read';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const fetchAndVerifyAssertionArtifact = vi.fn(async () => ({
      response: {
        version: 1,
        contextGraphId,
        assertionUri,
        kind: 'markdown',
        hash: artifactHash,
        offset: 0,
        totalBytes: bytes.length,
        truncated: false,
        contentType: 'text/markdown',
        bytesB64: bytes.toString('base64'),
      },
      verifiedBytes: bytes,
    }));
    const { agent, queries } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: artifactHash,
      markdownHash: artifactHash,
      markdownForm: `urn:dkg:file:${artifactHash}`,
      allowedAgents: ['did:dkg:agent:test'],
      omitImportMeta: true,
      fetchAndVerifyAssertionArtifact,
    });
    await startRoutes({ agent });

    const read = await post('/api/knowledge-assets/import-artifact/read-markdown', {
      contextGraphId,
      assertionUri,
      sourcePeerId: 'peer-owner',
      maxBytes: 1024,
    });

    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      markdownHash: artifactHash,
      contentType: 'text/markdown',
      bytes: bytes.length,
      markdown: bytes.toString('utf8'),
      source: { peerId: 'peer-owner', agentAddress: 'did:dkg:agent:source' },
    });
    expect(queries.some((sparql) => sparql.includes('SELECT ?sourceFile'))).toBe(true);
    expect(fetchAndVerifyAssertionArtifact).toHaveBeenCalledWith(expect.objectContaining({
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      sourcePeerId: 'peer-owner',
      requestingAgentAddress: 'did:dkg:agent:test',
      cache: true,
    }));
    await expect(fileStore.get(artifactHash)).resolves.toEqual(bytes);
  });

  it('does not cache oversized verified remote Markdown when read-markdown returns 413', async () => {
    const bytes = Buffer.from('# Too Large\n');
    const artifactHash = keccak256ContentHash(bytes);
    const contextGraphId = 'cg-private-oversized-markdown-read';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const fetchAndVerifyAssertionArtifact = vi.fn(async () => ({
      response: {
        version: 1,
        contextGraphId,
        assertionUri,
        kind: 'markdown',
        hash: artifactHash,
        offset: 0,
        totalBytes: bytes.length,
        truncated: false,
        contentType: 'text/markdown',
        bytesB64: bytes.toString('base64'),
      },
      verifiedBytes: bytes,
    }));
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: artifactHash,
      markdownHash: artifactHash,
      markdownForm: `urn:dkg:file:${artifactHash}`,
      allowedAgents: ['did:dkg:agent:test'],
      fetchAndVerifyAssertionArtifact,
    });
    await startRoutes({ agent });

    const read = await post('/api/knowledge-assets/import-artifact/read-markdown', {
      contextGraphId,
      assertionUri,
      sourcePeerId: 'peer-owner',
      maxBytes: bytes.length - 1,
    });

    expect(read.status).toBe(413);
    expect(read.body).toMatchObject({
      error: `Markdown content exceeds maxBytes (${bytes.length - 1})`,
      bytes: bytes.length,
    });
    await expect(fileStore.get(artifactHash)).resolves.toBeNull();
  });

  it('serves a remote artifact page even when the full artifact is not cache-promoted', async () => {
    const bytes = Buffer.from('remote page bytes');
    const artifactHash = sha256Hash(bytes);
    const contextGraphId = 'cg-public-open-large-page-read';
    const assertionName = 'large-imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const discoverAssertionArtifactCandidates = vi.fn(async () => ['peer-with-large-blob']);
    const fetchAndVerifyAssertionArtifact = vi.fn(async () => ({
      response: {
        version: 1,
        contextGraphId,
        assertionUri,
        kind: 'markdown',
        hash: artifactHash,
        offset: 1024,
        totalBytes: 64 * 1024 * 1024 + 1,
        nextOffset: 1024 + bytes.length,
        truncated: true,
        contentType: 'text/markdown',
        bytesB64: bytes.toString('base64'),
      },
    }));
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: artifactHash,
      markdownHash: artifactHash,
      markdownForm: `urn:dkg:file:${artifactHash}`,
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
      discoverAssertionArtifactCandidates,
      fetchAndVerifyAssertionArtifact,
    });
    await startRoutes({ agent });

    const fetched = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      offset: 1024,
      maxBytes: 4096,
      cache: false,
    });

    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({
      status: 'unverified',
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      offset: 1024,
      bytesB64: bytes.toString('base64'),
      source: { peerId: 'peer-with-large-blob', agentAddress: 'did:dkg:agent:source' },
      reason: 'Remote page fetched without full-artifact hash verification',
    });
    expect(fetchAndVerifyAssertionArtifact).toHaveBeenCalledWith(expect.objectContaining({
      sourcePeerId: 'peer-with-large-blob',
      offset: 1024,
      maxBytes: 4096,
      cache: false,
      requestingAgentAddress: 'did:dkg:agent:test',
    }));
  });

  it('rejects a poisoned discovered candidate and falls back to another peer before cache promotion', async () => {
    const bytes = Buffer.from('# Good Candidate\n');
    const artifactHash = sha256Hash(bytes);
    const contextGraphId = 'cg-public-open-discovered-poison-fallback';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const discoverAssertionArtifactCandidates = vi.fn(async () => ['peer-poisoned', 'peer-good']);
    const fetchAndVerifyAssertionArtifact = vi.fn(async (params: { sourcePeerId: string }) => {
      if (params.sourcePeerId === 'peer-poisoned') {
        return {
          response: {
            version: 1,
            contextGraphId,
            assertionUri,
            kind: 'markdown',
            hash: artifactHash,
            offset: 0,
            hashMismatch: true,
          },
        };
      }
      return {
        response: {
          version: 1,
          contextGraphId,
          assertionUri,
          kind: 'markdown',
          hash: artifactHash,
          offset: 0,
          totalBytes: bytes.length,
          truncated: false,
          contentType: 'text/markdown',
          bytesB64: bytes.toString('base64'),
        },
        verifiedBytes: bytes,
      };
    });
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: artifactHash,
      markdownHash: artifactHash,
      markdownForm: `urn:dkg:file:${artifactHash}`,
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
      discoverAssertionArtifactCandidates,
      fetchAndVerifyAssertionArtifact,
    });
    await startRoutes({ agent });

    const read = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      maxBytes: 1024,
    });

    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      status: 'fetched',
      hash: artifactHash,
      bytesB64: bytes.toString('base64'),
      source: { peerId: 'peer-good' },
    });
    expect(fetchAndVerifyAssertionArtifact.mock.calls.map(([params]) => params.sourcePeerId)).toEqual([
      'peer-poisoned',
      'peer-good',
    ]);
    await expect(fileStore.get(artifactHash)).resolves.toEqual(bytes);
  });

  it('prefers a later verified peer over an earlier unverified remote page', async () => {
    const bytes = Buffer.from('# Verified Candidate\n');
    const artifactHash = sha256Hash(bytes);
    const contextGraphId = 'cg-public-open-discovered-unverified-fallback';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const discoverAssertionArtifactCandidates = vi.fn(async () => ['peer-unverified', 'peer-verified']);
    const fetchAndVerifyAssertionArtifact = vi.fn(async (params: { sourcePeerId: string }) => ({
      response: {
        version: 1,
        contextGraphId,
        assertionUri,
        kind: 'markdown',
        hash: artifactHash,
        offset: 0,
        totalBytes: bytes.length,
        truncated: false,
        contentType: 'text/markdown',
        bytesB64: bytes.toString('base64'),
      },
      ...(params.sourcePeerId === 'peer-verified' ? { verifiedBytes: bytes } : {}),
    }));
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: artifactHash,
      markdownHash: artifactHash,
      markdownForm: `urn:dkg:file:${artifactHash}`,
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
      discoverAssertionArtifactCandidates,
      fetchAndVerifyAssertionArtifact,
    });
    await startRoutes({ agent });

    const read = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      maxBytes: 1024,
    });

    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      status: 'fetched',
      hash: artifactHash,
      bytesB64: bytes.toString('base64'),
      source: { peerId: 'peer-verified' },
    });
    expect(fetchAndVerifyAssertionArtifact.mock.calls.map(([params]) => params.sourcePeerId)).toEqual([
      'peer-unverified',
      'peer-verified',
    ]);
    await expect(fileStore.get(artifactHash)).resolves.toEqual(bytes);
  });

  it('uses an unverified remote page fallback after an earlier unavailable peer', async () => {
    const bytes = Buffer.from('late unverified page bytes');
    const artifactHash = sha256Hash(bytes);
    const contextGraphId = 'cg-public-open-unavailable-then-unverified';
    const assertionName = 'large-imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const discoverAssertionArtifactCandidates = vi.fn(async () => ['peer-dead', 'peer-page']);
    const fetchAndVerifyAssertionArtifact = vi.fn(async (params: { sourcePeerId: string }) => {
      if (params.sourcePeerId === 'peer-dead') {
        return {
          response: {
            version: 1,
            contextGraphId,
            assertionUri,
            kind: 'markdown',
            hash: artifactHash,
            offset: 1024,
            unavailable: true,
          },
        };
      }
      return {
        response: {
          version: 1,
          contextGraphId,
          assertionUri,
          kind: 'markdown',
          hash: artifactHash,
          offset: 1024,
          totalBytes: 64 * 1024 * 1024 + 1,
          nextOffset: 1024 + bytes.length,
          truncated: true,
          contentType: 'text/markdown',
          bytesB64: bytes.toString('base64'),
        },
      };
    });
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: artifactHash,
      markdownHash: artifactHash,
      markdownForm: `urn:dkg:file:${artifactHash}`,
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
      discoverAssertionArtifactCandidates,
      fetchAndVerifyAssertionArtifact,
    });
    await startRoutes({ agent });

    const read = await post('/api/knowledge-assets/import-artifact/read', {
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      offset: 1024,
      maxBytes: 4096,
      cache: false,
    });

    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      status: 'unverified',
      contextGraphId,
      assertionUri,
      kind: 'markdown',
      hash: artifactHash,
      offset: 1024,
      bytesB64: bytes.toString('base64'),
      source: { peerId: 'peer-page', agentAddress: 'did:dkg:agent:source' },
      reason: 'Remote page fetched without full-artifact hash verification',
    });
    expect(fetchAndVerifyAssertionArtifact.mock.calls.map(([params]) => params.sourcePeerId)).toEqual([
      'peer-dead',
      'peer-page',
    ]);
  });

  it('derives non-owner public + open read metadata from replicated SWM linkage when _meta is absent (#872 devnet)', async () => {
    // Devnet peers receive the promoted SWM assertion triples but do not
    // receive the origin node's CG-root `_meta` rows. The read route should
    // still resolve enough metadata from the promoted source-file linkage to
    // report the policy-relaxed artifact, then honestly 404 on missing bytes.
    const markdownHash = `keccak256:${'b'.repeat(64)}`;
    const contextGraphId = 'cg-public-open-swm-linkage-only';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: markdownHash,
      markdownHash,
      markdownForm: `urn:dkg:file:${markdownHash}`,
      omitImportMeta: true,
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
    });
    await startRoutes({ agent });

    const resolved = await post('/api/knowledge-assets/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.artifact).toMatchObject({
      assertionUri,
      assertionAgentAddress: 'did:dkg:agent:source',
      sourceFileHash: markdownHash,
      markdownHash,
      canReadMarkdown: false,
      ownerGuardRelaxed: true,
    });

    const read = await post('/api/knowledge-assets/import-artifact/read-markdown', {
      contextGraphId,
      assertionUri,
      maxBytes: 1024,
    });
    expect(read.status).toBe(404);
    expect(read.body.error).toMatch(/not replicated locally/);
    expect(read.body.error).not.toMatch(/owned by the requesting agent/);
    expect(read.body.artifact.ownerGuardRelaxed).toBe(true);
  });

  it('keeps the owner guard in force when a non-owner reads from a CG that is public but curators-only (#872)', async () => {
    // Mixed policy: accessPolicy=0 (public discovery) but publishPolicy=0
    // (curators-only). Only `accessPolicy===0 && publishPolicy===1`
    // relaxes the guard; this combo MUST still 403.
    const entry = await fileStore.put(Buffer.from('# Mixed Policy\n'), 'text/markdown');
    const contextGraphId = 'cg-public-curators-only';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const { agent, queries } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
      onChainPolicy: { accessPolicy: 0, publishPolicy: 0 },
    });
    await startRoutes({ agent });

    const resolved = await post('/api/knowledge-assets/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
    });
    expect(resolved.status).toBe(403);
    expect(resolved.body.error).toMatch(/owned by the requesting agent/);
    expect(queries).toHaveLength(0);
  });

  it('does not surface ownerGuardRelaxed for owner reads on public + open CGs (#872)', async () => {
    const entry = await fileStore.put(Buffer.from('# Owner Public\n'), 'text/markdown');
    const contextGraphId = 'cg-public-open-owner';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
    });
    await startRoutes({ agent });

    const resolved = await post('/api/knowledge-assets/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.artifact.ownerGuardRelaxed).toBeUndefined();
  });

  // Issue #872 / Codex review finding 1: the public + open relaxation
  // is opt-in via `relaxOnPublicOpenCg: true` and ONLY the two read
  // routes set it. The semantic-enrichment WRITE route must continue
  // to reject cross-agent writes regardless of the CG's on-chain
  // policy — otherwise a non-owner peer on a public + open CG could
  // mutate someone else's imported assertion graph.
  it('rejects non-owner semantic enrichment writes on public + open CGs (#872 Codex finding 1)', async () => {
    const entry = await fileStore.put(Buffer.from('# Public Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-public-open-write-rejected';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const { agent, writes, queries } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
    });
    await startRoutes({ agent });

    const enriched = await post('/api/knowledge-assets/semantic-enrichment/write', {
      contextGraphId,
      assertionUri,
      semanticQuads: [
        { subject: 'urn:doc:imported', predicate: 'http://schema.org/about', object: '"Cross-agent topic"' },
      ],
    });

    expect(enriched.status).toBe(403);
    expect(enriched.body.error).toMatch(/owned by the requesting agent/);
    expect(writes).toHaveLength(0);
    // Sanity: short-circuit before any SPARQL — the strict guard
    // fires the moment the URI is parsed, just like the legacy code
    // path for curated CGs.
    expect(queries).toHaveLength(0);
  });

  // Issue #872 / Codex review round 2, finding A: the round-1 fix
  // unconditionally rejected legacy ownerless URIs on public + open
  // CGs with 400. That broke owner self-reads — the existing legacy
  // back-compat path canonicalizes the missing owner segment to the
  // requester, which is correct for the owner. The round-2 fix
  // skips the relaxation entirely for legacy URIs and lets the
  // strict guard run; for owner self-reads the legacy fallback
  // makes the strict guard a no-op so the read completes normally.
  it('lets owner self-reads of legacy ownerless URIs through on public + open CGs (#872 Codex round 2 finding A)', async () => {
    const entry = await fileStore.put(Buffer.from('# Legacy Owner Public\n'), 'text/markdown');
    const contextGraphId = 'cg-public-open-legacy-owner-self-read';
    const assertionName = 'legacy-md';
    const legacyAssertionUri = `did:dkg:context-graph:${contextGraphId}/assertion/${assertionName}`;
    // The mock's requestAgentAddress is `did:dkg:agent:test`. The
    // legacy fallback canonicalizes the missing owner segment to
    // that address, so the stored canonical URI is keyed by the
    // requester (i.e. owner self-read).
    const canonicalAssertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const { agent } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri: canonicalAssertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
    });
    await startRoutes({ agent });

    const resolved = await post('/api/knowledge-assets/import-artifact/resolve', {
      contextGraphId,
      assertionUri: legacyAssertionUri,
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.artifact).toMatchObject({
      contextGraphId,
      assertionUri: canonicalAssertionUri,
      assertionAgentAddress: 'did:dkg:agent:test',
      assertionName,
      markdownHash: entry.keccak256,
    });
    // Owner self-read: the relaxation does NOT apply (it's gated on
    // `!parsedAssertion.legacy`) so `ownerGuardRelaxed` is absent.
    expect(resolved.body.artifact.ownerGuardRelaxed).toBeUndefined();

    const read = await post('/api/knowledge-assets/import-artifact/read-markdown', {
      contextGraphId,
      assertionUri: legacyAssertionUri,
    });
    expect(read.status).toBe(200);
    expect(read.body.markdown).toBe('# Legacy Owner Public\n');
  });

  // Issue #872 / Codex review round 2, finding A — companion test
  // for the cross-agent half. Non-owner peers sending a legacy
  // ownerless URI on a public + open CG: the relaxation does not
  // apply (legacy URIs always go through the strict guard); the
  // legacy fallback canonicalizes to the requester's address, the
  // strict guard equality check passes (requester == requester),
  // and the meta SPARQL then misses because the actual owner is
  // someone else. Caller gets the pre-PR 404 "no metadata"
  // back-compat response — same as before the relaxation existed.
  it('returns 4xx (no misleading 200) for cross-agent legacy ownerless reads on public + open CGs (#872 Codex round 2 finding A)', async () => {
    const entry = await fileStore.put(Buffer.from('# Legacy Public\n'), 'text/markdown');
    const contextGraphId = 'cg-public-open-legacy-cross-agent';
    const assertionName = 'legacy-md';
    const legacyAssertionUri = `did:dkg:context-graph:${contextGraphId}/assertion/${assertionName}`;
    // The mock has metadata keyed by `did:dkg:agent:source`; the
    // requester is `did:dkg:agent:test`. The legacy fallback
    // canonicalizes to `.../assertion/did:dkg:agent:test/legacy-md`
    // which DOES NOT match the mock's stored URI — i.e. the
    // canonical-URI-pointing-at-wrong-owner case Codex flagged.
    const canonicalAssertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const { agent, queries } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri: canonicalAssertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
      onChainPolicy: { accessPolicy: 0, publishPolicy: 1 },
    });

    // Tolerate URI mismatch on the meta SPARQL: return empty
    // bindings when the query targets a URI other than the stored
    // one. Mirrors how the real Oxigraph store would respond.
    const storeAny = agent.store as unknown as { query: (sparql: string) => Promise<unknown> };
    const originalQuery = storeAny.query.bind(agent.store);
    storeAny.query = async (sparql: string) => {
      if (sparql.includes('SELECT ?fileHash') && !sparql.includes(canonicalAssertionUri)) {
        queries.push(sparql);
        return { type: 'bindings', bindings: [] } as never;
      }
      return originalQuery(sparql);
    };

    await startRoutes({ agent });

    const read = await post('/api/knowledge-assets/import-artifact/read-markdown', {
      contextGraphId,
      assertionUri: legacyAssertionUri,
      maxBytes: 1024,
    });
    expect(read.status).toBe(404);
    expect(read.body.error).toMatch(/No completed import metadata/);
    // The SPARQL that ran targeted the requester-canonicalized URI,
    // not the stored owner URI — this is what Codex flagged as
    // "silently canonicalizes to the wrong assertion URI". The 404
    // is the pre-PR back-compat behaviour.
    expect(queries.some((q) => q.includes('did%3Adkg%3Aagent%3Atest') || q.includes('did:dkg:agent:test'))).toBe(true);
  });

  // Issue #872 / Codex review round 2, finding B: the dkg-agent
  // local-policy fallback used to mark unregistered locally-created
  // CGs as public + open by reading the create-time
  // `dkg:publishPolicy` / `dkg:accessPolicy` triples that
  // `createContextGraph` writes BEFORE on-chain registration. That
  // bypassed the owner guard on CGs that hadn't actually been
  // committed on-chain yet. The fix in `dkg-agent.ts` gates the
  // local fallback on `isContextGraphRegistered`, so unregistered
  // CGs return `{}` and the daemon route fails closed.
  //
  // This test simulates the post-fix agent contract — the mock's
  // `getContextGraphOnChainPolicy` returns `{}` (matching what the
  // fixed agent returns for an unregistered CG) and asserts the
  // route preserves the strict guard for a non-owner cross-agent
  // request. The corresponding unit test for the agent method
  // itself lives in `packages/agent/test/dkg-agent-on-chain-policy.test.ts`.
  it('keeps the owner guard in force when on-chain policy is unknown (e.g. CG not yet registered) (#872 Codex round 2 finding B)', async () => {
    const entry = await fileStore.put(Buffer.from('# Unregistered\n'), 'text/markdown');
    const contextGraphId = 'cg-locally-created-not-registered';
    const assertionName = 'imported-md';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:source', assertionName);
    const { agent, queries } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
      // Post-fix agent contract: an unregistered CG resolves to
      // `{}` regardless of the local create-time triples. The
      // daemon route sees `accessPolicy=undefined,
      // publishPolicy=undefined`, isPublicOpen evaluates to false,
      // and the strict guard fires for the non-owner request.
      onChainPolicy: {},
    });
    await startRoutes({ agent });

    const resolved = await post('/api/knowledge-assets/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
    });
    expect(resolved.status).toBe(403);
    expect(resolved.body.error).toMatch(/owned by the requesting agent/);
    // The guard short-circuits before any SPARQL: no leak about
    // the unregistered CG's contents.
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

    const result = await post('/api/knowledge-assets/import-artifact/resolve', {
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

    const result = await post('/api/knowledge-assets/semantic-enrichment/write', {
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
      expect.objectContaining({ subject: 'urn:doc:imported', predicate: 'http://schema.org/about', object: '"Semantic topic"' }),
      expect.objectContaining({ subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}sourceAssertion`, object: assertionUri }),
      expect.objectContaining({ subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}sourceFileHash`, object: `"${entry.keccak256}"` }),
      expect.objectContaining({ subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}markdownHash`, object: `"${entry.keccak256}"` }),
      expect.objectContaining({ subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}markdownForm`, object: markdownForm }),
      expect.objectContaining({ subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}generationMethod`, object: '"unit-test-model"' }),
      expect.objectContaining({ subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}generatedBy`, object: 'did:dkg:agent:reviewer' }),
      expect.objectContaining({ subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${PROV}wasAttributedTo`, object: 'did:dkg:agent:reviewer' }),
      expect.objectContaining({ subject: 'urn:doc:imported', predicate: `${PROV}wasDerivedFrom`, object: assertionUri }),
    ]));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'semantic_enrichment_written', layers: ['wm'] }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'assertion_created', layers: ['wm'] }),
    ]));
  });

  it('chunks oversized semantic enrichment schema:text before assertion write', async () => {
    const entry = await fileStore.put(Buffer.from('# Imported\n'), 'text/markdown');
    const contextGraphId = 'cg-semantic-enrichment-large-text';
    const assertionName = 'imported-large-text';
    const assertionUri = contextGraphAssertionUri(contextGraphId, 'did:dkg:agent:test', assertionName);
    const largeText = 'x'.repeat(60_000);
    const { agent, writes } = makeAgent({
      contextGraphId,
      assertionName,
      assertionUri,
      fileHash: entry.keccak256,
      markdownHash: entry.keccak256,
      markdownForm: `urn:dkg:file:${entry.keccak256}`,
    });
    await startRoutes({ agent });

    const result = await post('/api/knowledge-assets/semantic-enrichment/write', {
      contextGraphId,
      assertionUri,
      semanticQuads: [
        { subject: 'urn:doc:semantic-large', predicate: 'http://schema.org/text', object: `"${largeText}"` },
      ],
    });

    expect(result.status).toBe(200);
    expect(writes).toHaveLength(1);
    const written = writes[0]!.quads;
    expect(written.some((quad) =>
      quad.subject === 'urn:doc:semantic-large' &&
      quad.predicate === 'http://schema.org/text'
    )).toBe(false);
    expect(written.some((quad) => quad.predicate === DKG_CHUNK_VALUE)).toBe(true);
    expect(reconstructChunkedText(written, 'urn:doc:semantic-large')).toBe(largeText);
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

    const result = await post('/api/knowledge-assets/semantic-enrichment/write', {
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

    const result = await post('/api/knowledge-assets/semantic-enrichment/write', {
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
      expect.objectContaining({ subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}generatedBy`, object: '"Reviewer Bot"' }),
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

    const result = await post('/api/knowledge-assets/semantic-enrichment/write', {
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
      expect.objectContaining({ subject: 'urn:doc:imported', predicate: 'http://schema.org/about', object: '"Topic\\u0000vertical\\u000Bdel\\u007F"' }),
      expect.objectContaining({ subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}generationMethod`, object: '"model\\u0000unit\\u007F"' }),
      expect.objectContaining({ subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}generatedBy`, object: '"Reviewer\\u000BBot"' }),
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

    const result = await post('/api/knowledge-assets/semantic-enrichment/write', {
      contextGraphId,
      assertionUri,
      semanticQuads: [
        { subject: 'urn:doc:imported', predicate: 'http://schema.org/about', object: 'Fallback topic' },
      ],
    });

    expect(result.status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.quads).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'urn:doc:imported', predicate: 'http://schema.org/about', object: '"Fallback topic"' }),
      expect.objectContaining({ subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${DKG}generatedBy`, object: 'did:dkg:agent:test' }),
      expect.objectContaining({ subject: expect.stringMatching(/^urn:dkg:semantic-enrichment:/), predicate: `${PROV}wasAttributedTo`, object: 'did:dkg:agent:test' }),
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

    const result = await post('/api/knowledge-assets/semantic-enrichment/write', {
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

    const result = await post('/api/knowledge-assets/semantic-enrichment/write', {
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

    const result = await post('/api/knowledge-assets/semantic-enrichment/write', {
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

    const result = await post('/api/knowledge-assets/semantic-enrichment/write', {
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

    const result = await post('/api/knowledge-assets/import-artifact/resolve', {
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

    const result = await post('/api/knowledge-assets/import-artifact/resolve', {
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

    const result = await post('/api/knowledge-assets/import-artifact/resolve', {
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

    const result = await post('/api/knowledge-assets/import-artifact/resolve', {
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

    const result = await post('/api/knowledge-assets/import-artifact/resolve', {
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

    const skipped = await post('/api/knowledge-assets/import-artifact/resolve', {
      contextGraphId,
      assertionUri,
    });
    expect(skipped.status).toBe(409);
    expect(skipped.body.error).toMatch(/not a completed extraction/);

    const query = await get(
      `/api/knowledge-assets/${encodeURIComponent(assertionName)}/wm/quads?contextGraphId=${encodeURIComponent(contextGraphId)}`,
    );
    expect(query.status).toBe(200);
    expect(query.body.quads).toEqual([
      { subject: 'urn:a', predicate: 'urn:p', object: '"A"' },
      { subject: 'urn:z', predicate: 'urn:p', object: 'urn:o' },
    ]);
  });
});
