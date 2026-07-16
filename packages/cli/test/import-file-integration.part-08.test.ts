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


    it('Round 10 Bug 30: extractFromMarkdown rejects blank-node rootEntityIri (`_:foo`)', () => {
      // Round 10 Bug 30 — earlier rounds advertised `_:` as an
      // accepted prefix in the `rootEntityIri` validation error
      // message, but `isSafeIri()` always rejected blank nodes, so
      // the advertisement misled callers. Per spec §19.10.2:628-629
      // (`dkg:rootEntity is an IRI`) + `03_PROTOCOL_CORE.md §1`
      // non-blank-node Entity rule + RDF 1.1 §3.4 (blank nodes are
      // not IRIs), blank nodes cannot legitimately be root entities
      // or source file identifiers. Drop `_:` from the regex AND the
      // advertised contract — scheme-based only.
      expect(() => extractFromMarkdown({
        markdown: '# Doc\n',
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
        rootEntityIri: '_:foo',
      })).toThrow(/Invalid 'rootEntityIri'/);
    });


    it('Round 10 Bug 30: extractFromMarkdown rejects blank-node sourceFileIri (`_:bar`)', () => {
      // Symmetric to the rootEntityIri case above.
      expect(() => extractFromMarkdown({
        markdown: '# Doc\n',
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
        sourceFileIri: '_:bar',
      })).toThrow(/Invalid 'sourceFileIri'/);
    });


    it('Round 10 Bug 30: extractFromMarkdown rejects blank-node frontmatter `rootEntity` (`_:fm`)', () => {
      // Frontmatter path — previously advertised `_:` alongside
      // `http:/https:/did:/urn:` in its error message and the regex.
      // Option A cleanup drops it from both. A frontmatter value of
      // `_:fm` no longer matches the scheme-based prefix, so it
      // falls through to the slugification branch — which produces
      // a non-throwing, deterministic URN. That behaviour is
      // acceptable per spec-engineer's ruling (non-IRI frontmatter
      // strings slugify; only IRI-shaped strings are validated).
      // What MUST NOT happen is the `_:fm` value being accepted
      // verbatim as an IRI-shaped root entity. Prove that by
      // checking the resolvedRootEntity is the slugified form, not
      // the blank-node literal.
      const result = extractFromMarkdown({
        markdown: '---\nrootEntity: "_:fm"\n---\n\n# Doc\n',
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
      });
      expect(result.resolvedRootEntity).not.toBe('_:fm');
      expect(result.resolvedRootEntity).toMatch(/^urn:dkg:md:/);
    });


    it('Round 10 Bug 30: `Invalid rootEntityIri` error message does NOT advertise `_:` as accepted', () => {
      // Lock in the contract cleanup in the error text itself — a
      // future contributor adding `_:` back to the regex would
      // break this test, and reading the error message from a
      // failed validation should never suggest `_:foo` works.
      try {
        extractFromMarkdown({
          markdown: '# Doc\n',
          agentDid: 'did:dkg:agent:0x1',
          documentIri: 'urn:dkg:doc:abc',
          rootEntityIri: 'not-an-iri',
        });
        expect.fail('expected extractFromMarkdown to throw');
      } catch (err: any) {
        expect(err.message).toContain("Invalid 'rootEntityIri'");
        expect(err.message).toContain('scheme-based IRI');
        expect(err.message).toContain('Blank nodes (_:foo) are not accepted');
        // Negative assertion: the old advertisement string must not
        // appear. The old message said "starting with http:/https:/
        // did:/urn:/_:" — the `/_:` suffix is what we deleted.
        expect(err.message).not.toMatch(/http:\/https:\/did:\/urn:\/_:/);
      }
    });


    it('Round 11 Bug 33: frontmatter `rootEntity` with a `tag:` URI is preserved as-is (not silently slugified)', () => {
      // Codex's exact cited scenario: `tag:origintrail.org,2026:paper`
      // used to fall into the slugify branch because the previous
      // narrow regex allowlist was `^(https?:|did:|urn:)` and `tag:`
      // didn't match. Round 11 broadened the detection to the RFC
      // 3986 generic scheme pattern `^[a-zA-Z][a-zA-Z0-9+.-]*:`,
      // which matches any absolute IRI scheme. The value is now
      // preserved verbatim as the resolved root entity.
      const tagIri = 'tag:origintrail.org,2026:paper';
      const result = extractFromMarkdown({
        markdown: `---\nrootEntity: ${tagIri}\n---\n\n# Doc\n`,
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
      });
      expect(result.resolvedRootEntity).toBe(tagIri);
      // And crucially, NOT the slugified form that the pre-fix
      // code would have produced:
      expect(result.resolvedRootEntity).not.toMatch(/^urn:dkg:md:tag/);
    });


    it('Round 11 Bug 33: programmatic `rootEntityIri` also accepts `tag:` and other non-whitelist schemes (contract consistency)', () => {
      // The programmatic path already used `isSafeIri`, which accepts
      // any well-formed scheme-based IRI. This test locks that in so
      // the frontmatter / programmatic contract consistency that
      // Round 11 established cannot regress.
      const tagIri = 'tag:example.org,2026:doc';
      const result = extractFromMarkdown({
        markdown: '# Doc\n',
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
        rootEntityIri: tagIri,
      });
      expect(result.resolvedRootEntity).toBe(tagIri);
    });


    it('Round 11 Bug 33: programmatic `sourceFileIri` also accepts non-whitelist schemes', () => {
      // Parallel guard for `sourceFileIri`. A `doi:` value is a
      // valid absolute IRI and must flow through unchanged.
      const doiIri = 'doi:10.1000/xyz.2026.paper';
      const result = extractFromMarkdown({
        markdown: '# Doc\n',
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
        sourceFileIri: doiIri,
      });
      // sourceFileIri appears as the object of row 1
      // (`<entityUri> dkg:sourceFile <sourceFileIri>`) in the
      // `sourceFileLinkage` field (Round 13 Bug 39 rename).
      const row1 = result.sourceFileLinkage.find(t =>
        t.predicate === 'http://dkg.io/ontology/sourceFile',
      );
      expect(row1).toBeDefined();
      expect(row1!.object).toBe(doiIri);
    });


    it('Round 11 Bug 33 preempt: frontmatter `id` with a blank-node prefix (`_:foo`) is NOT accepted as document subject IRI (resolveSubjectIri)', () => {
      // Round 10 Bug 30 preempt — previously `resolveSubjectIri`
      // accepted `_:foo` via the same narrow regex pattern as the
      // pre-Round-30 contract. Per spec §03 §1, document subjects
      // become Entities and must be non-blank-node. The Round 11
      // unification via RFC 3986 scheme detection excludes `_:`
      // (underscore not in `[a-zA-Z]` scheme production), so
      // `_:foo` now falls through to slugification instead of
      // being accepted as the document subject IRI.
      const result = extractFromMarkdown({
        markdown: `---\nid: "_:foo"\n---\n\n# Doc\n`,
        agentDid: 'did:dkg:agent:0x1',
      });
      // Subject is NOT the blank-node literal — it was slugified.
      expect(result.subjectIri).not.toBe('_:foo');
      // Subject is a deterministic urn:dkg:md:* slug.
      expect(result.subjectIri).toMatch(/^urn:dkg:md:/);
    });


    it('Round 11 Bug 33 preempt: frontmatter `id` with a `tag:` URI is preserved as-is (resolveSubjectIri broadens too)', () => {
      // The same unification that fixed Bug 33 for `rootEntity` also
      // affects `resolveSubjectIri` — a valid `tag:` URI in the
      // frontmatter `id` field is now preserved as the document
      // subject IRI instead of being silently slugified. This is a
      // side-effect of the preempt fix, and it improves frontmatter-
      // id-as-IRI semantics for the same reason Bug 33 improves
      // rootEntity-as-IRI semantics.
      const tagIri = 'tag:example.org,2026:document';
      const result = extractFromMarkdown({
        markdown: `---\nid: ${tagIri}\n---\n\n# Doc\n`,
        agentDid: 'did:dkg:agent:0x1',
      });
      expect(result.subjectIri).toBe(tagIri);
    });


    it('Round 11 Bug 33 preempt: frontmatter `id` with a malformed IRI attempt (scheme-prefixed with space) falls through to slugify', () => {
      // `resolveSubjectIri` uses a simpler accept-or-slugify fallback
      // (no throw path like the `rootEntity` branch), so a malformed
      // scheme-prefixed value like `http://x y` slugifies rather
      // than throws. Verify the slugified form is what the caller
      // gets, and crucially NOT the malformed value verbatim.
      const result = extractFromMarkdown({
        markdown: `---\nid: "http://x y"\n---\n\n# Doc\n`,
        agentDid: 'did:dkg:agent:0x1',
      });
      expect(result.subjectIri).not.toBe('http://x y');
      expect(result.subjectIri).toMatch(/^urn:dkg:md:/);
    });


    it('Round 11 Bug 33: backward-compat canary — http://, urn:, did: all still accepted via frontmatter rootEntity', () => {
      // The broadening must NOT have broken the existing schemes.
      // Spot-check each one: http(s), urn, did still produce the
      // expected root entity.
      const cases: Array<[string, string]> = [
        ['http://example.com/entity', 'http://example.com/entity'],
        ['https://example.com/entity', 'https://example.com/entity'],
        ['urn:note:foo', 'urn:note:foo'],
        ['did:dkg:agent:0xabc', 'did:dkg:agent:0xabc'],
      ];
      for (const [input, expected] of cases) {
        const result = extractFromMarkdown({
          markdown: `---\nrootEntity: ${input}\n---\n\n# Doc\n`,
          agentDid: 'did:dkg:agent:0x1',
          documentIri: 'urn:dkg:doc:abc',
        });
        expect(result.resolvedRootEntity).toBe(expected);
      }
    });


    it('Round 11 Bug 33: Bug 13 malformed-IRI semantics preserved (scheme-prefixed + invalid chars still throws)', () => {
      // Critical regression guard: Bug 13 Round 4 established that a
      // frontmatter `rootEntity` value that LOOKS like an IRI (has a
      // scheme prefix) but contains invalid characters MUST throw,
      // not silently slugify. The Round 11 unification must preserve
      // this behavior for both the old schemes (urn, http) AND the
      // newly-accepted schemes (tag, doi). Otherwise a user writing
      // `tag:example.org,2026:x y` (embedded space) would get a
      // cryptic RDF-layer failure later.
      expect(() => extractFromMarkdown({
        markdown: `---\nrootEntity: "urn:x y"\n---\n\n# Doc\n`,
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
      })).toThrow(/Invalid frontmatter 'rootEntity' IRI/);

      expect(() => extractFromMarkdown({
        markdown: `---\nrootEntity: "tag:example.org,2026:x y"\n---\n\n# Doc\n`,
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:abc',
      })).toThrow(/Invalid frontmatter 'rootEntity' IRI/);
    });


    it('Round 13 Bug 39: `extractFromMarkdown` returns a `sourceFileLinkage` field (renamed from `provenance`) with rows 1 and 3 when sourceFileIri is supplied', () => {
      // Round 13 Bug 39 — the field was renamed from `provenance` to
      // `sourceFileLinkage` to remove the semantic clash with its
      // original extraction-run-metadata meaning. This test pins the
      // new field name and asserts the field contains exactly rows 1
      // and 3 (rows 9-13 of the old ExtractionProvenance block moved
      // to the daemon in Round 9 Bug 27, so they are NOT in this
      // field).
      const fileUri = 'urn:dkg:file:keccak256:bug39test';
      const result = extractFromMarkdown({
        markdown: '# Doc\n',
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:bug39',
        sourceFileIri: fileUri,
      });
      // New field name present and populated.
      expect(result.sourceFileLinkage).toHaveLength(2);
      // Row 1: <doc> dkg:sourceFile <fileUri>
      expect(result.sourceFileLinkage).toContainEqual({
        subject: 'urn:dkg:doc:bug39',
        predicate: 'http://dkg.io/ontology/sourceFile',
        object: fileUri,
      });
      // Row 3: <doc> dkg:rootEntity <doc> (reflexive default)
      expect(result.sourceFileLinkage).toContainEqual({
        subject: 'urn:dkg:doc:bug39',
        predicate: 'http://dkg.io/ontology/rootEntity',
        object: 'urn:dkg:doc:bug39',
      });
      // Canary: the old field name is GONE from the output shape.
      // This locks in the rename and prevents a future contributor
      // from accidentally re-adding `provenance` as an alias.
      expect((result as unknown as { provenance?: unknown }).provenance).toBeUndefined();
    });


    it('Round 13 Bug 39: `extractFromMarkdown` returns empty `sourceFileLinkage` when sourceFileIri is omitted (optional semantics preserved)', () => {
      // Symmetric negative: the rename preserved the "empty when not
      // supplied" contract. Pre-rename this was `provenance: []`,
      // post-rename it's `sourceFileLinkage: []`.
      const result = extractFromMarkdown({
        markdown: '# Doc\n\nContent without a source file.\n',
        agentDid: 'did:dkg:agent:0x1',
        documentIri: 'urn:dkg:doc:nolinkage',
      });
      expect(result.sourceFileLinkage).toEqual([]);
    });


    it('Round 8 Bug 23: converter path populates mdIntermediateHash (keccak256) as the SINGLE canonical hash — no mdIntermediateSha256Hash parallel', async () => {
      // Round 7 Bug 21 added a dual-field `mdIntermediateSha256Hash`
      // alongside `mdIntermediateHash`; Round 8 removed it for the
      // same reasons as `sha256Hash` (V10 clean-break release, no
      // installed base to protect). This canary locks in the
      // single-field contract for the converter path and preserves
      // coverage of the Phase 1 write site (which the old dual-field
      // test exercised via a mock converter).
      //
      // Also asserts the pure-markdown path leaves `mdIntermediateHash`
      // undefined so we don't lose the Phase-1-skipped guarantee.
      const mockConverter: ExtractionPipeline = {
        contentTypes: ['application/x-mock'],
        async extract(_input: ExtractionInput): Promise<ConverterOutput> {
          return { mdIntermediate: '# Converted\n\nFrom mock.\n' };
        },
      };
      const mockRegistry = new ExtractionPipelineRegistry();
      mockRegistry.register(mockConverter);

      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'src.mock', contentType: 'application/x-mock', content: Buffer.from('binary-blob', 'utf-8') },
      ]);
      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: mockRegistry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'bug23-converter',
      });

      expect(result.extraction.mdIntermediateHash).toMatch(/^keccak256:[0-9a-f]{64}$/);
      expect('mdIntermediateSha256Hash' in result.extraction).toBe(false);
      const bytes = await fileStore.get(result.extraction.mdIntermediateHash!);
      expect(bytes).not.toBeNull();

      // Record lifecycle mirrors the single-hash contract.
      const record = status.get(result.assertionUri);
      expect(record?.mdIntermediateHash).toBe(result.extraction.mdIntermediateHash);
      expect(record && 'mdIntermediateSha256Hash' in record).toBe(false);

      // Pure-markdown path: `mdIntermediateHash` stays undefined
      // (Phase 1 skipped, no MD intermediate stored separately).
      const pureBody = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'pure.md', contentType: 'text/markdown', content: Buffer.from('# Pure\n', 'utf-8') },
      ]);
      const pureResult = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: pureBody, boundary: BOUNDARY, assertionName: 'bug23-nomd',
      });
      expect(pureResult.extraction.mdIntermediateHash).toBeUndefined();
    });


    it('Round 9 Bug 27: two imports of the same bytes under DIFFERENT filenames both succeed with their own `dkg:sourceFileName` on their own UAL', async () => {
      // Round 9 Bug 27 — per-upload metadata (`dkg:fileName`,
      // `dkg:contentType`) used to live on the content-addressed
      // `<urn:dkg:file:keccak256:...>` subject. Two imports of
      // identical bytes under different filenames would then write
      // contradictory facts to the same subject. Bug 27 moves the
      // per-upload metadata onto the assertion UAL in `_meta` where
      // each assertion gets its own row. This test exercises the
      // canonical collision scenario: same bytes, different filenames,
      // different assertion names, single context graph.
      const sameBytes = Buffer.from('# Shared content\n\nIdentical bytes, different uploads.\n', 'utf-8');

      const bodyA = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'alpha.md', contentType: 'text/markdown', content: sameBytes },
      ]);
      const resultA = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyA, boundary: BOUNDARY, assertionName: 'bug27-alpha',
      });

      const bodyB = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: 'beta.md', contentType: 'text/markdown', content: sameBytes },
      ]);
      const resultB = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: bodyB, boundary: BOUNDARY, assertionName: 'bug27-beta',
      });

      // Same bytes → same keccak256 → same `<fileUri>` across both.
      expect(resultA.fileHash).toBe(resultB.fileHash);
      const fileUri = `urn:dkg:file:${resultA.fileHash}`;

      // The shared `<fileUri>` subject carries NO per-upload metadata
      // in the data graph — the Bug 27 canary.
      expect(agent.insertedQuads.some(q => q.subject === fileUri && q.predicate === `${DKG}fileName`)).toBe(false);
      expect(agent.insertedQuads.some(q => q.subject === fileUri && q.predicate === `${DKG}contentType`)).toBe(false);

      // Each assertion's `_meta` block carries its OWN sourceFileName
      // keyed by its own UAL, so the two filenames coexist without
      // collision.
      const metaGraphUri = contextGraphMetaUri('cg');
      const metaA = agent.insertedQuads.filter(q =>
        q.graph === metaGraphUri && q.subject === resultA.assertionUri && q.predicate === `${DKG}sourceFileName`,
      );
      const metaB = agent.insertedQuads.filter(q =>
        q.graph === metaGraphUri && q.subject === resultB.assertionUri && q.predicate === `${DKG}sourceFileName`,
      );
      expect(metaA).toHaveLength(1);
      expect(metaA[0]!.object).toBe('"alpha.md"');
      expect(metaB).toHaveLength(1);
      expect(metaB[0]!.object).toBe('"beta.md"');

      // Symmetric negative for the old row-7 collision — `dkg:contentType`
      // on the shared `<fileUri>` must also be absent. Existing row 15
      // (`dkg:sourceContentType` on the UAL) covers per-assertion
      // content type without sharing a subject across assertions.
      const ctA = agent.insertedQuads.filter(q =>
        q.graph === metaGraphUri && q.subject === resultA.assertionUri && q.predicate === `${DKG}sourceContentType`,
      );
      const ctB = agent.insertedQuads.filter(q =>
        q.graph === metaGraphUri && q.subject === resultB.assertionUri && q.predicate === `${DKG}sourceContentType`,
      );
      expect(ctA).toHaveLength(1);
      expect(ctB).toHaveLength(1);
    });


    it('Round 9 Bug 27: no-filename upload skips `dkg:sourceFileName` entirely (matches optional metadata pattern)', async () => {
      // Symmetric negative guard — when the multipart part carries no
      // filename (or a whitespace-only filename), the daemon skips
      // the `_meta` row entirely, same way `mdIntermediateHash`
      // is absent for markdown-direct imports.
      const body = buildMultipart([
        { kind: 'text', name: 'contextGraphId', value: 'cg' },
        { kind: 'file', name: 'file', filename: '', contentType: 'text/markdown', content: Buffer.from('# Anon\n', 'utf-8') },
      ]);
      const result = await runImportFileOrchestration({
        agent, fileStore, extractionRegistry: registry, extractionStatus: status,
        multipartBody: body, boundary: BOUNDARY, assertionName: 'bug27-noname',
      });
      const metaGraphUri = contextGraphMetaUri('cg');
      const nameRows = agent.insertedQuads.filter(q =>
        q.graph === metaGraphUri && q.subject === result.assertionUri && q.predicate === `${DKG}sourceFileName`,
      );
      expect(nameRows).toHaveLength(0);
    });
});
