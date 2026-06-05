import { describe, it, expect, beforeEach, afterEach, mkdtemp, rm, readFile, tmpdir, join, existsSync, ExtractionPipelineRegistry, autoPartition, findReservedSubjectPrefix, FileStore, parseBoundary, extractFromMarkdown, contextGraphAssertionUri, contextGraphMetaUri, assertionLifecycleUri, ImportFileRouteError, makeMockAgent, getDataGraphQuads, BOUNDARY, CRLF, buildMultipart, type ExtractionPipeline, type ExtractionInput, type ConverterOutput, type ExtractionStatusRecord, type CapturedQuad, type MockAgent } from './import-file-test-helpers';
import { runImportFileOrchestration } from './import-file-orchestration.shared';

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


    it('records failed extraction status when the atomic insert rejects invalid triples', async () => {
      agent = makeMockAgent('0xMockAgentPeerId', {
        insertError: new Error('Invalid triple object'),
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


    it('treats a blank contentType form field as absent and falls back to the file part Content-Type', async () => {
      // A client that submits `contentType=` (empty string) must NOT downgrade
      // a real text/markdown upload to application/octet-stream — the empty
      // override should be ignored and the file part's own Content-Type used.
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'text', name: 'contentType', value: '' },
        { kind: 'file', name: 'file', filename: 'note.md', contentType: 'text/markdown', content: Buffer.from('# Heading\n\nBody text.\n', 'utf-8') },
      ]);

      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'blank-override',
      });

      expect(result.detectedContentType).toBe('text/markdown');
      expect(result.extraction.status).toBe('completed');
      expect(result.extraction.pipelineUsed).toBe('text/markdown');
      expect(result.extraction.tripleCount).toBeGreaterThan(0);
    });


    it('treats a whitespace-only contentType form field as absent', async () => {
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'text', name: 'contentType', value: '   ' },
        { kind: 'file', name: 'file', filename: 'note.md', contentType: 'text/markdown', content: Buffer.from('# Heading\n', 'utf-8') },
      ]);

      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'whitespace-override',
      });

      expect(result.detectedContentType).toBe('text/markdown');
      expect(result.extraction.status).toBe('completed');
    });


    it('records failed extraction status when the atomic insert throws an unexpected error', async () => {
      // Any error thrown from the atomic insert must update the
      // extraction status record from in_progress to failed before the
      // orchestration rethrows. Otherwise /extraction-status would
      // stay stuck reporting in_progress even though the import already
      // failed. Round 10 Bug 29 removed the substring-based 400 mapping
      // from this outer catch, so an atomic-insert failure now always
      // surfaces as a raw rethrow for the top-level 500 handler.
      agent = makeMockAgent('0xMockAgentPeerId', {
        insertError: new Error('Connection refused'),
      });

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
      ]);

      await expect(runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'unexpected-write',
      })).rejects.toThrow('Connection refused');

      const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'unexpected-write');
      const record = status.get(assertionUri);
      expect(record).toBeDefined();
      expect(record?.status).toBe('failed');
      expect(record?.error).toBe('Connection refused');
      expect(record?.tripleCount).toBeGreaterThan(0);
      expect(record?.completedAt).toBeDefined();
    });


    it('Round 10 Bug 29: atomic insert failure with `Invalid`-in-message rethrows raw (not a 400 ImportFileRouteError)', async () => {
      // Round 10 Bug 29 fix: the outer catch used to map any error
      // message containing `Invalid` or `Unsafe` to a 400
      // ImportFileRouteError. That widened too far once the outer try
      // block grew to wrap snapshot/cleanup/dropGraph/insert —
      // an internal storage error whose message happens to contain
      // `Invalid` (e.g., Oxigraph's `Invalid query plan` or an
      // adapter's `Invalid triple object`) would be misclassified as
      // a user-input validation failure and get a 400 back, when in
      // reality it's a 500 server-side issue. The fix removed the
      // substring-based 400 mapping from the outer catch. The inner
      // `assertion.create` catch still maps its own 400s.
      //
      // Regression: a simulated internal storage error with `Invalid`
      // in its message must now rethrow as a raw Error (routed to the
      // top-level 500 handler), NOT as a 400 ImportFileRouteError.
      // The extraction status record still gets updated to `failed`
      // with the underlying message preserved.
      agent = makeMockAgent('0xMockAgentPeerId', {
        insertError: new Error('Invalid triple object'),
      });

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
      ]);

      let caught: unknown;
      try {
        await runImportFileOrchestration({
          agent, fileStore, extractionRegistry: registry, extractionStatus: status,
          multipartBody: body, boundary: BOUNDARY, assertionName: 'internal-invalid',
        });
      } catch (err) {
        caught = err;
      }

      // Raw Error, NOT an ImportFileRouteError — proves the over-wide
      // 400 mapping is gone.
      expect(caught).toBeDefined();
      expect(caught).not.toBeInstanceOf(ImportFileRouteError);
      expect((caught as Error).message).toBe('Invalid triple object');

      // Extraction status still records the failure, so /extraction-status
      // doesn't stay stuck at in_progress.
      const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'internal-invalid');
      const record = status.get(assertionUri);
      expect(record?.status).toBe('failed');
      expect(record?.error).toBe('Invalid triple object');
    });


    it('Round 10 Bug 29: atomic insert failure with `Unsafe`-in-message also rethrows raw (substring match is gone entirely)', async () => {
      // Symmetric guard for the `Unsafe` half of the old substring
      // match. Same semantic: `Unsafe write`, `Unsafe literal` etc.
      // from an adapter are internal storage errors, 500 not 400.
      agent = makeMockAgent('0xMockAgentPeerId', {
        insertError: new Error('Unsafe replication target'),
      });

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n', 'utf-8') },
      ]);

      let caught: unknown;
      try {
        await runImportFileOrchestration({
          agent, fileStore, extractionRegistry: registry, extractionStatus: status,
          multipartBody: body, boundary: BOUNDARY, assertionName: 'internal-unsafe',
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).not.toBeInstanceOf(ImportFileRouteError);
      expect((caught as Error).message).toBe('Unsafe replication target');
    });


    it('Round 10 Bug 29: genuine `assertion.create` user-input errors STILL map to 400 (inner catch unchanged)', async () => {
      // Positive regression — the inner `assertion.create` catch is
      // the only place user-input validation errors legitimately
      // originate in this block, and it still maps them to 400 via
      // `respondWithFailedExtraction`. The Bug 29 fix only narrowed
      // the OUTER catch, not the inner.
      agent = makeMockAgent('0xMockAgentPeerId', {
        createError: new Error('Invalid sub-graph name: reserved-word'),
      });

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n', 'utf-8') },
      ]);

      let caught: unknown;
      try {
        await runImportFileOrchestration({
          agent, fileStore, extractionRegistry: registry, extractionStatus: status,
          multipartBody: body, boundary: BOUNDARY, assertionName: 'user-invalid-create',
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ImportFileRouteError);
      expect((caught as ImportFileRouteError).statusCode).toBe(400);
      expect((caught as ImportFileRouteError).body.extraction.error).toContain('Invalid sub-graph name');
    });


    it('Round 13 Bug 38: data-graph snapshot failure preserves the stage-specific error message in extraction-status (not overwritten by outer catch)', async () => {
      // Round 13 Bug 38: when the rollback-snapshot CONSTRUCT query
      // fails, `recordFailedExtraction` is called with a stage-specific
      // message ("Failed to snapshot assertion data graph for rollback:
      // <underlying>"). Before the fix, the outer catch later called
      // `recordFailedExtraction` again with just the raw underlying
      // message, overwriting the stage context — a caller reading
      // `/extraction-status` saw "connection refused" instead of
      // "Failed at snapshot stage: connection refused".
      //
      // The fix marks the thrown error with `__failureAlreadyRecorded`
      // and the outer catch skips re-recording when it sees the flag.
      // This test injects a failure on the data-graph snapshot CONSTRUCT
      // (the first of the two snapshot queries — matches `?s ?p ?o`
      // pattern without a bound subject) and asserts the extraction
      // status record retains the stage-specific message.
      agent = makeMockAgent('0xMockAgentPeerId', {
        queryErrorPredicate: (sparql) => {
          // Data-graph snapshot uses the unbound `?s ?p ?o` pattern.
          // `_meta` snapshot uses a bound `<subject> ?p ?o` pattern.
          // Target only the unbound form so the other query shapes
          // (`_meta` snapshot, or any other CONSTRUCT) still work.
          if (/CONSTRUCT\s*\{\s*\?s\s+\?p\s+\?o\s*\}/.test(sparql)) {
            return new Error('simulated data-graph snapshot failure');
          }
          return null;
        },
      });

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'data-snap.md', contentType: 'text/markdown', content: Buffer.from('# Snapshot\n', 'utf-8') },
      ]);

      await expect(runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'data-snap-fail',
      })).rejects.toThrow('simulated data-graph snapshot failure');

      const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'data-snap-fail');
      const record = status.get(assertionUri);
      expect(record).toBeDefined();
      expect(record?.status).toBe('failed');
      // The CRITICAL assertion: the stage-specific context survives.
      expect(record?.error).toContain('Failed to snapshot assertion data graph for rollback');
      expect(record?.error).toContain('simulated data-graph snapshot failure');
      // Negative assertion: the error is NOT just the raw underlying
      // message (which would mean the outer catch overwrote the stage
      // context — pre-fix behavior).
      expect(record?.error).not.toBe('simulated data-graph snapshot failure');
    });


    it('Round 13 Bug 38: `_meta` snapshot failure preserves the stage-specific error message (symmetric guard)', async () => {
      // Symmetric test for the `_meta` snapshot query (the second of
      // the two CONSTRUCTs, uses a bound-subject pattern). The fix
      // applied to both snapshot branches, so both need a regression.
      const bodyV1 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1\n', 'utf-8') },
      ]);
      // Seed V1 so the `_meta` snapshot query has something to fail on
      // during the V2 attempt (otherwise the first-import empty-snapshot
      // case might short-circuit before the query even runs).
      await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'meta-snap-fail',
      });

      // Prime a fresh agent with V1's state and inject a `_meta` query
      // failure. The `_meta` snapshot CONSTRUCT uses a bound subject.
      const failAgent = makeMockAgent('0xMockAgentPeerId', {
        queryErrorPredicate: (sparql) => {
          // Target the bound-subject form: `CONSTRUCT { <subj> ?p ?o }`.
          if (/CONSTRUCT\s*\{\s*<[^>]+>\s+\?p\s+\?o\s*\}/.test(sparql)) {
            return new Error('simulated _meta snapshot failure');
          }
          return null;
        },
      });
      for (const q of agent.insertedQuads) {
        failAgent.insertedQuads.push({ ...q });
      }

      const bodyV2 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2\n', 'utf-8') },
      ]);
      await expect(runImportFileOrchestration({
        agent: failAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'meta-snap-fail',
      })).rejects.toThrow('simulated _meta snapshot failure');

      const assertionUri = contextGraphAssertionUri('cg', failAgent.peerId, 'meta-snap-fail');
      const record = status.get(assertionUri);
      expect(record?.status).toBe('failed');
      expect(record?.error).toContain('Failed to snapshot _meta for rollback');
      expect(record?.error).toContain('simulated _meta snapshot failure');
      expect(record?.error).not.toBe('simulated _meta snapshot failure');
    });


    it('Round 13 Bug 38: non-snapshot write-stage failures still get outer-catch recording (preservation canary)', async () => {
      // Canary: the `__failureAlreadyRecorded` flag must not suppress
      // outer-catch recording when the error originates from a path
      // that was NEVER stage-specifically recorded. Force an error in
      // the atomic `store.insert` step (which does NOT set the flag
      // itself unless the rollback also fails — Round 5/6/7 compound
      // path) and assert the outer catch still records a `failed`
      // status so /extraction-status doesn't stay stuck at in_progress.
      agent = makeMockAgent('0xMockAgentPeerId', {
        insertError: new Error('Connection refused'),
      });

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'ext.md', contentType: 'text/markdown', content: Buffer.from('# Ext\n', 'utf-8') },
      ]);

      await expect(runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'non-snapshot-fail',
      })).rejects.toThrow('Connection refused');

      const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'non-snapshot-fail');
      const record = status.get(assertionUri);
      expect(record?.status).toBe('failed');
      // Outer catch still recorded the raw message (this path has
      // no stage-specific predecessor, so the Round 13 flag check
      // correctly lets the outer catch write the error).
      expect(record?.error).toBe('Connection refused');
    });
});
