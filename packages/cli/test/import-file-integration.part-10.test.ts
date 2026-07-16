import { describe, it, expect, beforeEach, afterEach, mkdtemp, rm, readFile, tmpdir, join, existsSync, ExtractionPipelineRegistry, autoPartition, findReservedSubjectPrefix, FileStore, parseBoundary, extractFromMarkdown, contextGraphAssertionUri, contextGraphMetaUri, assertionLifecycleUri, ImportFileRouteError, makeMockAgent, getDataGraphQuads, BOUNDARY, CRLF, buildMultipart, type ExtractionPipeline, type ExtractionInput, type ConverterOutput, type ExtractionStatusRecord, type CapturedQuad, type MockAgent } from './import-file-test-helpers';
import { runImportFileOrchestration } from './import-file-orchestration.shared';

describe('import-file orchestration — boundary parsing', () => {

    it('parseBoundary extracts boundary from the daemon-style header', () => {
      expect(parseBoundary(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(BOUNDARY);
    });


    it('parseBoundary rejects non-multipart requests', () => {
      expect(parseBoundary('application/json')).toBeNull();
    });
});
