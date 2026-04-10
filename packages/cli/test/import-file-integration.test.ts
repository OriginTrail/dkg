/**
 * Integration tests for the POST /api/assertion/:name/import-file orchestration.
 *
 * These tests exercise the full Phase 1 → Phase 2 → assertion.write pipeline
 * without spinning up a full DKGAgent (which needs libp2p + chain). Instead
 * we drive the exact sequence of operations the route handler does:
 *
 *   1. parseMultipart(body, boundary)
 *   2. fileStore.put(filePart.content, detectedContentType)
 *   3. branch on detectedContentType:
 *        - text/markdown → raw bytes as mdIntermediate
 *        - registered converter → converter.extract(...)
 *        - neither → graceful degrade, status="skipped"
 *   4. extractFromMarkdown({ markdown, agentDid, ontologyRef, documentIri })
 *   5. mockAgent.assertion.write(contextGraphId, name, triples)
 *   6. record in extractionStatus Map
 *
 * The mock agent captures the assertion.write call arguments for verification.
 * The real FileStore (on a temp dir), real extractionRegistry, real
 * extractFromMarkdown, real parseMultipart are all used.
 *
 * This covers the same behaviors the daemon route handler implements, minus the
 * HTTP parsing/validation shell (which is tested indirectly via the multipart
 * unit tests plus the bits the daemon compiles against).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExtractionPipelineRegistry,
  type ExtractionPipeline,
  type ExtractionInput,
  type ConverterOutput,
  contextGraphAssertionUri,
} from '@origintrail-official/dkg-core';
import { FileStore } from '../src/file-store.js';
import { parseBoundary, parseMultipart } from '../src/http/multipart.js';
import { extractFromMarkdown } from '../src/extraction/markdown-extractor.js';

// ── Test fixture types (mirroring the ExtractionStatusRecord in daemon.ts) ──

interface ExtractionStatusRecord {
  status: 'in_progress' | 'completed' | 'skipped' | 'failed';
  fileHash: string;
  detectedContentType: string;
  pipelineUsed: string | null;
  tripleCount: number;
  mdIntermediateHash?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

interface CapturedAssertionWrite {
  contextGraphId: string;
  name: string;
  triples: Array<{ subject: string; predicate: string; object: string }>;
  subGraphName?: string;
}

interface MockAgent {
  peerId: string;
  assertion: {
    create: (
      contextGraphId: string,
      name: string,
      opts?: { subGraphName?: string },
    ) => Promise<string>;
    write: (
      contextGraphId: string,
      name: string,
      triples: Array<{ subject: string; predicate: string; object: string }>,
      opts?: { subGraphName?: string },
    ) => Promise<void>;
  };
  capturedWrites: CapturedAssertionWrite[];
  createdAssertions: Array<{ contextGraphId: string; name: string; subGraphName?: string }>;
}

interface MockAgentOptions {
  createError?: Error;
  writeError?: Error;
}

function makeMockAgent(peerId = '0xMockAgentPeerId', options: MockAgentOptions = {}): MockAgent {
  const capturedWrites: CapturedAssertionWrite[] = [];
  const createdAssertions: Array<{ contextGraphId: string; name: string; subGraphName?: string }> = [];
  return {
    peerId,
    capturedWrites,
    createdAssertions,
    assertion: {
      async create(contextGraphId: string, name: string, opts?: { subGraphName?: string }): Promise<string> {
        if (options.createError) throw options.createError;
        createdAssertions.push({ contextGraphId, name, subGraphName: opts?.subGraphName });
        return contextGraphAssertionUri(contextGraphId, peerId, name, opts?.subGraphName);
      },
      async write(
        contextGraphId: string,
        name: string,
        triples: Array<{ subject: string; predicate: string; object: string }>,
        opts?: { subGraphName?: string },
      ): Promise<void> {
        if (options.writeError) throw options.writeError;
        capturedWrites.push({ contextGraphId, name, triples, subGraphName: opts?.subGraphName });
      },
    },
  };
}

// ── The orchestration under test (matches daemon.ts import-file handler) ──

interface ImportFileResult {
  assertionUri: string;
  fileHash: string;
  detectedContentType: string;
  extraction: {
    status: 'completed' | 'skipped' | 'failed';
    tripleCount: number;
    pipelineUsed: string | null;
    mdIntermediateHash?: string;
    error?: string;
  };
}

function normalizeDetectedContentType(contentType: string | undefined): string {
  const normalized = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : 'application/octet-stream';
}

async function runImportFileOrchestration(params: {
  agent: MockAgent;
  fileStore: FileStore;
  extractionRegistry: ExtractionPipelineRegistry;
  extractionStatus: Map<string, ExtractionStatusRecord>;
  multipartBody: Buffer;
  boundary: string;
  assertionName: string;
}): Promise<ImportFileResult> {
  const { agent, fileStore, extractionRegistry, extractionStatus, multipartBody, boundary, assertionName } = params;

  const fields = parseMultipart(multipartBody, boundary);
  const filePart = fields.find(f => f.name === 'file' && f.filename !== undefined)!;
  const textField = (name: string): string | undefined => {
    const f = fields.find(x => x.name === name && x.filename === undefined);
    return f ? f.content.toString('utf-8') : undefined;
  };
  const contextGraphId = textField('contextGraphId')!;
  const contentTypeOverride = textField('contentType');
  const ontologyRef = textField('ontologyRef');
  const subGraphName = textField('subGraphName');
  const detectedContentType = normalizeDetectedContentType(contentTypeOverride ?? filePart.contentType);

  const fileStoreEntry = await fileStore.put(filePart.content, detectedContentType);
  const assertionUri = contextGraphAssertionUri(contextGraphId, agent.peerId, assertionName, subGraphName);
  const startedAt = new Date().toISOString();

  let mdIntermediate: string | null = null;
  let pipelineUsed: string | null = null;
  let mdIntermediateHash: string | undefined;

  if (detectedContentType === 'text/markdown') {
    mdIntermediate = filePart.content.toString('utf-8');
    pipelineUsed = 'text/markdown';
  } else {
    const converter = extractionRegistry.get(detectedContentType);
    if (converter) {
      const { mdIntermediate: md } = await converter.extract({
        filePath: fileStoreEntry.path,
        contentType: detectedContentType,
        ontologyRef,
        agentDid: `did:dkg:agent:${agent.peerId}`,
      });
      mdIntermediate = md;
      pipelineUsed = detectedContentType;
      const mdEntry = await fileStore.put(Buffer.from(md, 'utf-8'), 'text/markdown');
      mdIntermediateHash = mdEntry.hash;
    }
  }

  // Graceful degrade
  if (mdIntermediate === null) {
    const skippedRecord: ExtractionStatusRecord = {
      status: 'skipped',
      fileHash: fileStoreEntry.hash,
      detectedContentType,
      pipelineUsed: null,
      tripleCount: 0,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    extractionStatus.set(assertionUri, skippedRecord);
    return {
      assertionUri,
      fileHash: fileStoreEntry.hash,
      detectedContentType,
      extraction: { status: 'skipped', tripleCount: 0, pipelineUsed: null },
    };
  }

  // Phase 2
  const recordFailed = (error: string, tripleCount: number): void => {
    extractionStatus.set(assertionUri, {
      status: 'failed',
      fileHash: fileStoreEntry.hash,
      detectedContentType,
      pipelineUsed,
      tripleCount,
      ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
      error,
      startedAt,
      completedAt: new Date().toISOString(),
    });
  };

  let triples: ReturnType<typeof extractFromMarkdown>['triples'];
  let provenance: ReturnType<typeof extractFromMarkdown>['provenance'];
  try {
    const result = extractFromMarkdown({
      markdown: mdIntermediate,
      agentDid: `did:dkg:agent:${agent.peerId}`,
      ontologyRef,
      documentIri: assertionUri,
    });
    triples = result.triples;
    provenance = result.provenance;
  } catch (err: any) {
    recordFailed(`Phase 2 extraction failed: ${err.message}`, 0);
    throw err;
  }

  const allTriples = [...triples, ...provenance];
  try {
    await agent.assertion.create(contextGraphId, assertionName, subGraphName ? { subGraphName } : undefined);
    if (allTriples.length > 0) {
      await agent.assertion.write(
        contextGraphId,
        assertionName,
        allTriples.map(t => ({ subject: t.subject, predicate: t.predicate, object: t.object })),
        subGraphName ? { subGraphName } : undefined,
      );
    }
  } catch (err: any) {
    if (err.message?.includes('has not been registered') || err.message?.includes('Invalid') || err.message?.includes('Unsafe')) {
      recordFailed(err.message, triples.length);
    }
    throw err;
  }

  const completedRecord: ExtractionStatusRecord = {
    status: 'completed',
    fileHash: fileStoreEntry.hash,
    detectedContentType,
    pipelineUsed,
    tripleCount: triples.length,
    mdIntermediateHash,
    startedAt,
    completedAt: new Date().toISOString(),
  };
  extractionStatus.set(assertionUri, completedRecord);

  return {
    assertionUri,
    fileHash: fileStoreEntry.hash,
    detectedContentType,
    extraction: {
      status: 'completed',
      tripleCount: triples.length,
      pipelineUsed,
      ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
    },
  };
}

// ── Multipart body builder for tests ──

const BOUNDARY = '----dkgimporttest';
const CRLF = '\r\n';

function buildMultipart(parts: Array<
  | { kind: 'text'; name: string; value: string }
  | { kind: 'file'; name: string; filename: string; contentType: string; content: Buffer }
>): Buffer {
  const segments: Buffer[] = [];
  for (const p of parts) {
    segments.push(Buffer.from(`--${BOUNDARY}${CRLF}`));
    if (p.kind === 'text') {
      segments.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"${CRLF}${CRLF}${p.value}`));
    } else {
      segments.push(Buffer.from(
        `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"${CRLF}` +
        `Content-Type: ${p.contentType}${CRLF}${CRLF}`,
      ));
      segments.push(p.content);
    }
    segments.push(Buffer.from(CRLF));
  }
  segments.push(Buffer.from(`--${BOUNDARY}--${CRLF}`));
  return Buffer.concat(segments);
}

// ── Tests ──

describe('import-file orchestration — happy paths', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let registry: ExtractionPipelineRegistry;
  let status: Map<string, ExtractionStatusRecord>;
  let agent: MockAgent;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dkg-importfile-test-'));
    fileStore = new FileStore(join(tmpDir, 'files'));
    registry = new ExtractionPipelineRegistry();
    status = new Map();
    agent = makeMockAgent();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('text/markdown upload — skips Phase 1, runs Phase 2, writes triples to assertion', async () => {
    const markdown = [
      '---',
      'id: research-note',
      'type: ScholarlyArticle',
      'title: Climate Report 2026',
      'description: A short climate analysis',
      '---',
      '',
      '# Climate Report 2026',
      '',
      'Global temperature rose by 1.2°C. See [[Paris Agreement]] and #climate topics.',
      '',
      '## Background',
      '',
      'status:: draft',
      '',
      '## Methods',
      '',
      'Sampled historical records.',
      '',
    ].join('\n');

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'research-cg' },
      { kind: 'file', name: 'file', filename: 'climate.md', contentType: 'text/markdown', content: Buffer.from(markdown, 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'climate-report',
    });

    // Response shape
    expect(result.extraction.status).toBe('completed');
    expect(result.extraction.pipelineUsed).toBe('text/markdown');
    expect(result.extraction.tripleCount).toBeGreaterThan(0);
    expect(result.fileHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.detectedContentType).toBe('text/markdown');
    expect(result.extraction.mdIntermediateHash).toBeUndefined(); // no Phase 1, no MD intermediate stored separately
    expect(result.assertionUri).toBe(contextGraphAssertionUri('research-cg', agent.peerId, 'climate-report'));

    // Assertion write happened
    expect(agent.createdAssertions).toHaveLength(1);
    expect(agent.createdAssertions[0]).toEqual({ contextGraphId: 'research-cg', name: 'climate-report', subGraphName: undefined });
    expect(agent.capturedWrites).toHaveLength(1);
    expect(agent.capturedWrites[0].contextGraphId).toBe('research-cg');
    expect(agent.capturedWrites[0].name).toBe('climate-report');

    // Triples reflect the markdown structure
    const writtenTriples = agent.capturedWrites[0].triples;
    // rdf:type ScholarlyArticle
    expect(writtenTriples.some(t =>
      t.predicate === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
      t.object === 'http://schema.org/ScholarlyArticle',
    )).toBe(true);
    // schema:name from frontmatter title
    expect(writtenTriples.some(t =>
      t.predicate === 'http://schema.org/name' &&
      t.object === '"Climate Report 2026"',
    )).toBe(true);
    // wikilink mention
    expect(writtenTriples.some(t =>
      t.predicate === 'http://schema.org/mentions' &&
      t.object === 'urn:dkg:md:paris-agreement',
    )).toBe(true);
    // hashtag as keyword
    expect(writtenTriples.some(t =>
      t.predicate === 'http://schema.org/keywords' &&
      t.object === '"climate"',
    )).toBe(true);
    // dataview field
    expect(writtenTriples.some(t =>
      t.predicate === 'http://schema.org/status' &&
      t.object === '"draft"',
    )).toBe(true);
    // section headings
    expect(writtenTriples.some(t =>
      t.predicate === 'http://dkg.io/ontology/hasSection',
    )).toBe(true);

    // Status map populated
    expect(status.size).toBe(1);
    const record = status.get(result.assertionUri)!;
    expect(record.status).toBe('completed');
    expect(record.fileHash).toBe(result.fileHash);
    expect(record.pipelineUsed).toBe('text/markdown');
    expect(record.tripleCount).toBe(result.extraction.tripleCount);
  });

  it('text/markdown upload uses filePart content type when contentType field is not provided', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'doc',
    });

    expect(result.extraction.status).toBe('completed');
    expect(result.extraction.pipelineUsed).toBe('text/markdown');
    expect(result.detectedContentType).toBe('text/markdown');
  });

  it('normalizes markdown media types with parameters and casing before Phase 1 routing', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'Text/Markdown; charset=utf-8', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'doc',
    });

    expect(result.detectedContentType).toBe('text/markdown');
    expect(result.extraction.status).toBe('completed');
    expect(result.extraction.pipelineUsed).toBe('text/markdown');
  });

  it('contentType text field overrides the file part Content-Type header', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'text', name: 'contentType', value: 'text/markdown' },
      // File reports application/octet-stream, but the override tells the handler to treat it as markdown
      { kind: 'file', name: 'file', filename: 'doc.bin', contentType: 'application/octet-stream', content: Buffer.from('# Hello\n\nWorld.\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'override-test',
    });

    expect(result.detectedContentType).toBe('text/markdown');
    expect(result.extraction.status).toBe('completed');
    expect(result.extraction.pipelineUsed).toBe('text/markdown');
  });

  it('registered converter path — runs Phase 1, stores MD intermediate, runs Phase 2', async () => {
    // Register a stub converter for application/pdf that converts "fake-pdf" bytes to real markdown
    const stubConverter: ExtractionPipeline = {
      contentTypes: ['application/pdf'],
      async extract(_input: ExtractionInput): Promise<ConverterOutput> {
        return {
          mdIntermediate: [
            '---',
            'id: stub-doc',
            'type: Report',
            '---',
            '',
            '# Stub Document',
            '',
            'Body with #tag1 and [[Reference]].',
            '',
          ].join('\n'),
        };
      },
    };
    registry.register(stubConverter);

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'research' },
      { kind: 'file', name: 'file', filename: 'paper.pdf', contentType: 'application/pdf', content: Buffer.from('fake-pdf-bytes', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'paper',
    });

    expect(result.extraction.status).toBe('completed');
    expect(result.extraction.pipelineUsed).toBe('application/pdf');
    expect(result.extraction.mdIntermediateHash).toBeDefined();
    expect(result.extraction.mdIntermediateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.extraction.mdIntermediateHash).not.toBe(result.fileHash); // stored separately

    // MD intermediate is retrievable from the file store
    const mdBytes = await fileStore.get(result.extraction.mdIntermediateHash!);
    expect(mdBytes).not.toBeNull();
    expect(mdBytes!.toString('utf-8')).toContain('# Stub Document');

    // Triples reflect the Phase 2 extraction of the stub's MD intermediate
    const triples = agent.capturedWrites[0].triples;
    expect(triples.some(t => t.object === 'http://schema.org/Report')).toBe(true);
    expect(triples.some(t => t.object === '"tag1"')).toBe(true);
    expect(triples.some(t => t.object === 'urn:dkg:md:reference')).toBe(true);
  });

  it('normalizes converter media types before registry lookup', async () => {
    const stubConverter: ExtractionPipeline = {
      contentTypes: ['application/pdf'],
      async extract(_input: ExtractionInput): Promise<ConverterOutput> {
        return { mdIntermediate: '# Converted\n\nBody.\n' };
      },
    };
    registry.register(stubConverter);

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'research' },
      { kind: 'file', name: 'file', filename: 'paper.pdf', contentType: 'Application/PDF; charset=binary', content: Buffer.from('fake-pdf-bytes', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'paper-normalized',
    });

    expect(result.detectedContentType).toBe('application/pdf');
    expect(result.extraction.status).toBe('completed');
    expect(result.extraction.pipelineUsed).toBe('application/pdf');
    expect(result.extraction.mdIntermediateHash).toBeDefined();
  });

  it('passes ontologyRef through to the converter and Phase 2 extractor', async () => {
    let capturedOntologyRef: string | undefined;
    const stubConverter: ExtractionPipeline = {
      contentTypes: ['application/pdf'],
      async extract(input: ExtractionInput): Promise<ConverterOutput> {
        capturedOntologyRef = input.ontologyRef;
        return { mdIntermediate: '# Doc\n\nBody.\n' };
      },
    };
    registry.register(stubConverter);

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'research' },
      { kind: 'text', name: 'ontologyRef', value: 'did:dkg:context-graph:research/_ontology' },
      { kind: 'file', name: 'file', filename: 'paper.pdf', contentType: 'application/pdf', content: Buffer.from('pdf', 'utf-8') },
    ]);

    await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'paper',
    });

    expect(capturedOntologyRef).toBe('did:dkg:context-graph:research/_ontology');
  });

  it('passes subGraphName through to assertion.create and assertion.write', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'text', name: 'subGraphName', value: 'decisions' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'decision-1',
    });

    expect(agent.createdAssertions[0]).toEqual({ contextGraphId: 'cg', name: 'decision-1', subGraphName: 'decisions' });
    expect(agent.capturedWrites[0].subGraphName).toBe('decisions');
  });

  it('creates the assertion graph even when Phase 2 extracts zero triples', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'empty.md', contentType: 'text/markdown', content: Buffer.from('', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'empty-doc',
    });

    expect(result.extraction.status).toBe('completed');
    expect(result.extraction.tripleCount).toBe(0);
    expect(agent.createdAssertions).toHaveLength(1);
    expect(agent.createdAssertions[0]).toEqual({ contextGraphId: 'cg', name: 'empty-doc', subGraphName: undefined });
    expect(agent.capturedWrites).toHaveLength(0);
  });

  it('records failed extraction status when assertion.create rejects an unregistered sub-graph', async () => {
    agent = makeMockAgent('0xMockAgentPeerId', {
      createError: new Error('Sub-graph "decisions" has not been registered in context graph "cg". Call createSubGraph() first.'),
    });

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'text', name: 'subGraphName', value: 'decisions' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    await expect(runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'decision-1',
    })).rejects.toThrow('has not been registered');

    const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'decision-1', 'decisions');
    const record = status.get(assertionUri);
    expect(record).toBeDefined();
    expect(record?.status).toBe('failed');
    expect(record?.error).toContain('has not been registered');
    expect(record?.tripleCount).toBeGreaterThan(0);
  });

  it('records failed extraction status when assertion.write rejects invalid triples', async () => {
    agent = makeMockAgent('0xMockAgentPeerId', {
      writeError: new Error('Invalid triple object'),
    });

    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    await expect(runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'invalid-write',
    })).rejects.toThrow('Invalid triple object');

    const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'invalid-write');
    const record = status.get(assertionUri);
    expect(record).toBeDefined();
    expect(record?.status).toBe('failed');
    expect(record?.error).toBe('Invalid triple object');
    expect(record?.tripleCount).toBeGreaterThan(0);
  });
});

describe('import-file orchestration — graceful degrade', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let registry: ExtractionPipelineRegistry;
  let status: Map<string, ExtractionStatusRecord>;
  let agent: MockAgent;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dkg-importfile-test-'));
    fileStore = new FileStore(join(tmpDir, 'files'));
    registry = new ExtractionPipelineRegistry();
    status = new Map();
    agent = makeMockAgent();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('unregistered content type — stores file, returns status="skipped", writes no triples', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'photo.png', contentType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'photo',
    });

    expect(result.extraction.status).toBe('skipped');
    expect(result.extraction.tripleCount).toBe(0);
    expect(result.extraction.pipelineUsed).toBeNull();
    expect(result.extraction.mdIntermediateHash).toBeUndefined();
    expect(result.detectedContentType).toBe('image/png');

    // File is still stored (retrievable via fileHash)
    const retrieved = await fileStore.get(result.fileHash);
    expect(retrieved).not.toBeNull();
    expect(retrieved![0]).toBe(0x89); // PNG magic byte preserved

    // No triples written to the assertion
    expect(agent.createdAssertions).toHaveLength(0);
    expect(agent.capturedWrites).toHaveLength(0);

    // Status record reflects the skip
    const record = status.get(result.assertionUri)!;
    expect(record.status).toBe('skipped');
    expect(record.pipelineUsed).toBeNull();
    expect(record.tripleCount).toBe(0);
  });

  it('unregistered content type with no content-type header — defaults to application/octet-stream and skips', async () => {
    // File part without a Content-Type header — daemon defaults to application/octet-stream
    const fileContent = Buffer.from('opaque', 'utf-8');
    const segments: Buffer[] = [];
    segments.push(Buffer.from(`--${BOUNDARY}${CRLF}`));
    segments.push(Buffer.from(`Content-Disposition: form-data; name="contextGraphId"${CRLF}${CRLF}cg`));
    segments.push(Buffer.from(CRLF));
    segments.push(Buffer.from(`--${BOUNDARY}${CRLF}`));
    segments.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="opaque.bin"${CRLF}${CRLF}`));
    segments.push(fileContent);
    segments.push(Buffer.from(CRLF));
    segments.push(Buffer.from(`--${BOUNDARY}--${CRLF}`));
    const body = Buffer.concat(segments);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'opaque-upload',
    });

    expect(result.detectedContentType).toBe('application/octet-stream');
    expect(result.extraction.status).toBe('skipped');
    expect(result.extraction.pipelineUsed).toBeNull();
  });
});

describe('import-file orchestration — boundary parsing', () => {
  it('parseBoundary extracts boundary from the daemon-style header', () => {
    expect(parseBoundary(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(BOUNDARY);
  });

  it('parseBoundary rejects non-multipart requests', () => {
    expect(parseBoundary('application/json')).toBeNull();
  });
});

describe('import-file orchestration — extraction-status semantics', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let registry: ExtractionPipelineRegistry;
  let status: Map<string, ExtractionStatusRecord>;
  let agent: MockAgent;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dkg-importfile-test-'));
    fileStore = new FileStore(join(tmpDir, 'files'));
    registry = new ExtractionPipelineRegistry();
    status = new Map();
    agent = makeMockAgent();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('populates the status record with startedAt/completedAt timestamps on success', async () => {
    const body = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
    ]);

    const result = await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body, boundary: BOUNDARY, assertionName: 'doc',
    });

    const record = status.get(result.assertionUri)!;
    expect(record.startedAt).toBeTruthy();
    expect(record.completedAt).toBeTruthy();
    expect(new Date(record.startedAt).getTime()).toBeLessThanOrEqual(new Date(record.completedAt!).getTime());
  });

  it('keyed by assertionUri — separate imports to different assertions get separate records', async () => {
    const body1 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'a.md', contentType: 'text/markdown', content: Buffer.from('# A\n\nBody a.\n', 'utf-8') },
    ]);
    const body2 = buildMultipart([
      { kind: 'text', name: 'contextGraphId', value: 'cg' },
      { kind: 'file', name: 'file', filename: 'b.md', contentType: 'text/markdown', content: Buffer.from('# B\n\nBody b.\n', 'utf-8') },
    ]);

    await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body1, boundary: BOUNDARY, assertionName: 'doc-a',
    });
    await runImportFileOrchestration({
      agent, fileStore, extractionRegistry: registry, extractionStatus: status,
      multipartBody: body2, boundary: BOUNDARY, assertionName: 'doc-b',
    });

    expect(status.size).toBe(2);
    const keys = [...status.keys()];
    expect(keys.some(k => k.endsWith('/doc-a'))).toBe(true);
    expect(keys.some(k => k.endsWith('/doc-b'))).toBe(true);
  });
});
