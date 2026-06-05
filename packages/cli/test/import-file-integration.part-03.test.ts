import { describe, it, expect, beforeEach, afterEach, mkdtemp, rm, readFile, tmpdir, join, existsSync, ExtractionPipelineRegistry, autoPartition, findReservedSubjectPrefix, FileStore, parseBoundary, extractFromMarkdown, contextGraphAssertionUri, contextGraphMetaUri, assertionLifecycleUri, ImportFileRouteError, makeMockAgent, getDataGraphQuads, BOUNDARY, CRLF, buildMultipart, type ExtractionPipeline, type ExtractionInput, type ConverterOutput, type ExtractionStatusRecord, type CapturedQuad, type MockAgent } from './import-file-test-helpers';
import { runImportFileOrchestration } from './import-file-orchestration.shared';

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


    it('unregistered content type — stores file, returns status="skipped", writes only durable metadata', async () => {
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'photo.png', contentType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
      ]);
      const events: Array<{
        contextGraphId: string;
        layers: string[];
        subGraphName?: string;
        operation: string;
        source: string;
        counts: { triples: number };
      }> = [];

      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'photo',
        onMemoryGraphChanged: event => { events.push(event); },
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

      // No triples written to the assertion graph, but durable _meta
      // provenance remains available after daemon restarts/cache loss.
      expect(agent.createdAssertions).toEqual([
        { contextGraphId: 'cg', name: 'photo', agentAddress: agent.peerId, subGraphName: undefined },
      ]);
      expect(getDataGraphQuads(agent, 'cg', 'photo')).toHaveLength(0);

      const metaGraph = contextGraphMetaUri('cg');
      const metaQuads = agent.insertedQuads.filter(q =>
        q.graph === metaGraph && q.subject === result.assertionUri
      );
      expect(metaQuads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          predicate: 'http://dkg.io/ontology/sourceFileHash',
          object: JSON.stringify(result.fileHash),
        }),
        expect.objectContaining({
          predicate: 'http://dkg.io/ontology/sourceContentType',
          object: JSON.stringify('image/png'),
        }),
        expect.objectContaining({
          predicate: 'http://dkg.io/ontology/extractionStatus',
          object: JSON.stringify('skipped'),
        }),
        expect.objectContaining({
          predicate: 'http://dkg.io/ontology/sourceFileName',
          object: JSON.stringify('photo.png'),
        }),
        expect.objectContaining({
          predicate: 'http://dkg.io/ontology/structuralTripleCount',
          object: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>',
        }),
      ]));

      // Status record reflects the skip
      const record = status.get(result.assertionUri)!;
      expect(record.status).toBe('skipped');
      expect(record.pipelineUsed).toBeNull();
      expect(record.tripleCount).toBe(0);
      expect(events).toEqual([{
        contextGraphId: 'cg',
        layers: ['wm'],
        subGraphName: undefined,
        operation: 'assertion_imported',
        source: 'api',
        counts: { triples: 0 },
      }]);
    });


    it('unregistered content type fails before durable metadata writes when assertion.create rejects', async () => {
      const gatedAgent = makeMockAgent('0xMockAgentPeerId', {
        createError: new Error('Storage backend unavailable'),
      });
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'photo.png', contentType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ]);

      let caught: unknown;
      try {
        await runImportFileOrchestration({
          agent: gatedAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
          multipartBody: body, boundary: BOUNDARY, assertionName: 'photo-create-gate',
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ImportFileRouteError);
      const routeError = caught as ImportFileRouteError;
      expect(routeError.statusCode).toBe(500);
      expect(routeError.body.extraction.status).toBe('failed');
      expect(routeError.body.extraction.error).toBe('Storage backend unavailable');
      expect(gatedAgent.insertedQuads).toHaveLength(0);
      const assertionUri = contextGraphAssertionUri('cg', gatedAgent.peerId, 'photo-create-gate');
      expect(gatedAgent.droppedGraphs).toEqual([assertionUri]);
      const record = status.get(assertionUri);
      expect(record?.status).toBe('failed');
      expect(record?.error).toBe('Storage backend unavailable');
      expect(record?.tripleCount).toBe(0);
    });


    it('unregistered content type uses the request agent address for skipped import lifecycle and metadata', async () => {
      const requestAgentAddress = '0xRequestAgentAddress';
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'photo.png', contentType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ]);

      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'photo-request-agent',
        requestAgentAddress,
      });

      const requestAssertionUri = contextGraphAssertionUri('cg', requestAgentAddress, 'photo-request-agent');
      const defaultAssertionUri = contextGraphAssertionUri('cg', agent.peerId, 'photo-request-agent');
      expect(result.assertionUri).toBe(requestAssertionUri);
      expect(agent.createdAssertions).toEqual([
        {
          contextGraphId: 'cg',
          name: 'photo-request-agent',
          agentAddress: requestAgentAddress,
          subGraphName: undefined,
        },
      ]);

      const metaGraph = contextGraphMetaUri('cg');
      expect(agent.insertedQuads).toEqual(expect.arrayContaining([
        expect.objectContaining({
          subject: requestAssertionUri,
          predicate: 'http://dkg.io/ontology/sourceFileHash',
          graph: metaGraph,
        }),
      ]));
      expect(agent.insertedQuads.some(q => q.subject === defaultAssertionUri)).toBe(false);
      expect(status.get(requestAssertionUri)?.status).toBe('skipped');
    });


    it('unregistered content type rolls back partial assertion.create metadata on create failure', async () => {
      const partialAgent = makeMockAgent();
      const assertionName = 'photo-partial-create';
      const assertionUri = contextGraphAssertionUri('cg', partialAgent.peerId, assertionName);
      const metaGraph = contextGraphMetaUri('cg');
      const lifecycleUri = assertionLifecycleUri('cg', partialAgent.peerId, assertionName);
      const priorMeta = [
        {
          subject: assertionUri,
          predicate: 'http://dkg.io/ontology/sourceFileHash',
          object: JSON.stringify('old-hash'),
          graph: metaGraph,
        },
        {
          subject: lifecycleUri,
          predicate: 'http://dkg.io/ontology/state',
          object: JSON.stringify('old-state'),
          graph: metaGraph,
        },
      ];
      await partialAgent.store.insert(priorMeta);
      const before = partialAgent.insertedQuads.map(q => ({ ...q }));
      partialAgent.publisher.assertionCreate = async () => {
        await partialAgent.store.createGraph(assertionUri);
        await partialAgent.store.deleteByPattern({ subject: lifecycleUri, graph: metaGraph });
        await partialAgent.store.insert([
          {
            subject: lifecycleUri,
            predicate: 'http://dkg.io/ontology/state',
            object: JSON.stringify('created'),
            graph: metaGraph,
          },
          {
            subject: `${lifecycleUri}/event/create`,
            predicate: 'http://www.w3.org/ns/prov#generated',
            object: lifecycleUri,
            graph: metaGraph,
          },
        ]);
        throw new Error('Storage backend unavailable');
      };
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'photo.png', contentType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ]);

      await expect(runImportFileOrchestration({
        agent: partialAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName,
      })).rejects.toMatchObject({
        statusCode: 500,
        body: {
          extraction: expect.objectContaining({
            status: 'failed',
            error: 'Storage backend unavailable',
          }),
        },
      });

      expect(partialAgent.insertedQuads).toEqual(before);
      await expect(partialAgent.store.hasGraph(assertionUri)).resolves.toBe(false);
      expect(partialAgent.droppedGraphs).toContain(assertionUri);
      expect(partialAgent.insertedQuads.some(q => q.subject === `${lifecycleUri}/event/create`)).toBe(false);
      expect(status.get(assertionUri)?.status).toBe('failed');
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


    it('skipped re-import rolls back previous assertion data and metadata when metadata insert fails', async () => {
      const bodyV1 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# V1\n\nBody.\n', 'utf-8') },
      ]);
      const v1 = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'skip-rollback',
      });
      const assertionGraph = v1.assertionUri;
      const metaGraph = contextGraphMetaUri('cg');
      const dataBefore = agent.insertedQuads
        .filter(q => q.graph === assertionGraph)
        .map(q => ({ ...q }));
      const metaBefore = agent.insertedQuads
        .filter(q => q.graph === metaGraph && q.subject === assertionGraph)
        .map(q => ({ ...q }));
      const statusBefore = { ...status.get(assertionGraph)! };
      expect(statusBefore.status).toBe('completed');

      const failingAgent = makeMockAgent('0xMockAgentPeerId', {
        insertPartialBeforeErrorPredicate: (quads, callNumber) =>
          callNumber === 1
            ? quads
              .filter(q => q.graph === metaGraph && q.subject === assertionGraph)
              .slice(0, 1)
              .map(q => ({ ...q }))
            : null,
        insertErrorPredicate: (_quads, callNumber) =>
          callNumber === 1 ? new Error('simulated skipped metadata insert outage') : null,
      });
      for (const q of agent.insertedQuads) {
        failingAgent.insertedQuads.push({ ...q });
      }

      const bodyV2 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'unsupported.png', contentType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ]);

      await expect(runImportFileOrchestration({
        agent: failingAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'skip-rollback',
      })).rejects.toThrow('simulated skipped metadata insert outage');

      expect(failingAgent.insertedQuads.filter(q => q.graph === assertionGraph)).toEqual(dataBefore);
      expect(failingAgent.insertedQuads.filter(q =>
        q.graph === metaGraph && q.subject === assertionGraph
      )).toEqual(metaBefore);
      expect(failingAgent.insertCallCount).toBe(3);
      expect(status.get(assertionGraph)).toEqual(statusBefore);
    });


    it('skipped re-import rollback restores an existing empty assertion graph', async () => {
      const assertionName = 'skip-empty-graph-rollback';
      const assertionGraph = contextGraphAssertionUri('cg', agent.peerId, assertionName);
      const metaGraph = contextGraphMetaUri('cg');
      const metaBefore = [
        {
          subject: assertionGraph,
          predicate: 'http://dkg.io/ontology/sourceFileHash',
          object: JSON.stringify('keccak256:previous-empty'),
          graph: metaGraph,
        },
        {
          subject: assertionGraph,
          predicate: 'http://dkg.io/ontology/sourceContentType',
          object: JSON.stringify('text/markdown'),
          graph: metaGraph,
        },
        {
          subject: assertionGraph,
          predicate: 'http://dkg.io/ontology/structuralTripleCount',
          object: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: metaGraph,
        },
      ];
      await agent.store.createGraph(assertionGraph);
      await agent.store.insert(metaBefore);
      const statusBefore: ExtractionStatusRecord = {
        status: 'completed',
        fileHash: 'keccak256:previous-empty',
        detectedContentType: 'text/markdown',
        pipelineUsed: 'text/markdown',
        tripleCount: 0,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        completedAt: new Date().toISOString(),
      };
      status.set(assertionGraph, statusBefore);
      await expect(agent.store.hasGraph(assertionGraph)).resolves.toBe(true);

      const failingAgent = makeMockAgent('0xMockAgentPeerId', {
        insertErrorPredicate: (quads) =>
          quads.some(q =>
            q.graph === metaGraph &&
            q.subject === assertionGraph &&
            q.predicate === 'http://dkg.io/ontology/extractionStatus' &&
            q.object === JSON.stringify('skipped')
          )
            ? new Error('simulated skipped metadata insert outage')
            : null,
      });
      await failingAgent.store.createGraph(assertionGraph);
      for (const q of agent.insertedQuads) {
        failingAgent.insertedQuads.push({ ...q });
      }

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'unsupported.png', contentType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ]);

      await expect(runImportFileOrchestration({
        agent: failingAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName,
      })).rejects.toThrow('simulated skipped metadata insert outage');

      await expect(failingAgent.store.hasGraph(assertionGraph)).resolves.toBe(true);
      expect(failingAgent.insertedQuads.filter(q => q.graph === assertionGraph)).toEqual([]);
      expect(failingAgent.insertedQuads.filter(q =>
        q.graph === metaGraph && q.subject === assertionGraph
      )).toEqual(metaBefore);
      expect(status.get(assertionGraph)).toEqual(statusBefore);
    });


    it('skipped re-import restores prior data even when metadata rollback also fails', async () => {
      const bodyV1 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# V1\n\nBody.\n', 'utf-8') },
      ]);
      const v1 = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'skip-rollback-meta-fail',
      });
      const assertionGraph = v1.assertionUri;
      const metaGraph = contextGraphMetaUri('cg');
      const dataBefore = agent.insertedQuads
        .filter(q => q.graph === assertionGraph)
        .map(q => ({ ...q }));

      const failingAgent = makeMockAgent('0xMockAgentPeerId', {
        insertErrorPredicate: (_quads, callNumber) => {
          if (callNumber === 1) return new Error('simulated skipped metadata insert outage');
          if (callNumber === 3) return new Error('simulated metadata rollback outage');
          return null;
        },
      });
      for (const q of agent.insertedQuads) {
        failingAgent.insertedQuads.push({ ...q });
      }

      const bodyV2 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'unsupported.png', contentType: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ]);

      await expect(runImportFileOrchestration({
        agent: failingAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'skip-rollback-meta-fail',
      })).rejects.toThrow('simulated skipped metadata insert outage');

      expect(failingAgent.insertedQuads.filter(q => q.graph === assertionGraph)).toEqual(dataBefore);
      expect(failingAgent.insertCallCount).toBe(3);
      const record = status.get(assertionGraph);
      expect(record?.status).toBe('failed');
      expect(record?.error).toContain('Failed to persist skipped extraction metadata');
      expect(record?.error).toContain('metadata rollback failed: simulated metadata rollback outage');
      expect(failingAgent.insertedQuads.filter(q =>
        q.graph === metaGraph && q.subject === assertionGraph
      )).toHaveLength(0);
    });
});
