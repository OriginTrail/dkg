import { describe, it, expect, beforeEach, afterEach, mkdtemp, rm, readFile, tmpdir, join, existsSync, ExtractionPipelineRegistry, autoPartition, findReservedSubjectPrefix, FileStore, parseBoundary, extractFromMarkdown, contextGraphAssertionUri, contextGraphMetaUri, assertionLifecycleUri, ImportFileRouteError, makeMockAgent, getDataGraphQuads, BOUNDARY, CRLF, buildMultipart, type ExtractionPipeline, type ExtractionInput, type ConverterOutput, type ExtractionStatusRecord, type CapturedQuad, type MockAgent } from './import-file-test-helpers';
import { runImportFileOrchestration } from './import-file-orchestration.shared';
import {
  DKG_CHUNK_INDEX,
  DKG_CHUNK_VALUE,
  DKG_HAS_TEXT_BODY,
  DKG_HAS_TEXT_CHUNK,
} from '@origintrail-official/dkg-core';
import { reconstructChunkedText } from '../../core/test/helpers/chunked-text.js';

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
      expect(result.fileHash).toMatch(/^keccak256:[0-9a-f]{64}$/);
      expect(result.detectedContentType).toBe('text/markdown');
      expect(result.extraction.mdIntermediateHash).toBeUndefined(); // no Phase 1, no MD intermediate stored separately
      expect(result.assertionUri).toBe(contextGraphAssertionUri('research-cg', agent.peerId, 'climate-report'));

      // Assertion graph created and data-graph quads committed through the
      // atomic multi-graph insert (single `store.insert` for both graphs).
      expect(agent.createdAssertions).toHaveLength(1);
      expect(agent.createdAssertions[0]).toEqual({
        contextGraphId: 'research-cg',
        name: 'climate-report',
        agentAddress: agent.peerId,
        subGraphName: undefined,
      });
      const writtenTriples = getDataGraphQuads(agent, 'research-cg', 'climate-report');
      expect(writtenTriples.length).toBeGreaterThan(0);

      // Triples reflect the markdown structure
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
      const sectionSubjectsBeforePartition = writtenTriples
        .filter(t =>
          t.subject.startsWith('_:dkg-md-section-') ||
          (t.predicate === 'http://dkg.io/ontology/hasSection' && t.object.startsWith('_:dkg-md-section-')),
        )
        .flatMap(t => [t.subject, t.object])
        .filter(term => term.startsWith('_:dkg-md-section-'));
      expect(sectionSubjectsBeforePartition.length).toBeGreaterThan(0);
      expect(sectionSubjectsBeforePartition.every(term => !term.includes('#section-'))).toBe(true);

      const promotionEligible = writtenTriples
        .filter(t => !findReservedSubjectPrefix(t.subject))
        .map(t => ({ ...t, graph: 'did:dkg:context-graph:research-cg' }));
      const partitioned = autoPartition(promotionEligible);
      const selectedRootQuads = partitioned.get(result.assertionUri) ?? [];
      expect(selectedRootQuads).toHaveLength(promotionEligible.length);
      expect(selectedRootQuads.some(t =>
        t.subject.startsWith(`${result.assertionUri}/.well-known/genid/dkg-md-section-`) &&
        t.predicate === 'http://schema.org/name',
      )).toBe(true);
      expect([...partitioned.keys()]).toEqual([result.assertionUri]);

      // Status map populated
      expect(status.size).toBe(1);
      const record = status.get(result.assertionUri)!;
      expect(record.status).toBe('completed');
      expect(record.fileHash).toBe(result.fileHash);
      expect(record.pipelineUsed).toBe('text/markdown');
      expect(record.tripleCount).toBe(result.extraction.tripleCount);
    });

    it('text/markdown upload chunks oversized schema:text frontmatter literals in the assertion graph', async () => {
      const largeText = 'x'.repeat(60_000);
      const markdown = [
        '---',
        'id: large-literal-note',
        `text: "${largeText}"`,
        '---',
        '',
        '# Large Literal',
        '',
      ].join('\n');

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'large-literal-cg' },
        { kind: 'file', name: 'file', filename: 'large.md', contentType: 'text/markdown', content: Buffer.from(markdown, 'utf-8') },
      ]);

      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'large-literal',
      });

      expect(result.extraction.status).toBe('completed');
      const assertionGraph = contextGraphAssertionUri('large-literal-cg', agent.peerId, 'large-literal');
      const writtenTriples = getDataGraphQuads(agent, 'large-literal-cg', 'large-literal');
      expect(writtenTriples.some((quad) =>
        quad.subject === result.assertionUri &&
        quad.predicate === 'http://schema.org/text'
      )).toBe(false);
      expect(writtenTriples.some((quad) => quad.predicate === DKG_CHUNK_VALUE)).toBe(true);
      expect(reconstructChunkedText(writtenTriples, result.assertionUri)).toBe(largeText);

      const chunkQuads = agent.insertedQuads.filter((quad) =>
        quad.predicate === DKG_HAS_TEXT_BODY ||
        quad.predicate === DKG_HAS_TEXT_CHUNK ||
        quad.predicate === DKG_CHUNK_INDEX ||
        quad.predicate === DKG_CHUNK_VALUE
      );
      expect(chunkQuads.length).toBeGreaterThan(0);
      expect(chunkQuads.every((quad) => quad.graph === assertionGraph)).toBe(true);
      expect(agent.insertedQuads.some((quad) =>
        quad.graph === contextGraphMetaUri('large-literal-cg') &&
        quad.predicate === DKG_CHUNK_VALUE
      )).toBe(false);
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


    it('explicit contentType=application/octet-stream suppresses filename inference — opaque-blob escape hatch (Codex PR #1107)', async () => {
      // The caller DELIBERATELY pins octet-stream while uploading a .md file
      // whose part header even says text/markdown. Pre-fix, the filename
      // fallback re-inferred text/markdown and ran extraction anyway,
      // removing the documented "store as opaque blob" escape hatch.
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'text', name: 'contentType', value: 'application/octet-stream' },
        { kind: 'file', name: 'file', filename: 'notes.md', contentType: 'text/markdown', content: Buffer.from('# Secret\n\nKeep opaque.\n', 'utf-8') },
      ]);

      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'opaque-escape-hatch',
      });

      expect(result.detectedContentType).toBe('application/octet-stream');
      expect(result.extraction.status).toBe('skipped');
      expect(result.extraction.pipelineUsed).toBeNull();
    });


    it('IMPLICIT octet-stream (no override) still infers from the filename extension (#1101 preserved)', async () => {
      // Same .md upload, but the octet-stream comes from the file part header
      // (curl default), NOT an explicit override — the #1101 inference must
      // still rescue extraction here.
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'notes.md', contentType: 'application/octet-stream', content: Buffer.from('# Hello\n\nStill markdown.\n', 'utf-8') },
      ]);

      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'implicit-inference',
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
      expect(result.extraction.mdIntermediateHash).toMatch(/^keccak256:[0-9a-f]{64}$/);
      expect(result.extraction.mdIntermediateHash).not.toBe(result.fileHash); // stored separately

      // MD intermediate is retrievable from the file store
      const mdBytes = await fileStore.get(result.extraction.mdIntermediateHash!);
      expect(mdBytes).not.toBeNull();
      expect(mdBytes!.toString('utf-8')).toContain('# Stub Document');

      // Triples reflect the Phase 2 extraction of the stub's MD intermediate
      const triples = getDataGraphQuads(agent, 'research', 'paper');
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
      // Pin format the same way the sibling test ~1040 does so `mdIntermediateHash`
      // is not satisfied by a truthy-but-malformed value (e.g. '' or 'todo').
      expect(result.extraction.mdIntermediateHash).toMatch(/^keccak256:[0-9a-f]{64}$/);
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
      agent = makeMockAgent('0xMockAgentPeerId', {
        registeredSubGraphs: ['decisions'],
      });

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'text', name: 'subGraphName', value: 'decisions' },
        { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
      ]);

      await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'decision-1',
      });

      expect(agent.createdAssertions[0]).toEqual({
        contextGraphId: 'cg',
        name: 'decision-1',
        agentAddress: agent.peerId,
        subGraphName: 'decisions',
      });
      // Sub-graph routing: data-graph quads land in the sub-graph's assertion
      // graph URI (which embeds `decisions`), not the CG root assertion URI.
      const subGraphAssertionGraph = contextGraphAssertionUri('cg', agent.peerId, 'decision-1', 'decisions');
      const subGraphDataQuads = agent.insertedQuads.filter(q => q.graph === subGraphAssertionGraph);
      expect(subGraphDataQuads.length).toBeGreaterThan(0);
    });


    it('seeds an in-progress extraction status before the terminal record is written', async () => {
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
      ]);

      let observedInProgress = false;
      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'in-progress-doc',
        async onInProgress(assertionUri, record) {
          observedInProgress = true;
          expect(assertionUri).toBe(contextGraphAssertionUri('cg', agent.peerId, 'in-progress-doc'));
          expect(record.status).toBe('in_progress');
          expect(record.completedAt).toBeUndefined();
          expect(status.get(assertionUri)?.status).toBe('in_progress');
        },
      });

      expect(observedInProgress).toBe(true);
      expect(status.get(result.assertionUri)?.status).toBe('completed');
    });


    it('creates the assertion graph even when Phase 2 extracts zero content triples', async () => {
      // An empty markdown upload produces zero content triples but the route
      // handler still writes §10.1 linkage + §6.3 file descriptor + §3.2
      // extraction provenance into the assertion graph, and §10.2 meta
      // quads into the CG root `_meta`, so daemon restarts can still find
      // the file <-> assertion linkage.
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'empty.md', contentType: 'text/markdown', content: Buffer.from('', 'utf-8') },
      ]);

      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'empty-doc',
      });

      expect(result.extraction.status).toBe('completed');
      // tripleCount reports Phase 2 content triples only, which is still zero.
      expect(result.extraction.tripleCount).toBe(0);
      expect(agent.createdAssertions).toHaveLength(1);
      expect(agent.createdAssertions[0]).toEqual({
        contextGraphId: 'cg',
        name: 'empty-doc',
        agentAddress: agent.peerId,
        subGraphName: undefined,
      });
      // Data-graph quads: rows 1, 3 (linkage from extractor) + row 2
      // (daemon-owned original content type) + `dkg:markdownForm`
      // (daemon-owned markdown-input link) + rows 4, 5, 8 (file descriptor
      // intrinsic-to-content properties, 3 quads — Round 9 Bug 27 dropped
      // rows 6+7) + rows 9-13 (extraction provenance, 5 quads) = 12 total.
      const dataQuads = getDataGraphQuads(agent, 'cg', 'empty-doc');
      expect(dataQuads).toHaveLength(12);
      // Meta graph still populated with the structural row 14-19 quads.
      const metaGraph = contextGraphMetaUri('cg');
      const metaQuads = agent.insertedQuads.filter(q => q.graph === metaGraph);
      expect(metaQuads.length).toBeGreaterThanOrEqual(6);
    });


    it('records failed extraction status when assertion.create rejects an unregistered sub-graph', async () => {
      agent = makeMockAgent('0xMockAgentPeerId', {
        registeredSubGraphs: ['decisions'],
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


    it('surfaces non-idempotent assertion.create failures as failed imports', async () => {
      agent = makeMockAgent('0xMockAgentPeerId', {
        createError: new Error('Storage backend unavailable'),
      });

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'empty.md', contentType: 'text/markdown', content: Buffer.from('', 'utf-8') },
      ]);

      let caught: unknown;
      try {
        await runImportFileOrchestration({
          agent, fileStore, extractionRegistry: registry, extractionStatus: status,
          multipartBody: body, boundary: BOUNDARY, assertionName: 'create-runtime-failure',
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ImportFileRouteError);
      const routeError = caught as ImportFileRouteError;
      expect(routeError.statusCode).toBe(500);
      expect(routeError.body.extraction.status).toBe('failed');
      expect(routeError.body.extraction.error).toBe('Storage backend unavailable');

      const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'create-runtime-failure');
      const record = status.get(assertionUri);
      expect(record?.status).toBe('failed');
      expect(record?.error).toBe('Storage backend unavailable');
      expect(record?.tripleCount).toBe(0);
    });


    it('treats explicit already-exists assertion.create failures as idempotent', async () => {
      agent = makeMockAgent('0xMockAgentPeerId', {
        createError: new Error('Assertion graph already exists'),
      });

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
      ]);

      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'create-idempotent',
      });

      expect(result.extraction.status).toBe('completed');
      // The atomic insert still ran, so the data-graph quads are present.
      expect(getDataGraphQuads(agent, 'cg', 'create-idempotent').length).toBeGreaterThan(0);
      expect(status.get(result.assertionUri)?.status).toBe('completed');
    });


    it('rejects an unregistered sub-graph before storing the upload blob', async () => {
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'text', name: 'subGraphName', value: 'decisions' },
        { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
      ]);

      await expect(runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'unregistered-preflight',
      })).rejects.toThrow('has not been registered');

      expect(existsSync(fileStore.directory)).toBe(false);
    });
});
