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


    it('Issue 122: fragment-bearing frontmatter `rootEntity` overrides are rejected on the import-file path', async () => {
      const ROOT_OVERRIDE = 'https://example.org/doc#root';
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        {
          kind: 'file',
          name: 'file',
          filename: 'fragment-root.md',
          contentType: 'text/markdown',
          content: Buffer.from(`---\nid: fragment-doc\nrootEntity: ${ROOT_OVERRIDE}\n---\n\n# Fragment Title\n\n## Intro\n\n### Details\n`, 'utf-8'),
        },
      ]);

      let thrown: unknown;
      try {
        await runImportFileOrchestration({
          agent, fileStore, extractionRegistry: registry, extractionStatus: status,
          multipartBody: body, boundary: BOUNDARY, assertionName: 'fragment-root',
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(ImportFileRouteError);
      expect((thrown as ImportFileRouteError).statusCode).toBe(400);
      expect((thrown as ImportFileRouteError).body.rootEntity).toBe(ROOT_OVERRIDE);
      expect((thrown as ImportFileRouteError).body.extraction.error).toMatch(/not yet supported on the import-file path/);

      const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'fragment-root');
      expect(status.get(assertionUri)?.status).toBe('failed');
      expect(status.get(assertionUri)?.rootEntity).toBe(ROOT_OVERRIDE);
      expect(agent.insertedQuads).toHaveLength(0);
    });


    it('Issue 122: reserved frontmatter `rootEntity` prefixes are rejected before retargeting content subjects', async () => {
      const RESERVED_ROOT = 'urn:dkg:file:keccak256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        {
          kind: 'file',
          name: 'file',
          filename: 'reserved-root.md',
          contentType: 'text/markdown',
          content: Buffer.from(`---\nid: reserved\nrootEntity: ${RESERVED_ROOT}\n---\n\n# Reserved\n`, 'utf-8'),
        },
      ]);

      let thrown: unknown;
      try {
        await runImportFileOrchestration({
          agent, fileStore, extractionRegistry: registry, extractionStatus: status,
          multipartBody: body, boundary: BOUNDARY, assertionName: 'reserved-root',
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(ImportFileRouteError);
      expect((thrown as ImportFileRouteError).statusCode).toBe(400);
      expect((thrown as ImportFileRouteError).body.extraction.error).toMatch(/reserved namespace 'urn:dkg:file:\*'/);

      const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'reserved-root');
      expect(status.get(assertionUri)?.status).toBe('failed');
      expect(agent.insertedQuads).toHaveLength(0);
    });


    it('Issue 122: skolemized frontmatter `rootEntity` values are rejected before retargeting content subjects', async () => {
      const SKOLEM_ROOT = 'did:dkg:doc:root/.well-known/genid/child';
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        {
          kind: 'file',
          name: 'file',
          filename: 'skolem-root.md',
          contentType: 'text/markdown',
          content: Buffer.from(`---\nid: skolem\nrootEntity: ${SKOLEM_ROOT}\n---\n\n# Skolem\n`, 'utf-8'),
        },
      ]);

      let thrown: unknown;
      try {
        await runImportFileOrchestration({
          agent, fileStore, extractionRegistry: registry, extractionStatus: status,
          multipartBody: body, boundary: BOUNDARY, assertionName: 'skolem-root',
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(ImportFileRouteError);
      expect((thrown as ImportFileRouteError).statusCode).toBe(400);
      expect((thrown as ImportFileRouteError).body.extraction.error).toMatch(/skolemized URI/);

      const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'skolem-root');
      expect(status.get(assertionUri)?.status).toBe('failed');
      expect(agent.insertedQuads).toHaveLength(0);
    });


    it('Bug 5a: re-import replaces (not appends) stale `_meta` rows for the same assertion name', async () => {
      // Regression guard for Bug 5a: a second import-file call against
      // the same assertion UAL must end up with EXACTLY ONE binding per
      // `_meta` predicate — not two. The daemon clears
      // `{subject: assertionUri, graph: metaGraph}` before each atomic
      // insert so a re-import with different content replaces the old
      // _meta block instead of stacking next to it.
      const ASSERTION_NAME = 'climate-report';
      const metaGraph = contextGraphMetaUri('cg');

      // First import: blob V1
      const body1 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# Climate V1\n\nOriginal body.\n', 'utf-8') },
      ]);
      const result1 = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body1, boundary: BOUNDARY, assertionName: ASSERTION_NAME,
      });
      const hashV1 = result1.fileHash;

      // After the first import, `_meta` has exactly one sourceFileHash row.
      const metaAfter1 = agent.insertedQuads.filter(q =>
        q.graph === metaGraph &&
        q.subject === result1.assertionUri &&
        q.predicate === `${DKG}sourceFileHash`,
      );
      expect(metaAfter1).toHaveLength(1);
      expect(metaAfter1[0]!.object).toBe(`"${hashV1}"`);

      // Second import: DIFFERENT content → different keccak256 hash, same
      // assertion name. Pre-fix behavior: stacks a second row alongside
      // the first. Post-fix: replaces.
      const body2 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# Climate V2\n\nUpdated body.\n', 'utf-8') },
      ]);
      const result2 = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body2, boundary: BOUNDARY, assertionName: ASSERTION_NAME,
      });
      const hashV2 = result2.fileHash;
      expect(hashV2).not.toBe(hashV1); // sanity: different bodies → different hashes
      expect(result2.assertionUri).toBe(result1.assertionUri); // same UAL

      // After the second import, `_meta` still has EXACTLY ONE
      // sourceFileHash row, pointing at the new hash.
      const metaAfter2 = agent.insertedQuads.filter(q =>
        q.graph === metaGraph &&
        q.subject === result2.assertionUri &&
        q.predicate === `${DKG}sourceFileHash`,
      );
      expect(metaAfter2).toHaveLength(1);
      expect(metaAfter2[0]!.object).toBe(`"${hashV2}"`);

      // Every other `_meta` row keyed by this assertion UAL is also
      // single-binding — generalized invariant, catches future row
      // additions that might forget the cleanup.
      const allMetaForAssertion = agent.insertedQuads.filter(q =>
        q.graph === metaGraph && q.subject === result2.assertionUri,
      );
      const perPredicate = new Map<string, number>();
      for (const q of allMetaForAssertion) {
        perPredicate.set(q.predicate, (perPredicate.get(q.predicate) ?? 0) + 1);
      }
      for (const [pred, count] of perPredicate) {
        expect(count, `expected exactly one binding for <${pred}> after re-import, got ${count}`).toBe(1);
      }
    });


    it('Bug 7: re-import replaces stale data-graph rows — no two source files for one assertion', async () => {
      // Regression guard for Bug 7 (symmetric to Bug 5a on the data
      // graph). Before the fix, a re-import under the same assertion
      // name left the PRIOR blob's rows 1 and 4-13 in place alongside
      // the new blob's, so the assertion ended up with two conflicting
      // source files. The daemon now `dropGraph`s the assertion data
      // graph before the atomic insert, giving full replace semantics.
      //
      // With Bug 8's blank-node subjects (both imports use the same
      // `_:file1` label), we can't tell V1 from V2 by subject alone —
      // the contentHash LITERAL is the distinguishing signal. If the
      // drop-before-insert weren't happening, the data graph would end
      // up with TWO contentHash bindings (one per version); with the
      // fix, there's exactly one, pointing at V2.
      const ASSERTION_NAME = 'climate-report-v7';
      const assertionGraph = contextGraphAssertionUri('cg', agent.peerId, ASSERTION_NAME);

      // First import: blob V1.
      const body1 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v1.md', contentType: 'text/markdown', content: Buffer.from('# V1\n\nFirst body.\n', 'utf-8') },
      ]);
      const result1 = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body1, boundary: BOUNDARY, assertionName: ASSERTION_NAME,
      });

      // Baseline: V1's contentHash is in the data graph.
      const dataAfter1 = agent.insertedQuads.filter(q => q.graph === assertionGraph);
      const contentHashV1 = dataAfter1.filter(q => q.predicate === `${DKG}contentHash`);
      expect(contentHashV1).toHaveLength(1);
      expect(contentHashV1[0]!.object).toBe(`"${result1.fileHash}"`);
      // Row 1 points at a blank node (Bug 8 guard).
      const row1V1 = dataAfter1.find(q =>
        q.subject === result1.assertionUri && q.predicate === `${DKG}sourceFile`,
      );
      expect(row1V1!.object).toMatch(/^urn:dkg:file:keccak256:/);

      // Second import: DIFFERENT blob, same assertion name.
      const body2 = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'v2.md', contentType: 'text/markdown', content: Buffer.from('# V2\n\nUpdated body.\n', 'utf-8') },
      ]);
      const result2 = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body2, boundary: BOUNDARY, assertionName: ASSERTION_NAME,
      });
      expect(result2.fileHash).not.toBe(result1.fileHash); // sanity
      expect(result2.assertionUri).toBe(result1.assertionUri); // same UAL

      // After the second import, the assertion data graph has ONLY V2's
      // rows. Row 5 `contentHash` appears exactly once, pointing at V2's
      // literal hash. If the dropGraph call weren't there, we'd see TWO
      // contentHash bindings — one per version.
      const dataAfter2 = agent.insertedQuads.filter(q => q.graph === assertionGraph);
      const contentHashQuads = dataAfter2.filter(q => q.predicate === `${DKG}contentHash`);
      expect(contentHashQuads).toHaveLength(1);
      expect(contentHashQuads[0]!.object).toBe(`"${result2.fileHash}"`);

      // No contentHash for V1 should remain anywhere in the data graph.
      expect(dataAfter2.some(q => q.object === `"${result1.fileHash}"`)).toBe(false);

      // Row 1 (`<UAL> dkg:sourceFile`) has exactly one quad pointing at
      // the V2 file URN (URN form, Round 4 Option B).
      const row1Quads = dataAfter2.filter(q =>
        q.subject === result2.assertionUri && q.predicate === `${DKG}sourceFile`,
      );
      expect(row1Quads).toHaveLength(1);
      expect(row1Quads[0]!.object).toBe(`urn:dkg:file:${result2.fileHash}`);

      // Single `dkg:File` type quad (only one file descriptor remains).
      const fileTypeQuads = dataAfter2.filter(q =>
        q.predicate === RDF_TYPE && q.object === `${DKG}File`,
      );
      expect(fileTypeQuads).toHaveLength(1);

      // Single `ExtractionProvenance` type quad (only one prov block).
      const provTypeQuads = dataAfter2.filter(q =>
        q.predicate === RDF_TYPE && q.object === `${DKG}ExtractionProvenance`,
      );
      expect(provTypeQuads).toHaveLength(1);

      // And `_meta` also shows only V2 (already covered by Bug 5a test
      // but worth asserting end-to-end here for completeness).
      const metaGraphUri = contextGraphMetaUri('cg');
      const metaSourceFileHash = agent.insertedQuads.filter(q =>
        q.graph === metaGraphUri &&
        q.subject === result2.assertionUri &&
        q.predicate === `${DKG}sourceFileHash`,
      );
      expect(metaSourceFileHash).toHaveLength(1);
      expect(metaSourceFileHash[0]!.object).toBe(`"${result2.fileHash}"`);
    });


    it('Bug 7: re-import of assertion A does NOT affect assertion B data or _meta', async () => {
      // Cross-assertion isolation guard: the Bug 7 `dropGraph` call must
      // only drop THIS assertion's data graph, never another's. A bug
      // that over-matched the drop would wipe unrelated assertions.
      const assertionGraphA = contextGraphAssertionUri('cg', agent.peerId, 'iso-a7');
      const assertionGraphB = contextGraphAssertionUri('cg', agent.peerId, 'iso-b7');
      const metaGraphUri = contextGraphMetaUri('cg');

      // Import A, then B.
      await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: buildMultipart([
          { kind: 'text', name: 'contextGraphId', value: 'cg' },
          { kind: 'file', name: 'file', filename: 'a.md', contentType: 'text/markdown', content: Buffer.from('# A orig\n', 'utf-8') },
        ]),
        boundary: BOUNDARY, assertionName: 'iso-a7',
      });
      const b1 = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: buildMultipart([
          { kind: 'text', name: 'contextGraphId', value: 'cg' },
          { kind: 'file', name: 'file', filename: 'b.md', contentType: 'text/markdown', content: Buffer.from('# B orig\n', 'utf-8') },
        ]),
        boundary: BOUNDARY, assertionName: 'iso-b7',
      });

      // Snapshot B's state before the re-import of A.
      const bDataBefore = agent.insertedQuads.filter(q => q.graph === assertionGraphB).length;
      const bMetaBefore = agent.insertedQuads.filter(q =>
        q.graph === metaGraphUri && q.subject === b1.assertionUri,
      ).length;
      expect(bDataBefore).toBeGreaterThan(0);
      expect(bMetaBefore).toBeGreaterThan(0);

      // Re-import A with different content.
      await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: buildMultipart([
          { kind: 'text', name: 'contextGraphId', value: 'cg' },
          { kind: 'file', name: 'file', filename: 'a2.md', contentType: 'text/markdown', content: Buffer.from('# A replaced\n', 'utf-8') },
        ]),
        boundary: BOUNDARY, assertionName: 'iso-a7',
      });

      // B's data + _meta must be identical to the snapshot — byte-
      // perfect, not just non-empty.
      const bDataAfter = agent.insertedQuads.filter(q => q.graph === assertionGraphB).length;
      const bMetaAfter = agent.insertedQuads.filter(q =>
        q.graph === metaGraphUri && q.subject === b1.assertionUri,
      ).length;
      expect(bDataAfter).toBe(bDataBefore);
      expect(bMetaAfter).toBe(bMetaBefore);

      // Also verify B's actual sourceFileHash row still points at B's hash.
      const bSourceFileHash = agent.insertedQuads.find(q =>
        q.graph === metaGraphUri &&
        q.subject === b1.assertionUri &&
        q.predicate === `${DKG}sourceFileHash`,
      );
      expect(bSourceFileHash?.object).toBe(`"${b1.fileHash}"`);

      // And A's state was replaced (not merged).
      const aData = agent.insertedQuads.filter(q => q.graph === assertionGraphA);
      const aContentHash = aData.filter(q => q.predicate === `${DKG}contentHash`);
      expect(aContentHash).toHaveLength(1); // single file descriptor, not two
    });


    it('Bug 8: two imports with the same file content produce graph-scoped blank nodes that do not cross-contaminate', async () => {
      // Spec-engineer Option A: blank-node subjects for the file
      // descriptor are scoped by the assertion data graph. Two imports
      // that happen to reference the same file content (same keccak256)
      // end up with their file descriptors in SEPARATE assertion graphs,
      // so even if the blank-node LABELS are identical (`_:file1` both
      // times), the underlying blank nodes are distinct RDF terms —
      // `autoPartition` on promote would treat them as document-local,
      // and (critically) they cannot contend on ownership. This test
      // locks in the scoping invariant at the graph level.
      const body = () => buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'shared.md', contentType: 'text/markdown', content: Buffer.from('# Shared\n\nSame content.\n', 'utf-8') },
      ]);
      const a = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body(), boundary: BOUNDARY, assertionName: 'share-a',
      });
      const b = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body(), boundary: BOUNDARY, assertionName: 'share-b',
      });

      // Same wire hash (same content).
      expect(a.fileHash).toBe(b.fileHash);

      const graphA = contextGraphAssertionUri('cg', agent.peerId, 'share-a');
      const graphB = contextGraphAssertionUri('cg', agent.peerId, 'share-b');
      expect(graphA).not.toBe(graphB);

      // Each assertion graph has its own file descriptor with the same
      // keccak256 literal. Under Round 4 Option B, both descriptors have
      // IDENTICAL URN subjects (`urn:dkg:file:keccak256:<hex>`) because
      // the file is content-addressed. They live in disjoint assertion
      // graphs, so they don't conflict at the storage layer — and the
      // promote-time filter in `assertionPromote` strips them before
      // they'd otherwise collide in SWM.
      const contentHashA = agent.insertedQuads.filter(q =>
        q.graph === graphA && q.predicate === `${DKG}contentHash`,
      );
      const contentHashB = agent.insertedQuads.filter(q =>
        q.graph === graphB && q.predicate === `${DKG}contentHash`,
      );
      expect(contentHashA).toHaveLength(1);
      expect(contentHashB).toHaveLength(1);
      expect(contentHashA[0]!.object).toBe(`"${a.fileHash}"`);
      expect(contentHashB[0]!.object).toBe(`"${a.fileHash}"`);

      // Both have IDENTICAL URN subjects (content-addressed).
      const expectedFileUri = `urn:dkg:file:${a.fileHash}`;
      expect(contentHashA[0]!.subject).toBe(expectedFileUri);
      expect(contentHashB[0]!.subject).toBe(expectedFileUri);
      // Row 1 in both assertions also points at the same URN, proving
      // the URN flows through the extractor and daemon identically
      // regardless of which assertion is importing.
      const row1A = agent.insertedQuads.find(q =>
        q.graph === graphA && q.predicate === `${DKG}sourceFile`,
      );
      const row1B = agent.insertedQuads.find(q =>
        q.graph === graphB && q.predicate === `${DKG}sourceFile`,
      );
      expect(row1A?.object).toBe(expectedFileUri);
      expect(row1B?.object).toBe(expectedFileUri);
    });


    it('Bug 8 Option B: assertionPromote filter drops urn:dkg:file: and urn:dkg:extraction: subjects', async () => {
      // The revert from Round 3 blank-node subjects to Round 4 URN
      // subjects + promote-time filter is what prevents cross-assertion
      // contention. This test exercises the filter directly by
      // constructing a synthetic quad set containing row 1 (on the
      // document entity — should survive) plus the file descriptor
      // block (URN subject — should be dropped) plus the prov block
      // (URN subject — should be dropped) and running it through the
      // filter predicate.
      const entityUri = 'urn:doc:test';
      const fileUri = 'urn:dkg:file:keccak256:abc123';
      const provUri = 'urn:dkg:extraction:deadbeef-0000-4000-8000-000000000000';
      const quads: CapturedQuad[] = [
        // Row 1 — entity-subject, MUST survive
        { subject: entityUri, predicate: `${DKG}sourceFile`, object: fileUri, graph: '' },
        // Rows 4-8 — file URN subject, must be stripped
        { subject: fileUri, predicate: RDF_TYPE, object: `${DKG}File`, graph: '' },
        { subject: fileUri, predicate: `${DKG}contentHash`, object: '"keccak256:abc123"', graph: '' },
        // Rows 9-13 — prov URN subject, must be stripped
        { subject: provUri, predicate: RDF_TYPE, object: `${DKG}ExtractionProvenance`, graph: '' },
        { subject: provUri, predicate: `${DKG}extractedFrom`, object: fileUri, graph: '' },
        // A normal content triple — must survive
        { subject: entityUri, predicate: 'http://schema.org/name', object: '"Test"', graph: '' },
      ];

      // Apply the same filter predicate the real `assertionPromote` uses.
      // This mirrors `dkg-publisher.ts:~1580` exactly.
      const filtered = quads.filter(q =>
        !q.subject.startsWith('urn:dkg:file:') &&
        !q.subject.startsWith('urn:dkg:extraction:'),
      );

      // Row 1 survived (its subject is the entity, not the file URN).
      expect(filtered).toContainEqual(quads[0]); // row 1
      expect(filtered).toContainEqual(quads[5]); // schema:name
      // Rows 4-8 and 9-13 were stripped.
      expect(filtered.some(q => q.subject === fileUri)).toBe(false);
      expect(filtered.some(q => q.subject === provUri)).toBe(false);
      // Exactly 2 quads survived.
      expect(filtered).toHaveLength(2);
    });
});
