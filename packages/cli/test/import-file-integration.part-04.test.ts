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


    it('text/markdown import writes rows 1-13 into the data graph with blank-node subjects for the file descriptor + prov block', async () => {
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'note.md', contentType: 'text/markdown', content: Buffer.from('---\nid: note\n---\n\n# Note\n\nBody.\n', 'utf-8') },
      ]);

      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'note',
      });

      expect(result.extraction.status).toBe('completed');
      expect(result.fileHash).toMatch(/^keccak256:[0-9a-f]{64}$/);
      // The route handler pins the extractor's documentIri to the assertion
      // UAL, so rows 1-3 live on the UAL as the document subject.
      const subjectIri = result.assertionUri;

      const written = getDataGraphQuads(agent, 'cg', 'note');
      expect(written.length).toBeGreaterThan(0);

      // Row 1 — object is the content-addressed URN (Round 4 Option B).
      // Must match the subject of rows 4-8 below.
      const row1 = written.find(t => t.subject === subjectIri && t.predicate === `${DKG}sourceFile`);
      expect(row1).toBeDefined();
      expect(row1!.object).toMatch(/^urn:dkg:file:keccak256:[0-9a-f]{64}$/);
      const fileUri = row1!.object;
      expect(fileUri).toBe(`urn:dkg:file:${result.fileHash}`);
      // New graph-level link to the markdown bytes structural extraction
      // actually read. For markdown-native uploads it matches row 1.
      const markdownFormRow = written.find(t => t.subject === subjectIri && t.predicate === DKG_MARKDOWN_FORM);
      expect(markdownFormRow).toBeDefined();
      expect(markdownFormRow!.object).toBe(fileUri);

      // Row 2 — daemon-owned, uses the ORIGINAL upload content type. For a
      // direct markdown upload that's "text/markdown"; the PDF test below
      // verifies the same row 2 carries "application/pdf" in its case.
      expect(written).toContainEqual({ subject: subjectIri, predicate: `${DKG}sourceContentType`, object: '"text/markdown"' });
      // Row 3 — reflexive rootEntity on the document subject in V10.0
      expect(written).toContainEqual({ subject: subjectIri, predicate: `${DKG}rootEntity`, object: subjectIri });

      // Row 4 — file descriptor subject is the SAME URN as row 1's object
      expect(written).toContainEqual({ subject: fileUri, predicate: RDF_TYPE, object: `${DKG}File` });
      // Row 5 — contentHash matches the wire fileHash (keccak256 literal)
      expect(written).toContainEqual({ subject: fileUri, predicate: `${DKG}contentHash`, object: `"${result.fileHash}"` });
      // Round 9 Bug 27: rows 6 (`dkg:fileName`) and 7 (`dkg:contentType`)
      // were REMOVED from the file descriptor block — they carried
      // per-upload metadata on a content-addressed subject and collided
      // when two imports of identical bytes used different names/types.
      // They now live on the assertion UAL in `_meta` (see the `_meta`
      // section of this test further down). The canary assertions below
      // lock in the absence of those two properties on `<fileUri>`.
      expect(written.some(t => t.subject === fileUri && t.predicate === `${DKG}fileName`)).toBe(false);
      expect(written.some(t => t.subject === fileUri && t.predicate === `${DKG}contentType`)).toBe(false);
      // Row 8 — size as xsd:integer
      expect(written.some(t =>
        t.subject === fileUri &&
        t.predicate === `${DKG}size` &&
        t.object.endsWith(`^^<${XSD_INTEGER}>`),
      )).toBe(true);

      // Rows 9-13 — one ExtractionProvenance resource minted per import,
      // subject is a fresh `urn:dkg:extraction:<uuid>` URN.
      const provTypeQuads = written.filter(t =>
        t.predicate === RDF_TYPE && t.object === `${DKG}ExtractionProvenance`,
      );
      expect(provTypeQuads).toHaveLength(1);
      const provUri = provTypeQuads[0]!.subject;
      expect(provUri).toMatch(/^urn:dkg:extraction:[0-9a-f-]{36}$/); // UUID v4
      // Row 10 — still back-references the ORIGINAL upload file URN, while
      // the new `dkg:markdownForm` row above points at the markdown bytes
      // structural extraction consumed.
      expect(written).toContainEqual({ subject: provUri, predicate: `${DKG}extractedFrom`, object: fileUri });
      // Row 11
      expect(written).toContainEqual({ subject: provUri, predicate: `${DKG}extractedBy`, object: `did:dkg:agent:${agent.peerId}` });
      // Row 12 — extractedAt is an xsd:dateTime literal
      expect(written.some(t =>
        t.subject === provUri &&
        t.predicate === `${DKG}extractedAt` &&
        /\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#dateTime>$/.test(t.object),
      )).toBe(true);
      // Row 13
      expect(written).toContainEqual({ subject: provUri, predicate: `${DKG}extractionMethod`, object: '"structural"' });

      // Bug 8 Option B guard: the `urn:dkg:file:` and `urn:dkg:extraction:`
      // URNs ARE present in the assertion WM graph (that's the revert from
      // Round 3's blank-node approach). The Option B filter lives in
      // `assertionPromote` downstream and strips them before SWM — that's
      // verified by the dedicated "filter drops import-bookkeeping URIs"
      // test below, not by this one.
      expect(written.some(q => q.subject.startsWith('urn:dkg:file:'))).toBe(true);
      expect(written.some(q => q.subject.startsWith('urn:dkg:extraction:'))).toBe(true);
    });


    it('text/markdown import writes completed status into the CG root _meta graph and omits mdIntermediateHash', async () => {
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'note.md', contentType: 'text/markdown', content: Buffer.from('# Note\n\nBody.\n', 'utf-8') },
      ]);

      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'note',
      });

      const metaGraph = contextGraphMetaUri('cg');
      const metaForAssertion = agent.insertedQuads.filter(q =>
        q.graph === metaGraph && q.subject === result.assertionUri,
      );
      // Rows 14-20 plus Round 9 Bug 27 `dkg:sourceFileName` (8 total) -
      // no mdIntermediateHash because Phase 1 did not run for a direct markdown upload.
      expect(metaForAssertion).toHaveLength(8);

      const byPredicate = (predLocal: string) =>
        metaForAssertion.find(q => q.predicate === `${DKG}${predLocal}`);

      // Row 14 — reflexive rootEntity on the UAL (matches row 3 in the
      // data graph, since the extractor's resolvedRootEntity falls back to
      // the document subject when no frontmatter override is present).
      expect(byPredicate('rootEntity')?.object).toBe(result.assertionUri);
      // Row 15 — original content type (matches row 2 now that both are
      // sourced from detectedContentType)
      expect(byPredicate('sourceContentType')?.object).toBe('"text/markdown"');
      // Row 16 — load-bearing: sourceFileHash lets a caller recover the blob
      expect(byPredicate('sourceFileHash')?.object).toBe(`"${result.fileHash}"`);
      // Row 17
      expect(byPredicate('extractionMethod')?.object).toBe('"structural"');
      expect(byPredicate('extractionStatus')?.object).toBe('"completed"');
      // Row 19 - structural triple count matches the Phase 2 result
      expect(byPredicate('structuralTripleCount')?.object).toBe(`"${result.extraction.tripleCount}"^^<${XSD_INTEGER}>`);
      // Row 20 - V10.0 has no semantic extraction yet
      expect(byPredicate('semanticTripleCount')?.object).toBe(`"0"^^<${XSD_INTEGER}>`);
      expect(byPredicate('mdIntermediateHash')).toBeUndefined();
      // Round 9 Bug 27 — `dkg:sourceFileName` present on the UAL, carrying
      // the original upload filename literal. This is the new home for
      // per-upload metadata that used to live on `<fileUri>` as row 6.
      expect(byPredicate('sourceFileName')?.object).toBe('"note.md"');
    });


    it('application/pdf import writes completed status and mdIntermediateHash in _meta, with rows 2 and 15 both = application/pdf', async () => {
      const convertedMarkdown = '---\nid: paper\n---\n\n# Paper\n\nBody.\n';
      const stubConverter: ExtractionPipeline = {
        contentTypes: ['application/pdf'],
        async extract(_input: ExtractionInput): Promise<ConverterOutput> {
          return { mdIntermediate: convertedMarkdown };
        },
      };
      registry.register(stubConverter);

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'paper.pdf', contentType: 'application/pdf', content: Buffer.from('fake-pdf', 'utf-8') },
      ]);

      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'paper',
      });

      expect(result.extraction.pipelineUsed).toBe('application/pdf');
      expect(result.extraction.mdIntermediateHash).toMatch(/^keccak256:[0-9a-f]{64}$/);

      const metaGraph = contextGraphMetaUri('cg');
      const metaForAssertion = agent.insertedQuads.filter(q =>
        q.graph === metaGraph && q.subject === result.assertionUri,
      );
      // Rows 14-21 + Round 9 Bug 27 `dkg:sourceFileName` = 9 rows total.
      expect(metaForAssertion).toHaveLength(9);

      const byPredicate = (predLocal: string) =>
        metaForAssertion.find(q => q.predicate === `${DKG}${predLocal}`);

      // Row 15 — original content type is application/pdf in _meta
      expect(byPredicate('sourceContentType')?.object).toBe('"application/pdf"');
      expect(byPredicate('extractionStatus')?.object).toBe('"completed"');
      // mdIntermediateHash now present, matching the wire value
      expect(byPredicate('mdIntermediateHash')?.object).toBe(`"${result.extraction.mdIntermediateHash}"`);
      // Round 9 Bug 27 — sourceFileName present on the UAL for the PDF upload.
      expect(byPredicate('sourceFileName')?.object).toBe('"paper.pdf"');

      // Spec-engineer's Bug 1 ruling: row 2 (data graph) and row 15
      // (_meta) must both describe the ORIGINAL upload blob pointed at by
      // row 1. For a PDF upload that's "application/pdf" in BOTH graphs
      // (previously row 2 incorrectly carried "text/markdown" because the
      // extractor was hardcoding its input type).
      const dataQuads = getDataGraphQuads(agent, 'cg', 'paper');
      const dataRow2 = dataQuads.find(t => t.predicate === `${DKG}sourceContentType`);
      expect(dataRow2?.object).toBe('"application/pdf"');

      // Round 9 Bug 27 canary: the content-addressed `<urn:dkg:file:...>`
      // subject no longer carries `dkg:contentType` (that was row 7 in the
      // old file descriptor block). `_meta` row 15 on the UAL is the new
      // home for per-upload content type — the assertion above proves
      // that side of the move. This negative assertion proves the
      // collision-prone side was removed.
      const row1 = dataQuads.find(q =>
        q.subject === result.assertionUri && q.predicate === `${DKG}sourceFile`,
      );
      expect(row1).toBeDefined();
      expect(row1!.object).toMatch(/^urn:dkg:file:keccak256:[0-9a-f]{64}$/);
      const fileUri = row1!.object;
      expect(fileUri).toBe(`urn:dkg:file:${result.fileHash}`);
      const markdownFormRow = dataQuads.find(q =>
        q.subject === result.assertionUri && q.predicate === DKG_MARKDOWN_FORM,
      );
      expect(markdownFormRow).toBeDefined();
      expect(markdownFormRow!.object).toBe(`urn:dkg:file:${result.extraction.mdIntermediateHash}`);
      const markdownFormHash = markdownFormRow!.object.replace(/^urn:dkg:file:/, '');
      const markdownFormBytes = await fileStore.get(markdownFormHash);
      expect(markdownFormBytes?.toString('utf-8')).toBe(convertedMarkdown);
      const row10 = dataQuads.find(q =>
        q.subject.startsWith('urn:dkg:extraction:') && q.predicate === `${DKG}extractedFrom`,
      );
      expect(row10?.object).toBe(fileUri);
      expect(dataQuads.some(q => q.subject === fileUri && q.predicate === `${DKG}contentType`)).toBe(false);
      expect(dataQuads.some(q => q.subject === fileUri && q.predicate === `${DKG}fileName`)).toBe(false);
    });


    it('sub-graph routing: data triples follow the sub-graph, _meta always lands in CG root _meta', async () => {
      agent = makeMockAgent('0xMockAgentPeerId', { registeredSubGraphs: ['decisions'] });

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'text', name: 'subGraphName', value: 'decisions' },
        { kind: 'file', name: 'file', filename: 'd.md', contentType: 'text/markdown', content: Buffer.from('# Decision\n\nBody.\n', 'utf-8') },
      ]);

      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'd1',
      });

      // Data-graph quads land in the SUB-GRAPH assertion graph URI (which
      // embeds `decisions`), not the CG root assertion URI. Under the
      // atomic multi-graph insert we verify this by filtering the mock's
      // captured inserts on the sub-graph's assertion-graph URI.
      const subGraphAssertionGraph = contextGraphAssertionUri('cg', agent.peerId, 'd1', 'decisions');
      const dataQuads = agent.insertedQuads.filter(q => q.graph === subGraphAssertionGraph);
      expect(dataQuads.length).toBeGreaterThan(0);

      // _meta quads used the CG ROOT meta URI, NOT the sub-graph meta URI.
      const rootMetaGraph = contextGraphMetaUri('cg');
      const subGraphMetaGraph = contextGraphMetaUri('cg', 'decisions');
      expect(rootMetaGraph).not.toBe(subGraphMetaGraph);
      const metaQuadsForAssertion = agent.insertedQuads.filter(q =>
        q.subject === result.assertionUri &&
        (q.graph === rootMetaGraph || q.graph === subGraphMetaGraph),
      );
      expect(metaQuadsForAssertion.length).toBeGreaterThan(0);
      for (const quad of metaQuadsForAssertion) {
        expect(quad.graph).toBe(rootMetaGraph);
        expect(quad.graph).not.toBe(subGraphMetaGraph);
      }
    });


    it('daemon-restart recovery: clearing extractionStatus leaves the file <-> assertion linkage in the graph', async () => {
      // Simulates a daemon restart: the in-memory extractionStatus map is
      // empty on boot, but §10.2 sourceFileHash in CG root _meta is the
      // canonical pointer from assertion UAL back to the source blob.
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'persistent.md', contentType: 'text/markdown', content: Buffer.from('# Persistent\n\nBody.\n', 'utf-8') },
      ]);

      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'persistent',
      });

      // Emulate a restart by dropping the in-memory status map.
      status.clear();
      expect(status.size).toBe(0);

      // The §10.2 linkage triples are still in the mock store — a real
      // daemon would SPARQL the CG root `_meta` graph; here we reach into
      // the captured quads directly.
      const metaGraph = contextGraphMetaUri('cg');
      const sourceFileHashQuad = agent.insertedQuads.find(q =>
        q.graph === metaGraph &&
        q.subject === result.assertionUri &&
        q.predicate === `${DKG}sourceFileHash`,
      );
      expect(sourceFileHashQuad).toBeDefined();

      // Recover the keccak256 hash by unquoting the literal, and confirm
      // the underlying blob is still resolvable via the FileStore.
      const recoveredHash = sourceFileHashQuad!.object.replace(/^"|"$/g, '');
      expect(recoveredHash).toBe(result.fileHash);
      const bytes = await fileStore.get(recoveredHash);
      expect(bytes).not.toBeNull();
      expect(bytes!.toString('utf-8')).toBe('# Persistent\n\nBody.\n');
    });


    it('FileStore.get accepts both sha256 and keccak256 prefixes for the same blob', async () => {
      // Verifies the dual-hash contract on FileStore itself: both prefixes
      // round-trip to the same bytes, so external callers can look up a
      // file by either identifier.
      const entry = await fileStore.put(Buffer.from('hello world', 'utf-8'), 'text/plain');
      expect(entry.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(entry.keccak256).toMatch(/^keccak256:[0-9a-f]{64}$/);

      const bySha = await fileStore.get(entry.hash);
      const byKeccak = await fileStore.get(entry.keccak256);
      expect(bySha).not.toBeNull();
      expect(byKeccak).not.toBeNull();
      expect(bySha!.equals(byKeccak!)).toBe(true);
      expect(bySha!.toString('utf-8')).toBe('hello world');
    });


    it('atomic multi-graph insert: a failing store.insert leaves BOTH graphs empty', async () => {
      // Regression guard for spec-engineer Option (a) atomic insert. Under
      // the old two-call flow (assertion.write + separate _meta insert),
      // a failure in the second call would leave the first graph populated
      // and the second empty. With the single atomic insert, ANY failure
      // means NO quads land in EITHER graph, so a retry with identical
      // content is idempotent without any special reconciliation.
      agent = makeMockAgent('0xMockAgentPeerId', {
        insertError: new Error('simulated triple-store outage during atomic insert'),
      });

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'doc.md', contentType: 'text/markdown', content: Buffer.from('# Title\n\nBody.\n', 'utf-8') },
      ]);

      await expect(runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'atomic-fail',
      })).rejects.toThrow('simulated triple-store outage');

      // Critical: NOTHING landed in either graph. agent.insertedQuads only
      // accumulates on successful calls, so a failing insert leaves the
      // array empty — which is exactly the guarantee the atomicity fix
      // gives us. A retry with identical content sees a clean slate.
      expect(agent.insertedQuads).toHaveLength(0);
      // The assertion graph container was still created (idempotent on retry).
      expect(agent.createdAssertions).toHaveLength(1);
      // Status record reflects the failure — the orchestration still calls
      // recordFailed before rethrowing, so /extraction-status doesn't stay
      // stuck at in_progress on an unexpected insert failure.
      const record = status.get(contextGraphAssertionUri('cg', agent.peerId, 'atomic-fail'))!;
      expect(record).toBeDefined();
      expect(record.status).toBe('failed');
      expect(record.error).toContain('simulated triple-store outage');
    });


    it('atomic multi-graph insert: a successful import commits both graphs in ONE store.insert call', async () => {
      // Complementary positive check. The daemon MUST make exactly one
      // `store.insert` call that contains quads for BOTH the assertion
      // graph AND the CG root `_meta` graph — not two separate calls.
      // Splitting would break the atomicity guarantee the test above
      // relies on.
      const insertCalls: number[] = [];
      const countingAgent = makeMockAgent();
      const origInsert = countingAgent.store.insert.bind(countingAgent.store);
      countingAgent.store.insert = async (quads) => {
        insertCalls.push(quads.length);
        return origInsert(quads);
      };

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'atom.md', contentType: 'text/markdown', content: Buffer.from('# Atom\n\nBody.\n', 'utf-8') },
      ]);

      const result = await runImportFileOrchestration({
        agent: countingAgent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'atomic',
      });

      // Exactly one insert call, covering both graphs.
      expect(insertCalls).toHaveLength(1);
      expect(insertCalls[0]).toBeGreaterThan(0);

      // That single call contains quads for BOTH graphs.
      const assertionGraph = contextGraphAssertionUri('cg', countingAgent.peerId, 'atomic');
      const metaGraph = contextGraphMetaUri('cg');
      const dataQuads = countingAgent.insertedQuads.filter(q => q.graph === assertionGraph);
      const metaQuads = countingAgent.insertedQuads.filter(q => q.graph === metaGraph);
      expect(dataQuads.length).toBeGreaterThan(0);
      expect(metaQuads.length).toBeGreaterThanOrEqual(6); // rows 14-19 at minimum
      expect(dataQuads.length + metaQuads.length).toBe(countingAgent.insertedQuads.length);
      expect(result.extraction.status).toBe('completed');
    });


    it('Issue 122: divergent frontmatter `rootEntity` overrides are rejected on the import-file path', async () => {
      const ROOT_OVERRIDE = 'urn:note:climate-report';
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        {
          kind: 'file',
          name: 'file',
          filename: 'root.md',
          contentType: 'text/markdown',
          content: Buffer.from(`---\nid: climate\nrootEntity: ${ROOT_OVERRIDE}\n---\n\n# Climate\n`, 'utf-8'),
        },
      ]);

      let thrown: unknown;
      try {
        await runImportFileOrchestration({
          agent, fileStore, extractionRegistry: registry, extractionStatus: status,
          multipartBody: body, boundary: BOUNDARY, assertionName: 'climate',
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(ImportFileRouteError);
      expect((thrown as ImportFileRouteError).statusCode).toBe(400);
      expect((thrown as ImportFileRouteError).body.rootEntity).toBe(ROOT_OVERRIDE);
      expect((thrown as ImportFileRouteError).body.extraction.error).toMatch(/not yet supported on the import-file path/);

      const assertionUri = contextGraphAssertionUri('cg', agent.peerId, 'climate');
      expect(status.get(assertionUri)?.status).toBe('failed');
      expect(status.get(assertionUri)?.rootEntity).toBe(ROOT_OVERRIDE);
      expect(agent.insertedQuads).toHaveLength(0);
    });
});
