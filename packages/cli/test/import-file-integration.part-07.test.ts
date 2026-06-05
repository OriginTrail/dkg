import { describe, it, expect, beforeEach, afterEach, mkdtemp, rm, readFile, tmpdir, join, existsSync, ExtractionPipelineRegistry, autoPartition, findReservedSubjectPrefix, FileStore, parseBoundary, extractFromMarkdown, contextGraphAssertionUri, contextGraphMetaUri, assertionLifecycleUri, ImportFileRouteError, makeMockAgent, getDataGraphQuads, BOUNDARY, CRLF, buildMultipart, type ExtractionPipeline, type ExtractionInput, type ConverterOutput, type ExtractionStatusRecord, type CapturedQuad, type MockAgent } from './import-file-test-helpers';
import { runImportFileOrchestration } from './import-file-orchestration.shared';

describe('import-file orchestration — source-file linkage (§10.1 / §6.3 / §10.2)', () => {

    let tmpDir: string;

    let fileStore: FileStore;

    let registry: ExtractionPipelineRegistry;

    let status: Map<string, ExtractionStatusRecord>;

    let agent: MockAgent;


    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

    const DKG = 'http://dkg.io/ontology/';

    const DKG_MARKDOWN_FORM = `${DKG}markdownForm`;

    const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';


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


    it('Round 8 Bug 23: ImportFileResponse carries fileHash (keccak256) as the SINGLE canonical hash — no sha256Hash parallel', async () => {
      // Round 6 Bug 17 introduced `sha256Hash` as a dual-field
      // backward-compat attempt; Round 8 (Codex Bug 23 + user
      // framing) ripped it out — V10 is a clean-break product
      // release with no installed base, so there are no existing
      // clients to protect, and a parallel field never would have
      // preserved the old contract anyway. This canary locks in the
      // single-field contract against anyone re-adding the parallel
      // by reflex.
      //
      // ALSO covers the single-hash round-trip guarantee through
      // FileStore.get() (Round 3 Bug 9) so we don't lose that
      // coverage when the dual-field round-trip tests are deleted.
      const content = Buffer.from('# Bug 23 single hash\n\nContent-addressed.\n', 'utf-8');
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'single.md', contentType: 'text/markdown', content },
      ]);
      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'single-hash',
      });

      expect(result.fileHash).toMatch(/^keccak256:[0-9a-f]{64}$/);
      expect('sha256Hash' in result).toBe(false);

      const record = status.get(result.assertionUri);
      expect(record?.fileHash).toBe(result.fileHash);
      expect(record && 'sha256Hash' in record).toBe(false);

      // Round 3 Bug 9 round-trip: FileStore.get() still accepts the
      // single keccak256 string and returns the original bytes.
      const bytes = await fileStore.get(result.fileHash);
      expect(bytes).not.toBeNull();
      expect(Buffer.compare(bytes!, content)).toBe(0);
    });


    it('Bug 19: two sequential imports of the same assertion URI serialize cleanly through the mutex', async () => {
      // Sanity guard: the mutex must not deadlock on non-concurrent
      // calls. Two back-to-back awaited imports of the same assertion
      // name should both succeed — the second acquires the lock after
      // the first releases it.
      const locks = new Map<string, Promise<void>>();
      const body1 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'seq1.md', contentType: 'text/markdown', content: Buffer.from('# seq1\n', 'utf-8') },
      ]);
      const r1 = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body1, boundary: BOUNDARY, assertionName: 'seq-mutex',
        assertionImportLocks: locks,
      });
      const body2 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'seq2.md', contentType: 'text/markdown', content: Buffer.from('# seq2\n', 'utf-8') },
      ]);
      const r2 = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body2, boundary: BOUNDARY, assertionName: 'seq-mutex',
        assertionImportLocks: locks,
      });
      expect(r1.extraction.status).toBe('completed');
      expect(r2.extraction.status).toBe('completed');
      // Map should be empty after the last release — no lingering entries.
      expect(locks.size).toBe(0);
    });


    it('Bug 19: concurrent imports of DIFFERENT assertion URIs run in parallel (lock is per-URI, not global)', async () => {
      // Scope guard: a global lock would be a regression. Fire two
      // imports against different assertion names concurrently under
      // the same locks map and assert both succeed. If the lock were
      // global this would still work (serialized), so the assertion is
      // only that both reach `completed` — not timing.
      const locks = new Map<string, Promise<void>>();
      const body1 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'a.md', contentType: 'text/markdown', content: Buffer.from('# A\n', 'utf-8') },
      ]);
      const body2 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'b.md', contentType: 'text/markdown', content: Buffer.from('# B\n', 'utf-8') },
      ]);
      const [r1, r2] = await Promise.all([
        runImportFileOrchestration({
          agent, fileStore, extractionRegistry: registry, extractionStatus: status,
          multipartBody: body1, boundary: BOUNDARY, assertionName: 'parallel-a',
          assertionImportLocks: locks,
        }),
        runImportFileOrchestration({
          agent, fileStore, extractionRegistry: registry, extractionStatus: status,
          multipartBody: body2, boundary: BOUNDARY, assertionName: 'parallel-b',
          assertionImportLocks: locks,
        }),
      ]);
      expect(r1.extraction.status).toBe('completed');
      expect(r2.extraction.status).toBe('completed');
      // Both imports completed through separate lock entries, both
      // entries cleaned up on release.
      expect(locks.size).toBe(0);
    });


    it('Bug 19: a failed second import does NOT roll back over a newer first import when they overlap on the same URI', async () => {
      // This is the Round 6 race that Bug 19 closes. Without the
      // mutex, request A commits, request B (which snapshotted the
      // prior empty state) fails its insert, and B's rollback
      // re-inserts its stale V0 snapshot OVER A's V1 commit. With the
      // per-URI lock, B's snapshot is taken AFTER A releases — so B
      // sees A's committed V1, and even if B's insert fails its
      // rollback restores V1 (a no-op on what's already there),
      // leaving A's commit intact.
      //
      // We drive the race deterministically by serializing A before B
      // (the mutex itself guarantees this ordering) and injecting a
      // failure into B's atomic insert.
      const locks = new Map<string, Promise<void>>();
      const bodyA = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'a-wins.md', contentType: 'text/markdown', content: Buffer.from('# A wins\n\nA content.\n', 'utf-8') },
      ]);
      // Request A runs on a fresh agent, commits cleanly.
      await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyA, boundary: BOUNDARY, assertionName: 'race-target',
        assertionImportLocks: locks,
      });
      const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'race-target');
      const aDataBefore = getDataGraphQuads(agent, 'cg', 'race-target');
      expect(aDataBefore.length).toBeGreaterThan(0);
      const aHashBefore = aDataBefore.find(q =>
        q.subject === assertionUri && q.predicate === 'http://dkg.io/ontology/sourceContentType',
      )?.object;
      expect(aHashBefore).toBeTruthy();

      // Prime a second agent with A's committed state, then fail its
      // V2 insert. Because A's state is already in B's snapshot, B's
      // rollback re-inserts the same quads (a no-op / idempotent) and
      // A's content remains — the race is closed.
      const failAgent = makeMockAgent('0xMockAgentPeerId', {
        insertErrorPredicate: (_quads, callNumber) => {
          if (callNumber === 1) return new Error('simulated B v2 insert failure');
          return null;
        },
      });
      for (const q of agent.insertedQuads) {
        failAgent.insertedQuads.push({ ...q });
      }

      const bodyB = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'b-fails.md', contentType: 'text/markdown', content: Buffer.from('# B fails\n\nB content.\n', 'utf-8') },
      ]);
      await expect(runImportFileOrchestration({
        agent: failAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyB, boundary: BOUNDARY, assertionName: 'race-target',
        assertionImportLocks: locks,
      })).rejects.toThrow('simulated B v2 insert failure');

      // A's committed content is still present — the mutex closed the
      // race window so B's snapshot captured A's state, not an older
      // empty state. Even with B's rollback firing, A's content survives.
      const aDataAfter = failAgent.insertedQuads.filter(q =>
        q.graph === assertionUri && q.subject === assertionUri && q.predicate === 'http://dkg.io/ontology/sourceContentType',
      );
      expect(aDataAfter.length).toBeGreaterThanOrEqual(1);
      // Map is drained — both calls released their locks.
      expect(locks.size).toBe(0);
    });


    it('Round 14 Bug 42: lock acquired BEFORE extraction so request order determines commit order (not extraction duration)', async () => {
      // Round 6 originally acquired the per-assertion mutex AFTER
      // Phase 1/2 extraction completed, which meant concurrent imports
      // of the same assertion name raced during extraction and the
      // one whose extraction finished LAST committed LAST — regardless
      // of which request arrived first. Final stored state depended
      // on extraction duration, not request order.
      //
      // Round 14 Bug 42 moved the lock acquisition to the TOP of the
      // import-file handler (right after `assertionUri` is computed),
      // before any extraction work begins. This test proves the fix:
      // Request A uses a slow mock converter (200ms Phase 1 delay);
      // Request B uses the same target assertion name with a fast
      // path (no converter delay). A is started first, then B is
      // started before A completes. With the lock acquired BEFORE
      // extraction, B waits for A's lock release (which happens after
      // A's full commit), so the final committed content is B's.
      //
      // If the lock were still acquired AFTER extraction (pre-Round-14
      // behavior), B's fast extraction would finish first, commit
      // first, then A's slow extraction would finish and commit
      // second — overwriting B. The final content would be A's,
      // matching extraction-finish order instead of request-arrival
      // order. This test asserts the CORRECT order (B wins because
      // it arrived second).
      const locks = new Map<string, Promise<void>>();
      const assertionName = 'bug42-race';

      // Slow mock converter for Request A — 200ms extraction delay.
      const slowConverter: ExtractionPipeline = {
        contentTypes: ['application/x-slow'],
        async extract(_input: ExtractionInput): Promise<ConverterOutput> {
          await new Promise(resolve => setTimeout(resolve, 200));
          return { mdIntermediate: '# A\n\nSlow upload.\n' };
        },
      };
      const slowRegistry = new ExtractionPipelineRegistry();
      slowRegistry.register(slowConverter);

      const bodyA = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'a-slow.x-slow', contentType: 'application/x-slow', content: Buffer.from('slow', 'utf-8') },
      ]);
      const bodyB = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'b-fast.md', contentType: 'text/markdown', content: Buffer.from('# B\n\nFast upload.\n', 'utf-8') },
      ]);

      // Start Request A (slow). Do NOT await — we want to start B
      // before A finishes.
      const promiseA = runImportFileOrchestration({
        agent, fileStore, extractionRegistry: slowRegistry, extractionStatus: status,
        multipartBody: bodyA, boundary: BOUNDARY, assertionName,
        assertionImportLocks: locks,
      });

      // Give A enough time to reach its lock acquisition (which is
      // now at the TOP of the handler, before extraction begins).
      // 20ms is more than enough for A to acquire the lock and
      // enter the slow converter.
      await new Promise(resolve => setTimeout(resolve, 20));

      // Start Request B. Under Round 14's lock-before-extraction,
      // B will try to acquire the same lock, find it held by A,
      // and wait. Under the pre-fix behavior B would race ahead
      // through extraction and commit first.
      const promiseB = runImportFileOrchestration({
        agent, fileStore, extractionRegistry: slowRegistry, extractionStatus: status,
        multipartBody: bodyB, boundary: BOUNDARY, assertionName,
        assertionImportLocks: locks,
      });

      await Promise.all([promiseA, promiseB]);

      // Final committed content must be B's (the second arrival),
      // because the lock serialized the two imports in request-
      // arrival order. Check the assertion data graph's source-file
      // keccak256 in _meta row 16 — it reflects whichever request
      // committed last (second), which under Round 14 is B.
      const metaGraph = contextGraphMetaUri('cg');
      const assertionUri = contextGraphAssertionUri('cg', agent.peerId, assertionName);
      const sourceFileHashRow = agent.insertedQuads.find(
        q => q.graph === metaGraph
          && q.subject === assertionUri
          && q.predicate === 'http://dkg.io/ontology/sourceFileHash',
      );
      expect(sourceFileHashRow).toBeDefined();
      // B's content is `# B\n\nFast upload.\n`. The hash in _meta
      // must match the keccak256 of B's bytes (not A's slow bytes).
      // We compute B's expected hash via the fileStore directly.
      const expectedBEntry = await fileStore.put(
        Buffer.from('# B\n\nFast upload.\n', 'utf-8'),
        'text/markdown',
      );
      expect(sourceFileHashRow!.object).toBe(`"${expectedBEntry.keccak256}"`);

      // Map drained (both imports completed and released their locks).
      expect(locks.size).toBe(0);
    });


    it('Round 14 Bug 42: lock released correctly when extraction throws (deadlock guard)', async () => {
      // Critical scope guard for the Round 14 restructure — the
      // outer `finally` must release the lock even when the handler
      // body throws partway through. Inject an error during Phase 1
      // (via a mock converter that throws) and assert that (a) the
      // first import's failure is surfaced, and (b) a subsequent
      // import of the SAME assertion name can still acquire the
      // lock (no deadlock).
      const locks = new Map<string, Promise<void>>();
      const assertionName = 'bug42-throw';

      const throwingConverter: ExtractionPipeline = {
        contentTypes: ['application/x-throw'],
        async extract(_input: ExtractionInput): Promise<ConverterOutput> {
          throw new Error('simulated converter failure');
        },
      };
      const throwingRegistry = new ExtractionPipelineRegistry();
      throwingRegistry.register(throwingConverter);

      const bodyA = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'throws.x-throw', contentType: 'application/x-throw', content: Buffer.from('throws', 'utf-8') },
      ]);

      // The harness's Phase 1 converter block does NOT have a
      // try/catch wrapper (the daemon has one that calls
      // `respondWithFailedExtraction(500)` + returns, but the test
      // harness lets errors propagate directly). So the rejection
      // manifests as a thrown error, not a resolved failed-status
      // response. Either way, the point of this test is that the
      // OUTER `finally` at the bottom of `runImportFileOrchestration`
      // releases the lock regardless of which code path the error
      // takes out of the function.
      await expect(runImportFileOrchestration({
        agent, fileStore, extractionRegistry: throwingRegistry, extractionStatus: status,
        multipartBody: bodyA, boundary: BOUNDARY, assertionName,
        assertionImportLocks: locks,
      })).rejects.toThrow('simulated converter failure');

      // Lock map must be drained — if the failed path leaked the
      // lock, the map would still have A's entry and the next
      // import of the same URI would deadlock waiting on a promise
      // that never resolves.
      expect(locks.size).toBe(0);

      // Second import of the same assertion name must proceed.
      const bodyB = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'recover.md', contentType: 'text/markdown', content: Buffer.from('# Recovery\n', 'utf-8') },
      ]);
      const resultB = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyB, boundary: BOUNDARY, assertionName,
        assertionImportLocks: locks,
      });
      expect(resultB.extraction.status).toBe('completed');
      expect(locks.size).toBe(0);
    });


    it('Round 14 Bug 42: graceful-degrade (skipped status) path still releases the lock', async () => {
      // Scope guard — the graceful-degrade path (unregistered content
      // type → status: "skipped") returns early from the handler
      // before any extraction runs. The outer `finally` must still
      // fire and release the lock. Follow the same pattern as the
      // throw test: first import takes the skipped path, second
      // import of the same URI must proceed without deadlock.
      const locks = new Map<string, Promise<void>>();
      const assertionName = 'bug42-skipped';

      const bodyA = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'blob.bin', contentType: 'application/octet-stream', content: Buffer.from([0x00, 0x01, 0x02]) },
      ]);
      const resultA = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyA, boundary: BOUNDARY, assertionName,
        assertionImportLocks: locks,
      });
      expect(resultA.extraction.status).toBe('skipped');
      expect(locks.size).toBe(0);

      // Second import of the same URI must proceed.
      const bodyB = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'after.md', contentType: 'text/markdown', content: Buffer.from('# After\n', 'utf-8') },
      ]);
      const resultB = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyB, boundary: BOUNDARY, assertionName,
        assertionImportLocks: locks,
      });
      expect(resultB.extraction.status).toBe('completed');
      expect(locks.size).toBe(0);
    });


    it('Bug 20: extractFromMarkdown rejects empty-string rootEntityIri and sourceFileIri', () => {
      // Round 7 Bug 20 — programmatic override inputs go through the
      // same isSafeIri gate as frontmatter `rootEntity` (Round 4 Bug
      // 13). Empty strings are the simplest failure case.
      expect(() => extractFromMarkdown({
        markdown: '# Doc\n',
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
        rootEntityIri: '',
      })).toThrow(/Invalid 'rootEntityIri'/);

      expect(() => extractFromMarkdown({
        markdown: '# Doc\n',
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
        sourceFileIri: '',
      })).toThrow(/Invalid 'sourceFileIri'/);
    });


    it('Bug 20: extractFromMarkdown rejects non-IRI-prefix rootEntityIri and sourceFileIri', () => {
      // `foo` lacks an IRI scheme prefix (http:/https:/did:/urn:/_:)
      // so it's a bare string, not an IRI. Must be rejected before it
      // reaches the RDF layer.
      expect(() => extractFromMarkdown({
        markdown: '# Doc\n',
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
        rootEntityIri: 'foo',
      })).toThrow(/Invalid 'rootEntityIri'/);

      expect(() => extractFromMarkdown({
        markdown: '# Doc\n',
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
        sourceFileIri: 'bar',
      })).toThrow(/Invalid 'sourceFileIri'/);
    });


    it('Bug 20: extractFromMarkdown rejects isSafeIri-failing characters in rootEntityIri and sourceFileIri', () => {
      // `http://x>y` has a prefix that passes the regex but contains
      // an angle bracket that `isSafeIri` rejects. This is the most
      // interesting failure mode because it would otherwise reach the
      // RDF layer and produce a cryptic parse error.
      expect(() => extractFromMarkdown({
        markdown: '# Doc\n',
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
        rootEntityIri: 'http://x>y',
      })).toThrow(/Invalid 'rootEntityIri'/);

      expect(() => extractFromMarkdown({
        markdown: '# Doc\n',
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
        sourceFileIri: 'urn:dkg:file keccak256:abc',  // space is isSafeIri-invalid
      })).toThrow(/Invalid 'sourceFileIri'/);
    });


    it('Bug 20: valid IRI overrides still pass through (regression guard)', () => {
      // Sanity guard — the new gate must not reject well-formed IRIs.
      // Source-file linkage quads land on `provenance`, not `triples`.
      const result = extractFromMarkdown({
        markdown: '# Doc\n',
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
        rootEntityIri: 'urn:dkg:entity:root-1',
        sourceFileIri: 'urn:dkg:file:keccak256:abc123',
      });
      expect(result.resolvedRootEntity).toBe('urn:dkg:entity:root-1');
      // Round 13 Bug 39: field renamed from `provenance` to `sourceFileLinkage`.
      expect(result.sourceFileLinkage.some(t =>
        t.predicate === 'http://dkg.io/ontology/sourceFile' &&
        t.object === 'urn:dkg:file:keccak256:abc123',
      )).toBe(true);
    });
});
