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


    it('Bug 8 Option B: the URN file descriptor IS present in WM assertion graph (only filtered on promote)', async () => {
      // Scope guard: the filter lives on the promote path in
      // `assertionPromote`, NOT on the import-file write path. The
      // assertion WM graph SHOULD contain the full file descriptor
      // block (rows 4-8) and prov block (rows 9-13) so local queries
      // against WM can see everything. The filter only strips them
      // when promote copies quads into SWM.
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'wm.md', contentType: 'text/markdown', content: Buffer.from('# WM\n', 'utf-8') },
      ]);
      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'wm-check',
      });

      const dataQuads = getDataGraphQuads(agent, 'cg', 'wm-check');
      // URN subjects present in WM:
      expect(dataQuads.some(q => q.subject.startsWith('urn:dkg:file:'))).toBe(true);
      expect(dataQuads.some(q => q.subject.startsWith('urn:dkg:extraction:'))).toBe(true);
      // And the content hash is a literal that matches the wire value.
      const contentHash = dataQuads.find(q => q.predicate === `${DKG}contentHash`);
      expect(contentHash?.object).toBe(`"${result.fileHash}"`);
    });


    it('Bug 8 Option B: `_meta` is unchanged — row 16 is still a keccak256 literal keyed by the UAL', async () => {
      // Scope guard: the Round 4 revert (Option B) only changes the
      // data-graph subject shape back from blank nodes to URNs. The
      // `_meta` block (rows 14-20) was never affected by the blank-node
      // change; row 16's object is still a `"keccak256:<hex>"` literal
      // keyed by the assertion UAL (a NamedNode). This test locks that
      // in so any future rework can't regress `_meta` semantics.
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'meta-check.md', contentType: 'text/markdown', content: Buffer.from('# Meta\n', 'utf-8') },
      ]);
      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'meta-check',
      });

      const metaGraph = contextGraphMetaUri('cg');
      const row16 = agent.insertedQuads.find(q =>
        q.graph === metaGraph &&
        q.subject === result.assertionUri &&
        q.predicate === `${DKG}sourceFileHash`,
      );
      expect(row16).toBeDefined();
      // Subject is the UAL (NamedNode), not a URN or blank node.
      expect(row16!.subject).toBe(result.assertionUri);
      expect(row16!.subject).not.toMatch(/^urn:dkg:file:/);
      // Object is the keccak256 literal, matching the wire hash.
      expect(row16!.object).toBe(`"${result.fileHash}"`);
      // `_meta` graph has no blank-node subjects AND no `urn:dkg:file:` URN subjects.
      const metaQuads = agent.insertedQuads.filter(q => q.graph === metaGraph);
      expect(metaQuads.some(q => q.subject.startsWith('_:'))).toBe(false);
      expect(metaQuads.some(q => q.subject.startsWith('urn:dkg:file:'))).toBe(false);
    });


    it('Bug 11: atomic insert failure rolls back to the prior import snapshot', async () => {
      // First import succeeds with V1 content.
      const bodyV1 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1\n\nThe original.\n', 'utf-8') },
      ]);
      const resultV1 = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'rollback-test',
      });
      const assertionGraph = contextGraphAssertionUri('cg', agent.peerId, 'rollback-test');

      // Snapshot V1's contentHash for the post-rollback verification.
      const contentHashV1Before = agent.insertedQuads.find(q =>
        q.graph === assertionGraph && q.predicate === `${DKG}contentHash`,
      );
      expect(contentHashV1Before?.object).toBe(`"${resultV1.fileHash}"`);

      // Create a second agent pre-populated with V1's data, and wire it
      // to fail the FIRST insert call (V2's fresh content) but let the
      // SECOND insert call (the rollback snapshot) through. V1's
      // original insertion went through `agent`, not `rollbackAgent`,
      // so `rollbackAgent.insertCallCount` starts at 0.
      let totalInsertCalls = 0;
      const rollbackAgent = makeMockAgent('0xMockAgentPeerId', {
        insertErrorPredicate: (_quads, callNumber) => {
          totalInsertCalls = callNumber;
          // First insert on THIS agent is V2's fresh data — fail it.
          // Second insert is the rollback path (re-inserting the snapshot) — let it through.
          if (callNumber === 1) {
            return new Error('simulated V2 insert failure');
          }
          return null;
        },
      });
      // Prime the rollback agent with V1's data as if the first import
      // had gone through it. We copy V1's inserted quads (data-graph +
      // _meta) directly into the rollback agent's state. This simulates
      // "prior successful import landed, now a fresh import is starting
      // and has a real snapshot to roll back to."
      for (const q of agent.insertedQuads) {
        rollbackAgent.insertedQuads.push({ ...q });
      }

      const bodyV2 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2\n\nReplacement.\n', 'utf-8') },
      ]);
      await expect(runImportFileOrchestration({
        agent: rollbackAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'rollback-test',
      })).rejects.toThrow('simulated V2 insert failure');

      // After the rollback, V1's contentHash should still be in the
      // assertion graph — this is the core Bug 11 guarantee. Without
      // the snapshot+rollback, the `dropGraph` call earlier in the
      // orchestration would have wiped V1, and the failed V2 insert
      // would leave the assertion empty.
      const contentHashAfterRollback = rollbackAgent.insertedQuads.filter(q =>
        q.graph === assertionGraph && q.predicate === `${DKG}contentHash`,
      );
      expect(contentHashAfterRollback).toHaveLength(1);
      expect(contentHashAfterRollback[0]!.object).toBe(`"${resultV1.fileHash}"`);

      // Three insert calls on the rollback agent (Round 5 Bug 15 upgrade):
      //   (1) V2 attempt (failed)
      //   (2) dataSnapshot re-insert (succeeded)
      //   (3) metaSnapshot re-insert (succeeded)
      // Round 4 had 2 calls (V2 + data rollback only); Round 5 added the
      // `_meta` rollback so the old `sourceFileHash` / `rootEntity` rows
      // come back alongside the old data graph.
      expect(totalInsertCalls).toBe(3);
    });


    it('Bug 14: import-file `_meta` cleanup failure leaves the OLD data graph untouched', async () => {
      // Regression guard for the Round 5 Bug 14 reorder. In the Round 4
      // ordering, `dropGraph` ran before `deleteByPattern(_meta)`, so a
      // transient `_meta` cleanup failure would abort the import with
      // the assertion body already gone but `_meta` still pointing at
      // the prior hash — the exact stale-metadata state that Bug 12
      // fixed for `assertionDiscard`. Round 5 reorders so `_meta` runs
      // first: if it fails, the data graph is still intact and retry
      // converges.
      //
      // This test seeds V1 into a fresh agent, then attempts a V2
      // re-import on a failing-deleteByPattern agent and asserts the
      // V1 data graph is unchanged.
      const bodyV1 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1\n\nOld reliable.\n', 'utf-8') },
      ]);
      const resultV1 = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'meta-fail-first',
      });
      const assertionGraph = contextGraphAssertionUri('cg', agent.peerId, 'meta-fail-first');

      // Prime a fresh agent with V1's state and a deleteByPattern that
      // always fails. Attempting to re-import V2 must throw, and V1's
      // data graph must still be present post-throw.
      const failAgent = makeMockAgent('0xMockAgentPeerId', {
        deleteByPatternError: new Error('simulated _meta cleanup outage'),
      });
      for (const q of agent.insertedQuads) {
        failAgent.insertedQuads.push({ ...q });
      }
      // Sanity: V1's data is pre-loaded.
      const dataBefore = failAgent.insertedQuads.filter(q => q.graph === assertionGraph);
      expect(dataBefore.length).toBeGreaterThan(0);

      const bodyV2 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2\n\nWill not land.\n', 'utf-8') },
      ]);
      await expect(runImportFileOrchestration({
        agent: failAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'meta-fail-first',
      })).rejects.toThrow('simulated _meta cleanup outage');

      // Core invariant: V1's data graph is byte-perfect intact because
      // `deleteByPattern` fired (and failed) BEFORE `dropGraph`. Without
      // the reorder, `dropGraph` would have already wiped V1 by the time
      // the meta cleanup threw.
      const dataAfter = failAgent.insertedQuads.filter(q => q.graph === assertionGraph);
      expect(dataAfter).toHaveLength(dataBefore.length);
      const v1ContentHash = dataAfter.find(q => q.predicate === `${DKG}contentHash`);
      expect(v1ContentHash?.object).toBe(`"${resultV1.fileHash}"`);
      // And `dropGraph` was NEVER called — confirming the ordering.
      expect(failAgent.droppedGraphs).not.toContain(assertionGraph);
    });


    it('Bug 15: rollback restores BOTH the data graph AND the `_meta` rows keyed by this assertion', async () => {
      // Regression guard for the Round 5 Bug 15 extension. Round 4's
      // Bug 11 fix only snapshotted the data graph, so a failed re-import
      // left `_meta` empty until a retry rebuilt it. Round 5 snapshots
      // `_meta` too (scoped to `<assertionUri> ?p ?o` within the CG root
      // `_meta` graph) and restores it alongside the data graph on
      // insert failure.
      const bodyV1 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1 content\n\nFirst.\n', 'utf-8') },
      ]);
      const resultV1 = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'meta-rollback',
      });
      const statusBefore = { ...status.get(resultV1.assertionUri)! };
      expect(statusBefore.status).toBe('completed');
      const metaGraphUri = contextGraphMetaUri('cg');

      // Snapshot V1's `_meta` state for post-rollback comparison.
      const metaBefore = agent.insertedQuads.filter(q =>
        q.graph === metaGraphUri && q.subject === resultV1.assertionUri,
      );
      expect(metaBefore.length).toBeGreaterThanOrEqual(6); // rows 14-19
      const sourceFileHashBefore = metaBefore.find(q => q.predicate === `${DKG}sourceFileHash`);
      expect(sourceFileHashBefore?.object).toBe(`"${resultV1.fileHash}"`);

      // Fresh agent seeded with V1 state + insert-failing predicate that
      // fails the first call (V2 fresh data) but lets the next two
      // (data rollback + meta rollback) through.
      const rollbackAgent = makeMockAgent('0xMockAgentPeerId', {
        insertErrorPredicate: (_quads, callNumber) => {
          if (callNumber === 1) {
            return new Error('simulated V2 atomic insert failure');
          }
          return null;
        },
      });
      for (const q of agent.insertedQuads) {
        rollbackAgent.insertedQuads.push({ ...q });
      }

      const bodyV2 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2 content\n\nSecond.\n', 'utf-8') },
      ]);
      await expect(runImportFileOrchestration({
        agent: rollbackAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'meta-rollback',
      })).rejects.toThrow('simulated V2 atomic insert failure');

      // Core Bug 15 invariant: `_meta` rows for this assertion are
      // back, specifically `dkg:sourceFileHash` still points at V1's
      // hash (not missing, not pointing at V2's hash).
      const metaAfter = rollbackAgent.insertedQuads.filter(q =>
        q.graph === metaGraphUri && q.subject === resultV1.assertionUri,
      );
      expect(metaAfter).toHaveLength(metaBefore.length);
      const sourceFileHashAfter = metaAfter.find(q => q.predicate === `${DKG}sourceFileHash`);
      expect(sourceFileHashAfter?.object).toBe(`"${resultV1.fileHash}"`);
      expect(status.get(resultV1.assertionUri)).toEqual(statusBefore);
      // And data-graph rollback still works (Round 4 Bug 11 invariant).
      const assertionGraph = contextGraphAssertionUri('cg', rollbackAgent.peerId, 'meta-rollback');
      const dataContentHash = rollbackAgent.insertedQuads.find(q =>
        q.graph === assertionGraph && q.predicate === `${DKG}contentHash`,
      );
      expect(dataContentHash?.object).toBe(`"${resultV1.fileHash}"`);
    });


    it('failed re-import after daemon restart rebuilds previous extraction status from restored _meta', async () => {
      const bodyV1 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1 content\n\nFirst.\n', 'utf-8') },
      ]);
      const resultV1 = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'restart-status-rollback',
      });
      status.clear();

      const rollbackAgent = makeMockAgent('0xMockAgentPeerId', {
        insertErrorPredicate: (_quads, callNumber) =>
          callNumber === 1 ? new Error('simulated V2 atomic insert failure') : null,
      });
      for (const q of agent.insertedQuads) {
        rollbackAgent.insertedQuads.push({ ...q });
      }

      const bodyV2 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2 content\n\nSecond.\n', 'utf-8') },
      ]);
      await expect(runImportFileOrchestration({
        agent: rollbackAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'restart-status-rollback',
      })).rejects.toThrow('simulated V2 atomic insert failure');

      const record = status.get(resultV1.assertionUri);
      expect(record?.status).toBe('completed');
      expect(record?.fileHash).toBe(resultV1.fileHash);
      expect(record?.detectedContentType).toBe('text/markdown');
      expect(record?.pipelineUsed).toBe('text/markdown');
      expect(record?.tripleCount).toBeGreaterThan(0);
    });


    it('Bug 15: rollback does NOT restore `_meta` rows for OTHER assertions', async () => {
      // Scope guard: the `_meta` rollback must be tightly scoped to
      // `<assertionUri> ?p ?o`. An over-broad rollback that restored
      // every `_meta` row in the graph would clobber unrelated
      // assertions' `_meta` during a failed re-import. This test
      // imports assertion B into the same `_meta` graph, then attempts
      // a failing re-import of assertion A, and asserts B's `_meta` is
      // untouched.
      const metaGraphUri = contextGraphMetaUri('cg');

      // First: import A and B, both successful.
      const bodyA = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'a.md', contentType: 'text/markdown', content: Buffer.from('# A v1\n', 'utf-8') },
      ]);
      const resultA = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyA, boundary: BOUNDARY, assertionName: 'iso-meta-a',
      });
      const bodyB = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'b.md', contentType: 'text/markdown', content: Buffer.from('# B v1\n', 'utf-8') },
      ]);
      const resultB = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyB, boundary: BOUNDARY, assertionName: 'iso-meta-b',
      });

      // Now try to re-import A under a failing-insert agent. The rollback
      // should restore A's `_meta` but leave B's `_meta` untouched —
      // B isn't even mentioned in the CONSTRUCT, so the mock's scoped
      // filter means the rollback array doesn't include B's rows.
      const failAgent = makeMockAgent('0xMockAgentPeerId', {
        insertErrorPredicate: (_quads, callNumber) => {
          if (callNumber === 1) return new Error('simulated A v2 insert failure');
          return null;
        },
      });
      for (const q of agent.insertedQuads) {
        failAgent.insertedQuads.push({ ...q });
      }

      // Snapshot B's `_meta` before the failed A re-import.
      const bMetaBefore = failAgent.insertedQuads.filter(q =>
        q.graph === metaGraphUri && q.subject === resultB.assertionUri,
      );
      expect(bMetaBefore.length).toBeGreaterThanOrEqual(6);

      const bodyAv2 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'a2.md', contentType: 'text/markdown', content: Buffer.from('# A v2\n', 'utf-8') },
      ]);
      await expect(runImportFileOrchestration({
        agent: failAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyAv2, boundary: BOUNDARY, assertionName: 'iso-meta-a',
      })).rejects.toThrow('simulated A v2 insert failure');

      // B's `_meta` is byte-perfect untouched — not because the rollback
      // was cautious, but because the scoped CONSTRUCT never captured
      // B's rows in the first place.
      const bMetaAfter = failAgent.insertedQuads.filter(q =>
        q.graph === metaGraphUri && q.subject === resultB.assertionUri,
      );
      expect(bMetaAfter).toHaveLength(bMetaBefore.length);
      const bSourceFileHash = bMetaAfter.find(q => q.predicate === `${DKG}sourceFileHash`);
      expect(bSourceFileHash?.object).toBe(`"${resultB.fileHash}"`);
      // And A's `_meta` is restored to V1.
      const aMetaAfter = failAgent.insertedQuads.filter(q =>
        q.graph === metaGraphUri && q.subject === resultA.assertionUri,
      );
      const aSourceFileHash = aMetaAfter.find(q => q.predicate === `${DKG}sourceFileHash`);
      expect(aSourceFileHash?.object).toBe(`"${resultA.fileHash}"`);
    });


    it('Bug 15: compound rollback failure records both errors and rethrows the original insert error', async () => {
      // When the atomic insert fails AND the rollback re-insert also
      // fails, the daemon records a compound failure message listing
      // both errors, then rethrows the ORIGINAL insert error (not the
      // rollback error) so the caller's 500 envelope matches what they
      // actually asked for. This test exercises that path: call #1 fails
      // (V2 atomic insert) AND call #2 also fails (data rollback). The
      // orchestration should throw the original "V2 insert failure" and
      // the extraction-status record should contain both messages.
      const bodyV1 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1\n', 'utf-8') },
      ]);
      await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV1, boundary: BOUNDARY, assertionName: 'compound-fail',
      });

      const doubleFailAgent = makeMockAgent('0xMockAgentPeerId', {
        insertErrorPredicate: (_quads, callNumber) => {
          // Fail EVERY insert after the prime — the primary V2 insert
          // AND both rollback re-inserts.
          if (callNumber >= 1) {
            return new Error(callNumber === 1 ? 'simulated V2 insert failure' : `simulated rollback failure #${callNumber}`);
          }
          return null;
        },
      });
      for (const q of agent.insertedQuads) {
        doubleFailAgent.insertedQuads.push({ ...q });
      }

      const bodyV2 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2\n', 'utf-8') },
      ]);
      await expect(runImportFileOrchestration({
        agent: doubleFailAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyV2, boundary: BOUNDARY, assertionName: 'compound-fail',
      })).rejects.toThrow('simulated V2 insert failure'); // Original error, not rollback error

      // The status record should reflect the compound failure — the
      // error message should mention both the primary insert failure
      // and the rollback failures.
      const assertionUri = contextGraphAssertionUri('cg', doubleFailAgent.peerId, 'compound-fail');
      const record = status.get(assertionUri);
      expect(record?.status).toBe('failed');
      // Round 7 Bug 22 restructure renamed the compound-failure prefix
      // from "atomic insert failed" to the more general "write stage
      // failed" since the same rollback path now covers dropGraph
      // failures too.
      expect(record?.error).toContain('write stage failed AND rollback failures');
      expect(record?.error).toContain('simulated V2 insert failure');
      expect(record?.error).toContain('simulated rollback failure');
    });
});
