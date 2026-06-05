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


    it('Bug 22: dropGraph failure restores the metaSnapshot that deleteByPattern just cleared', async () => {
      // Round 7 Bug 22 — the narrow window where `deleteByPattern`
      // succeeds but `dropGraph` fails used to leave the old `_meta`
      // rows gone with the data graph still intact (self-inconsistent
      // state, no rollback fires). Bug 22 extends the rollback path
      // to cover this case: on dropGraph failure, metaSnapshot is
      // re-inserted.
      //
      // Prime V1, then fail V2's dropGraph and assert V1's `_meta`
      // rows are byte-perfect restored from the snapshot.
      const bodyV1 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1\n\nReliable.\n', 'utf-8') },
      ]);
      const resultV1 = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'bug22-target',
      });
      const assertionUri = resultV1.assertionUri;
      const metaGraphUri = contextGraphMetaUri('cg');

      // Snapshot V1's `_meta` rows keyed by this assertion before the
      // failing V2 attempt.
      const v1Meta = agent.insertedQuads.filter(q =>
        q.graph === metaGraphUri && q.subject === assertionUri,
      );
      expect(v1Meta.length).toBeGreaterThanOrEqual(6);
      const v1SourceFileHash = v1Meta.find(q => q.predicate === `${DKG}sourceFileHash`)?.object;
      expect(v1SourceFileHash).toBe(`"${resultV1.fileHash}"`);

      // Prime a fresh agent with V1's state, inject a dropGraph
      // failure. V2 attempt: deleteByPattern(_meta) succeeds (removes
      // V1's meta rows), dropGraph throws → Bug 22 path restores
      // metaSnapshot.
      const failAgent = makeMockAgent('0xMockAgentPeerId', {
        dropGraphError: new Error('simulated dropGraph outage'),
      });
      for (const q of agent.insertedQuads) {
        failAgent.insertedQuads.push({ ...q });
      }

      const bodyV2 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2\n\nWill fail.\n', 'utf-8') },
      ]);
      await expect(runImportFileOrchestration({
        agent: failAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'bug22-target',
      })).rejects.toThrow('simulated dropGraph outage');

      // V1's `_meta` rows were cleared by deleteByPattern then
      // restored by the Bug 22 rollback. The same keccak256 hash
      // literal that row 16 carried for V1 must still be present.
      const metaAfter = failAgent.insertedQuads.filter(q =>
        q.graph === metaGraphUri && q.subject === assertionUri,
      );
      const restoredSourceFileHash = metaAfter.find(q => q.predicate === `${DKG}sourceFileHash`)?.object;
      expect(restoredSourceFileHash).toBe(v1SourceFileHash);
      expect(metaAfter.length).toBeGreaterThanOrEqual(v1Meta.length);

      // V1's data graph is untouched (dropGraph threw BEFORE doing
      // anything, so no rollback is needed on the data side).
      const assertionGraph = contextGraphAssertionUri('cg', failAgent.peerId, 'bug22-target');
      const dataAfter = failAgent.insertedQuads.filter(q => q.graph === assertionGraph);
      expect(dataAfter.length).toBeGreaterThan(0);
    });


    it('Bug 22: deleteByPattern failure triggers NO rollback (nothing was corrupted)', async () => {
      // Inverse guard. If deleteByPattern fails before doing anything,
      // metaCleanupSucceeded stays false and the rollback path must
      // NOT fire — otherwise we'd be inserting stale snapshots into a
      // store that never changed.
      const bodyV1 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1\n', 'utf-8') },
      ]);
      await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'bug22-nothing',
      });

      const failAgent = makeMockAgent('0xMockAgentPeerId', {
        deleteByPatternError: new Error('simulated delete outage'),
      });
      for (const q of agent.insertedQuads) {
        failAgent.insertedQuads.push({ ...q });
      }
      // Count insertion calls so we can prove the rollback did NOT
      // fire. After the priming, the next insert should be the one
      // that the failing import tries and never reaches.
      const insertCountBefore = failAgent.insertCallCount;

      const bodyV2 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2\n', 'utf-8') },
      ]);
      await expect(runImportFileOrchestration({
        agent: failAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'bug22-nothing',
      })).rejects.toThrow('simulated delete outage');

      // No new insert calls — neither the V2 commit nor any rollback
      // re-insert fired. The state is unchanged so no rollback was
      // needed.
      expect(failAgent.insertCallCount).toBe(insertCountBefore);
    });


    it('Bug 12: assertionDiscard runs `_meta` cleanup BEFORE dropGraph (mock mirrors publisher ordering)', async () => {
      // Regression guard for the Round 4 Bug 12 ordering flip. The mock
      // discard method (`agent.assertion.discard`) now calls
      // `deleteByPattern` first, then `dropGraph`. A `deleteByPattern`
      // failure leaves the data graph intact, which is the retry-safe
      // ordering.
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'discard-me.md', contentType: 'text/markdown', content: Buffer.from('# Discard\n', 'utf-8') },
      ]);
      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'discard-order',
      });

      // Simulate a `deleteByPattern` failure during discard.
      const failingAgent = makeMockAgent('0xMockAgentPeerId', {
        deleteByPatternError: new Error('simulated meta cleanup failure'),
      });
      // Prime with the successful import's quads.
      for (const q of agent.insertedQuads) {
        failingAgent.insertedQuads.push({ ...q });
      }

      // Discard should throw because `deleteByPattern` fails.
      await expect(
        failingAgent.assertion.discard('cg', 'discard-order'),
      ).rejects.toThrow('simulated meta cleanup failure');

      // CRITICAL: the data graph must still be intact. The ordering
      // (`deleteByPattern` first) means `dropGraph` never ran, so V's
      // assertion graph quads are still there. This is the retry-safe
      // guarantee of Bug 12.
      const assertionGraph = contextGraphAssertionUri('cg', failingAgent.peerId, 'discard-order');
      const dataAfterFailedDiscard = failingAgent.insertedQuads.filter(q => q.graph === assertionGraph);
      expect(dataAfterFailedDiscard.length).toBeGreaterThan(0);
      // The dropGraph call was NEVER made (ordering: meta first, drop second).
      expect(failingAgent.droppedGraphs).not.toContain(assertionGraph);
      // Reference `result` so the successful-import capture isn't
      // flagged as unused — its hash is a sanity anchor for the test.
      expect(result.fileHash).toMatch(/^keccak256:/);
    });


    it('Bug 5b: assertion.discard drops BOTH the data graph AND the assertion _meta rows', async () => {
      // Regression guard for Bug 5b: after discard, there must be ZERO
      // rows in the CG root `_meta` keyed by this assertion's UAL, AND
      // zero quads in the assertion data graph. Pre-fix discard only
      // dropped the data graph, leaving `_meta` pointing at a hash for
      // an assertion that no longer exists.
      const ASSERTION_NAME = 'to-be-discarded';
      const metaGraph = contextGraphMetaUri('cg');

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'doomed.md', contentType: 'text/markdown', content: Buffer.from('# Doomed\n\nWill be discarded.\n', 'utf-8') },
      ]);
      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: ASSERTION_NAME,
      });

      // Baseline: the import populated both graphs.
      const dataBefore = agent.insertedQuads.filter(q => q.graph === result.assertionUri);
      const metaBefore = agent.insertedQuads.filter(q =>
        q.graph === metaGraph && q.subject === result.assertionUri,
      );
      expect(dataBefore.length).toBeGreaterThan(0);
      expect(metaBefore.length).toBeGreaterThan(0);

      // Discard.
      await agent.assertion.discard('cg', ASSERTION_NAME);

      // The data graph is dropped (tracked explicitly so the test catches
      // regressions where dropGraph is skipped).
      expect(agent.droppedGraphs).toContain(result.assertionUri);
      const dataAfter = agent.insertedQuads.filter(q => q.graph === result.assertionUri);
      expect(dataAfter).toHaveLength(0);

      // AND the `_meta` rows keyed by this assertion's UAL are gone.
      const metaAfter = agent.insertedQuads.filter(q =>
        q.graph === metaGraph && q.subject === result.assertionUri,
      );
      expect(metaAfter).toHaveLength(0);
    });


    it('Bug 5b: discard does NOT touch `_meta` rows for OTHER assertions', async () => {
      // Scope guard for the cleanup: dropping assertion A must not leak
      // into the `_meta` rows for assertion B. Otherwise a discard could
      // wipe unrelated data.
      const metaGraph = contextGraphMetaUri('cg');

      // Import two assertions with unrelated names.
      const bodyA = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'a.md', contentType: 'text/markdown', content: Buffer.from('# A\n\nFirst.\n', 'utf-8') },
      ]);
      const bodyB = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'b.md', contentType: 'text/markdown', content: Buffer.from('# B\n\nSecond.\n', 'utf-8') },
      ]);
      const a = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyA, boundary: BOUNDARY, assertionName: 'iso-a',
      });
      const b = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyB, boundary: BOUNDARY, assertionName: 'iso-b',
      });

      // Discard only A.
      await agent.assertion.discard('cg', 'iso-a');

      // A's `_meta` rows gone.
      const metaA = agent.insertedQuads.filter(q =>
        q.graph === metaGraph && q.subject === a.assertionUri,
      );
      expect(metaA).toHaveLength(0);

      // B's `_meta` rows intact.
      const metaB = agent.insertedQuads.filter(q =>
        q.graph === metaGraph && q.subject === b.assertionUri,
      );
      expect(metaB.length).toBeGreaterThan(0);
      const bHash = metaB.find(q => q.predicate === `${DKG}sourceFileHash`);
      expect(bHash?.object).toBe(`"${b.fileHash}"`);
    });
});
