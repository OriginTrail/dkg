import { describe, it, expect, beforeEach, afterEach, mkdtemp, rm, readFile, tmpdir, join, existsSync, ExtractionPipelineRegistry, autoPartition, findReservedSubjectPrefix, FileStore, parseBoundary, extractFromMarkdown, contextGraphAssertionUri, contextGraphMetaUri, assertionLifecycleUri, ImportFileRouteError, makeMockAgent, getDataGraphQuads, BOUNDARY, CRLF, buildMultipart, type ExtractionPipeline, type ExtractionInput, type ConverterOutput, type ExtractionStatusRecord, type CapturedQuad, type MockAgent } from './import-file-test-helpers';
import { runImportFileOrchestration } from './import-file-orchestration.shared';

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
