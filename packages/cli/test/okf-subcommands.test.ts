import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { importBundle, parseDocument, quadsToNQuads, PROV_WAS_DERIVED_FROM } from '@origintrail-official/dkg-okf';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callPaths,
  ensureOkfCliBuilt,
  knowledgeAssetCreateBodies,
  knowledgeAssetShareBodies,
  knowledgeAssetWriteBodies,
  makeBundle,
  makeOkfCliHome,
  manifestFor,
  okfDaemonHandler,
  parseJsonTail,
  runCli,
  startStub,
  subjectBelongsToOkfConcept,
  type StubHandler,
  validatingDaemonHandler,
  writtenQuadsFor,
} from './okf-test-helpers';

// CLI subcommand tests for `dkg okf {import,export}` against a tiny in-process
// stub that mimics the daemon's knowledge-asset / query routes.
// The CLI talks to the stub via the standard DKG_API_PORT + auth-token channel
// ApiClient.connect() reads, so these run the compiled CLI binary end-to-end
// without booting the daemon. They lock down the behaviours the pure mapper
// tests cannot: dry-run must NOT connect, WM import vs --share advance,
// export/verify edge cases, and default import replacement behavior.

describe.sequential('dkg okf subcommands', { timeout: 180_000 }, () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  let dkgHome: string;
  const createdCGs = new Set<string>();

  beforeAll(async () => {
    await ensureOkfCliBuilt();
    stub = await startStub();
    stub.setHandler(okfDaemonHandler(createdCGs));
    dkgHome = await makeOkfCliHome(stub.port);
  }, 120_000);

  afterAll(async () => {
    if (stub) await stub.close();
    if (dkgHome) await rm(dkgHome, { recursive: true, force: true });
  });

  const env = () => ({ DKG_API_PORT: String(stub.port), DKG_HOME: dkgHome });
  const clear = () => {
    stub.calls.length = 0;
  };
  // Rows of verify's one scoped read: a `?s ?p ?o` binding per stored copy of a
  // triple. IRIs come as SPARQL-JSON object cells, literals as the term strings
  // the daemon sends.
  const tripleRows = (triples: Array<[string, string, string]>) =>
    triples.map(([s, p, o]) => ({ s: { value: s, type: 'uri' }, p: { value: p, type: 'uri' }, o: o.startsWith('"') ? o : { value: o, type: 'uri' } }));
  // The (subject, object) pairs of each predicate in `quads`: the store's triples after a complete import.
  const pairsByPredicate = (quads: Array<{ subject: string; predicate: string; object: string }>) => {
    const out = new Map<string, Array<[string, string]>>();
    for (const line of new Set(quadsToNQuads(quads).split('\n').filter(Boolean))) {
      const [, s, p, o] = /^<([^>]+)> <([^>]+)> (.+) \.$/.exec(line)!;
      out.set(p, [...(out.get(p) ?? []), [s, o.startsWith('<') ? o.slice(1, -1) : o]]);
    }
    return out;
  };
  // A store answering the read with its triples, every triple held in `copies` named graphs.
  const storeHandler = (stored: Map<string, Array<[string, string]>>, copies: number): StubHandler => () => {
    const triples = [...stored].flatMap(([p, pairs]) => pairs.map(([s, o]): [string, string, string] => [s, p, o]));
    return { status: 200, body: { result: { bindings: tripleRows(Array.from({ length: copies }, () => triples).flat()) } } };
  };

  it('dry-run prints the mapping and NEVER contacts the node', async () => {
    clear();
    const bundle = await makeBundle();
    const r = await runCli(['okf', 'import', bundle, '--context-graph-id', 'cg', '--dry-run'], env());
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.mode).toBe('dry-run');
    expect(out.concepts).toBe(2);
    expect(out.conformant).toBe(true);
    // The whole point of --dry-run: zero node calls.
    expect(stub.calls).toHaveLength(0);
  });

  it('WM import creates KAs and writes quads, but does NOT finalize/share', async () => {
    clear();
    const bundle = await makeBundle();
    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-wm', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.memoryLayer).toBe('WM');
    expect(out.assetsCreated).toBe(2);
    expect(out.assetsShared).toBe(0);

    const paths = callPaths(stub.calls);
    expect(paths).toContain('POST /api/context-graph/create');
    expect(paths.filter((p) => p === 'POST /api/knowledge-assets')).toHaveLength(2);
    const createBodies = knowledgeAssetCreateBodies(stub.calls);
    expect(createBodies.map((b) => b.name).sort()).toEqual(['a', 'b']);
    expect(createBodies.every((b) => b.quads === undefined)).toBe(true);
    const writeBodies = ['a', 'b'].flatMap((name) => knowledgeAssetWriteBodies(stub.calls, name));
    expect(writeBodies).toHaveLength(2);
    expect(writeBodies.every((b) => Array.isArray(b.quads) && b.quads.length > 0)).toBe(true);
    const aQuads = writtenQuadsFor(stub.calls, 'a');
    const bQuads = writtenQuadsFor(stub.calls, 'b');
    expect(aQuads.every((q) => subjectBelongsToOkfConcept(q.subject, 'a'))).toBe(true);
    expect(bQuads.every((q) => subjectBelongsToOkfConcept(q.subject, 'b'))).toBe(true);
    expect(aQuads.length + bQuads.length).toBe(out.triplesWritten);
    expect(aQuads.length + bQuads.length).toBe(out.triples);
    expect(paths.some((p) => p.endsWith('/wm/discard'))).toBe(false);
    // No sealing/sharing in a plain WM import.
    expect(paths.some((p) => p.endsWith('/wm/finalize'))).toBe(false);
    expect(paths.some((p) => p.endsWith('/swm/share'))).toBe(false);

    // Manifest records the per-concept lifecycle checkpoint.
    const manifest = await manifestFor(bundle);
    expect(manifest.mode).toBe('per-concept');
    expect(manifest.stages).toEqual({ a: 'written', b: 'written' });
  });

  it('imports a concept with a malformed source URL, as a literal, and the concept after it', async () => {
    // `https://example.org/%zz` has a malformed percent escape: as an IRI the
    // daemon refuses the concept's write, which stopped the import there.
    clear();
    const dir = await mkdtemp(join(tmpdir(), 'okf-bundle-'));
    await writeFile(join(dir, 'index.md'), '---\nokf_version: "0.2"\n---\n\n# Root\n');
    await writeFile(join(dir, 'a.md'), "---\ntype: Metric\nsources: [{ resource: 'https://example.org/%zz' }]\n---\n\nbody\n");
    await writeFile(join(dir, 'z.md'), '---\ntype: Metric\ntitle: Healthy\n---\n\nbody\n');
    stub.setHandler(validatingDaemonHandler(okfDaemonHandler(createdCGs)));
    try {
      const r = await runCli(['okf', 'import', dir, '--context-graph-id', 'cg-iri', '--create-context-graph'], env());
      expect(r.exitCode, r.stderr).toBe(0);
      expect(knowledgeAssetCreateBodies(stub.calls).map((b) => b.name).sort()).toEqual(['a', 'z']);
      const aQuads = writtenQuadsFor(stub.calls, 'a');
      expect(aQuads.map((q) => q.object)).toContain('"https://example.org/%zz"');
      expect(aQuads.some((q) => q.predicate === PROV_WAS_DERIVED_FROM)).toBe(false);
      expect(writtenQuadsFor(stub.calls, 'z').length).toBeGreaterThan(0);
    } finally {
      stub.setHandler(okfDaemonHandler(createdCGs));
    }
    const dry = parseJsonTail((await runCli(['okf', 'import', dir, '--context-graph-id', 'cg-iri', '--dry-run'], env())).stdout);
    const warnings = dry.warnings as Array<{ conceptId?: string; code: string; message: string }>;
    expect(warnings).toContainEqual({ conceptId: 'a', code: 'invalid-iri', message: 'sources[0].resource "https://example.org/%zz" is not a valid IRI (RFC 3987); kept as a literal' });
  });

  it('import then import --share ADVANCES WM→SWM (does not skip finalize/share)', async () => {
    const bundle = await makeBundle();
    // First: a plain WM import.
    const wm = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-share', '--create-context-graph'],
      env(),
    );
    expect(wm.exitCode).toBe(0);

    // Then: re-run with --share. The bug was that the manifest's "done" set made
    // this skip every concept; it must instead finalize + share each one.
    clear();
    const r = await runCli(['okf', 'import', bundle, '--context-graph-id', 'cg-share', '--share'], env());
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.memoryLayer).toBe('SWM');
    expect(out.assetsShared).toBe(2);
    expect(out.assetsCreated).toBe(0); // already in WM — not recreated

    const paths = callPaths(stub.calls);
    expect(paths.filter((p) => p.endsWith('/wm/finalize'))).toHaveLength(2);
    expect(paths.filter((p) => p.endsWith('/swm/share'))).toHaveLength(2);
    const shareBodies = ['a', 'b'].flatMap((name) => knowledgeAssetShareBodies(stub.calls, name));
    expect(shareBodies).toHaveLength(2);
    expect(shareBodies.every((b) => b.entities === 'all')).toBe(true);
    // Must NOT re-create the assets that are already in WM.
    expect(paths.some((p) => p === 'POST /api/knowledge-assets')).toBe(false);

    const manifest = await manifestFor(bundle);
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });
  });

  it('legacy done manifests advance to SWM without recreating completed concepts', async () => {
    clear();
    const bundle = await makeBundle();
    createdCGs.add('cg-legacy-done');
    await writeFile(
      join(bundle, '.okf-import-manifest.json'),
      JSON.stringify(
        {
          contextGraphId: 'cg-legacy-done',
          done: ['a'],
        },
        null,
        2,
      ),
    );

    const r = await runCli(['okf', 'import', bundle, '--context-graph-id', 'cg-legacy-done', '--share'], env());
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.memoryLayer).toBe('SWM');
    expect(out.assetsCreated).toBe(1);
    expect(out.assetsShared).toBe(2);

    const paths = callPaths(stub.calls);
    expect(paths).toContain('POST /api/knowledge-assets/a/wm/finalize');
    expect(paths).toContain('POST /api/knowledge-assets/a/swm/share');
    expect(paths).not.toContain('POST /api/knowledge-assets/a/wm/write');
    expect(knowledgeAssetCreateBodies(stub.calls).map((b) => b.name)).toEqual(['b']);
    expect(knowledgeAssetWriteBodies(stub.calls, 'b')).toHaveLength(1);

    const manifest = await manifestFor(bundle);
    expect(manifest.mode).toBe('per-concept');
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });
  });

  it('export filters skolemized section nodes (no .well-known/genid files)', async () => {
    clear();
    const outDir = await mkdtemp(join(tmpdir(), 'okf-export-'));
    // Query returns a real concept (has rdf:type) AND a section genid subject
    // (schema:name only). Only the concept should become a file.
    stub.setHandler(() => ({
      status: 200,
      body: {
        result: {
          bindings: [
            { s: 'urn:okf:a', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'http://schema.org/Thing' },
            { s: 'urn:okf:a', p: 'http://schema.org/name', o: '"A"' },
            { s: 'urn:okf:a/.well-known/genid/okfsec_a_0', p: 'http://schema.org/name', o: '"Notes"' },
          ],
        },
      },
    }));
    const r = await runCli(['okf', 'export', 'cg-x', outDir], env());
    stub.setHandler(okfDaemonHandler(createdCGs)); // restore for any later tests
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.concepts).toBe(1);

    const files = await readdir(outDir, { recursive: true } as { recursive: true });
    const flat = (files as string[]).map(String);
    expect(flat).toContain('a.md');
    expect(flat.some((f) => f.includes('genid') || f.includes('.well-known'))).toBe(false);
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true }).catch(() => {});
  });

  it('export rebuilds the v0.2 families from interleaved concept and family-node bindings', async () => {
    clear();
    const outDir = await mkdtemp(join(tmpdir(), 'okf-export-families-'));
    // Two concepts whose verification / source / parameter nodes arrive
    // interleaved and ahead of their roots — any order an un-ORDERed SELECT may
    // return. Each node's payload must land in its own concept's frontmatter.
    const imported = importBundle([
      {
        path: 'metrics/a.md',
        content:
          '---\ntype: Metric\ngenerated: { by: human:alice, at: 2026-06-30T14:00:00Z }\n' +
          'verified:\n  - { by: human:alice, at: 2026-07-01T09:00:00Z }\n  - { by: process:nightly, at: 2026-07-02T02:00:00Z }\n' +
          'sources:\n  - { id: pol, resource: /metrics/b.md, author: human:alice }\n  - { id: ext, resource: https://x.example/a, usage_count: 7 }\n' +
          '---\n\nbody\n',
      },
      {
        path: 'metrics/b.md',
        content:
          '---\ntype: Attested Computation\nruntime: bigquery\n' +
          'parameters:\n  - { name: year, type: integer, required: true }\n  - { name: region, type: string, required: false }\n' +
          'verified: { by: process:finance, at: 2026-07-03T00:00:00Z }\n---\n\nbody\n',
      },
    ]);
    const rows = imported.quads.map((q) => ({ s: q.subject, p: q.predicate, o: q.object }));
    const ownerOf = (subject: string) => subject.split('/.well-known/')[0];
    const isNode = (b: { s: string }) => b.s.includes('/.well-known/genid/');
    const nodesA = rows.filter((b) => isNode(b) && ownerOf(b.s) === 'urn:okf:metrics/a').reverse();
    const nodesB = rows.filter((b) => isNode(b) && ownerOf(b.s) === 'urn:okf:metrics/b').reverse();
    const bindings: typeof rows = [];
    while (nodesA.length || nodesB.length) {
      // strictly alternate owners, each owner's nodes in reverse index order
      if (nodesA.length) bindings.push(nodesA.shift()!);
      if (nodesB.length) bindings.push(nodesB.shift()!);
    }
    // the concept roots come last: every family node arrives before its owner
    bindings.push(...rows.filter((b) => !isNode(b)).reverse());
    expect(ownerOf(bindings[0].s)).not.toBe(ownerOf(bindings[1].s));
    expect(isNode(bindings[0])).toBe(true);
    stub.setHandler(() => ({ status: 200, body: { result: { bindings } } }));
    const r = await runCli(['okf', 'export', 'cg-x', outDir], env());
    stub.setHandler(okfDaemonHandler(createdCGs));
    expect(r.exitCode).toBe(0);
    expect(parseJsonTail(r.stdout).concepts).toBe(2);

    const fmOf = async (path: string) => parseDocument(path, await readFile(join(outDir, path), 'utf-8')).frontmatter;
    const a = await fmOf('metrics/a.md');
    const b = await fmOf('metrics/b.md');
    expect(a.generated).toEqual({ by: 'human:alice', at: '2026-06-30T14:00:00Z' });
    expect(a.verified).toEqual([
      { by: 'human:alice', at: '2026-07-01T09:00:00Z' },
      { by: 'process:nightly', at: '2026-07-02T02:00:00Z' },
    ]);
    expect(a.sources).toEqual([
      { id: 'pol', resource: '/metrics/b.md', author: 'human:alice' },
      { id: 'ext', resource: 'https://x.example/a', usage_count: 7 },
    ]);
    expect(a.parameters).toBeUndefined();
    expect(b.type).toBe('Attested Computation');
    expect(b.parameters).toEqual([
      { name: 'year', type: 'integer', required: true },
      { name: 'region', type: 'string', required: false },
    ]);
    expect(b.verified).toEqual([{ by: 'process:finance', at: '2026-07-03T00:00:00Z' }]);
    expect(b.sources).toBeUndefined();

    const written = ((await readdir(outDir, { recursive: true } as { recursive: true })) as string[]).map(String);
    expect(written.some((f) => f.includes('genid') || f.includes('.well-known'))).toBe(false);
    expect(written.filter((f) => f.endsWith('.md') && !f.endsWith('index.md')).sort()).toEqual(['metrics/a.md', 'metrics/b.md']);
    await rm(outDir, { recursive: true, force: true });
  });

  it('export refuses to write a subject that escapes the output directory', async () => {
    clear();
    const outDir = await mkdtemp(join(tmpdir(), 'okf-export-trav-'));
    // A hostile graph subject with ../ would otherwise write outside outDir.
    stub.setHandler(() => ({
      status: 200,
      body: {
        result: {
          bindings: [
            { s: 'urn:okf:../../escaped', p: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', o: 'http://schema.org/Thing' },
            { s: 'urn:okf:../../escaped', p: 'http://schema.org/name', o: '"x"' },
          ],
        },
      },
    }));
    const r = await runCli(['okf', 'export', 'cg-x', outDir], env());
    stub.setHandler(okfDaemonHandler(createdCGs));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('Refusing to write outside the output directory');
    await rm(outDir, { recursive: true, force: true });
  });

  it('--relate types dataset→table edges as hasPart (dry-run, deterministic)', async () => {
    clear();
    const dir = await mkdtemp(join(tmpdir(), 'okf-relate-'));
    await writeFile(join(dir, 'index.md'), '---\nokf_version: "0.1"\n---\n# Root\n');
    await writeFile(join(dir, 'ds.md'), '---\ntype: Dataset\ntitle: DS\n---\n\nSee [t](t.md).\n');
    await writeFile(join(dir, 't.md'), '---\ntype: Table\ntitle: T\n---\n\nplain\n');
    const r = await runCli(
      ['okf', 'import', dir, '--context-graph-id', 'cg', '--dry-run', '--print-nquads',
        '--relate', 'Dataset>Table=hasPart'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    expect(stub.calls).toHaveLength(0); // dry-run never connects
    expect(r.stdout).toContain('<http://schema.org/hasPart> <urn:okf:t>');
    expect(r.stdout).not.toContain('<http://schema.org/mentions> <urn:okf:t>');
    await rm(dir, { recursive: true, force: true });
  });

  it('--replace discards the existing WM draft before re-writing', async () => {
    const bundle = await makeBundle();
    // First WM import.
    await runCli(['okf', 'import', bundle, '--context-graph-id', 'cg-rep', '--create-context-graph'], env());
    // Re-import with --replace: must discard each KA's WM draft, then re-create.
    clear();
    const r = await runCli(['okf', 'import', bundle, '--context-graph-id', 'cg-rep', '--replace'], env());
    expect(r.exitCode).toBe(0);
    const paths = callPaths(stub.calls);
    expect(paths.filter((p) => p.endsWith('/wm/discard'))).toHaveLength(2);
    expect(paths.filter((p) => p === 'POST /api/knowledge-assets')).toHaveLength(2);
    await rm(bundle, { recursive: true, force: true });
  });

  it('warns and skips a symlinked bundle entry (no exfiltration)', async () => {
    clear();
    const dir = await mkdtemp(join(tmpdir(), 'okf-sym-'));
    await writeFile(join(dir, 'index.md'), '---\nokf_version: "0.1"\n---\n# Root\n');
    await writeFile(join(dir, 'a.md'), '---\ntype: Thing\ntitle: A\n---\n\nbody\n');
    const secret = join(dir, 'secret.txt');
    await writeFile(secret, 'SECRET-XYZ');
    try {
      await symlink(secret, join(dir, 'leak.md'));
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        await rm(dir, { recursive: true, force: true });
        return;
      }
      throw err;
    }
    const r = await runCli(['okf', 'import', dir, '--context-graph-id', 'cg', '--dry-run'], env());
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('skipped symlinked bundle entry');
    expect(r.stdout).not.toContain('SECRET-XYZ');
    const out = parseJsonTail(r.stdout);
    expect(out.concepts).toBe(1); // only a.md, not the symlink
    await rm(dir, { recursive: true, force: true });
  });

  it('export normalizes SPARQL-JSON object binding cells (not just bare strings)', async () => {
    clear();
    const outDir = await mkdtemp(join(tmpdir(), 'okf-export-obj-'));
    // The daemon's /api/query can return each cell as `{ value, type, datatype? }`
    // rather than a bare string. The command must normalize these — previously
    // `unwrapIri(b.s).startsWith` threw on the object form.
    stub.setHandler(() => ({
      status: 200,
      body: {
        result: {
          bindings: [
            {
              s: { value: 'urn:okf:a', type: 'uri' },
              p: { value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', type: 'uri' },
              o: { value: 'http://schema.org/Thing', type: 'uri' },
            },
            {
              s: { value: 'urn:okf:a', type: 'uri' },
              p: { value: 'http://schema.org/name', type: 'uri' },
              o: { value: '"A"', type: 'literal' },
            },
          ],
        },
      },
    }));
    const r = await runCli(['okf', 'export', 'cg-obj', outDir], env());
    stub.setHandler(okfDaemonHandler(createdCGs));
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.concepts).toBe(1);
    const files = (await readdir(outDir, { recursive: true } as { recursive: true })) as string[];
    expect(files.map(String)).toContain('a.md');
    await rm(outDir, { recursive: true, force: true });
  });

  it('verify gates on scoped per-predicate counts and reads object-form cells', async () => {
    clear();
    // Clean 2-concept bundle, no headings/links: predicates are rdf:type×2, schema:name×2.
    const dir = await mkdtemp(join(tmpdir(), 'okf-verify-'));
    await writeFile(join(dir, 'index.md'), '---\nokf_version: "0.1"\n---\n# Root\n');
    await writeFile(join(dir, 'x.md'), '---\ntype: Thing\ntitle: X\n---\n\nplain body\n');
    await writeFile(join(dir, 'y.md'), '---\ntype: Thing\ntitle: Y\n---\n\nplain body\n');

    const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const NAME = 'http://schema.org/name';
    // The stored pairs come back as SPARQL-JSON OBJECT cells (exercises the cell reading in verify).
    const issuedSparql: string[] = [];
    const countHandler =
      (counts: Record<string, number>): StubHandler =>
      (req, body) => {
        const sparql = String(JSON.parse(body || '{}').sparql ?? '');
        issuedSparql.push(sparql);
        const triples = Object.entries(counts).flatMap(([p, n]) => Array.from({ length: n }, (_, i): [string, string, string] => [`urn:okf:c${i}`, p, `"v${i}"`]));
        return { status: 200, body: { result: { bindings: tripleRows(triples) } } };
      };

    // All present → complete, zero missing, exit 0.
    stub.setHandler(countHandler({ [TYPE]: 2, [NAME]: 2 }));
    const ok = await runCli(['okf', 'verify', dir, '--context-graph-id', 'cg-v'], env());
    expect(ok.exitCode).toBe(0);
    const okOut = parseJsonTail(ok.stdout);
    expect(okOut.complete).toBe(true);
    expect(okOut.totalMissingTriples).toBe(0);

    // SCOPING CONTRACT: every count must be filtered to subjects under the bundle's
    // IRI prefix — otherwise unrelated pre-existing graph triples could mask (or
    // inflate) a real shortfall and report "complete" while concepts are missing.
    // A regression dropping the STRSTARTS filter fails here.
    expect(issuedSparql.length).toBeGreaterThan(0);
    for (const s of issuedSparql) expect(s).toMatch(/STRSTARTS\(STR\(\?s\)/);

    // One name missing → shortfall → complete:false, non-zero exit (pipeline gate).
    stub.setHandler(countHandler({ [TYPE]: 2, [NAME]: 1 }));
    const bad = await runCli(['okf', 'verify', dir, '--context-graph-id', 'cg-v'], env());
    stub.setHandler(okfDaemonHandler(createdCGs));
    expect(bad.exitCode).not.toBe(0);
    const badOut = parseJsonTail(bad.stdout);
    expect(badOut.complete).toBe(false);
    expect(badOut.totalMissingTriples).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  it('verify counts distinct triples: sources repeating a resource pass after a complete import', async () => {
    clear();
    // Four sources, two distinct resources. The lineage edge to each resource is
    // one triple in the store however many sources name it.
    const dir = await mkdtemp(join(tmpdir(), 'okf-verify-dup-'));
    const files = [
      { path: 'index.md', content: '---\nokf_version: "0.2"\n---\n# Root\n' },
      {
        path: 'm.md',
        content:
          '---\ntype: Metric\nsources:\n' +
          '  - { id: a, resource: /p.md }\n  - { id: b, resource: p.md }\n' +
          '  - { id: c, resource: https://x.example/doc }\n  - { id: d, resource: https://x.example/doc }\n---\n\nbody\n',
      },
      { path: 'p.md', content: '---\ntype: Policy\n---\n\nbody\n' },
    ];
    for (const f of files) await writeFile(join(dir, f.path), f.content);

    // The store after a complete import: a SET of triples, each held in two named graphs.
    const stored = pairsByPredicate(importBundle(files).quads);
    stub.setHandler(storeHandler(stored, 2));
    const r = await runCli(['okf', 'verify', dir, '--context-graph-id', 'cg-dup'], env());
    stub.setHandler(okfDaemonHandler(createdCGs));
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.complete).toBe(true);
    expect(out.totalMissingTriples).toBe(0);
    const rows = out.predicates as Array<{ predicate: string; expected: number; actual: number; missing: number }>;
    expect(rows.find((row) => row.predicate === PROV_WAS_DERIVED_FROM)).toMatchObject({ expected: 2, actual: 2, missing: 0 });
    await rm(dir, { recursive: true, force: true });
  });

  it('verify counts a triple held in several named graphs once, so a copy never hides a missing triple', async () => {
    clear();
    // tags: [a, a, b] is two triples. Two named graphs holding the `a` triple,
    // and none holding `b`, leave one missing; with `b` there too it is complete.
    const dir = await mkdtemp(join(tmpdir(), 'okf-verify-copies-'));
    const files = [
      { path: 'index.md', content: '---\nokf_version: "0.1"\n---\n# Root\n' },
      { path: 'x.md', content: '---\ntype: Thing\ntags: [a, a, b]\n---\n\nbody\n' },
    ];
    for (const f of files) await writeFile(join(dir, f.path), f.content);
    const KEYWORDS = 'http://schema.org/keywords';
    const complete = pairsByPredicate(importBundle(files).quads);
    const verifyWith = async (keywords: Array<[string, string]>) => {
      stub.setHandler(storeHandler(new Map([...complete, [KEYWORDS, keywords]]), 1));
      const r = await runCli(['okf', 'verify', dir, '--context-graph-id', 'cg-copies'], env());
      stub.setHandler(okfDaemonHandler(createdCGs));
      const out = parseJsonTail(r.stdout);
      const row = (out.predicates as Array<{ predicate: string; expected: number; actual: number; missing: number }>).find((p) => p.predicate === KEYWORDS);
      return { exitCode: r.exitCode, complete: out.complete, row };
    };
    const missingB = await verifyWith([['urn:okf:x', '"a"'], ['urn:okf:x', '"a"']]);
    expect(missingB.exitCode).not.toBe(0);
    expect(missingB.complete).toBe(false);
    expect(missingB.row).toMatchObject({ expected: 2, actual: 1, missing: 1 });
    const withCopies = await verifyWith([['urn:okf:x', '"a"'], ['urn:okf:x', '"a"'], ['urn:okf:x', '"b"']]);
    expect(withCopies.exitCode).toBe(0);
    expect(withCopies.complete).toBe(true);
    expect(withCopies.row).toMatchObject({ expected: 2, actual: 2, missing: 0 });
    await rm(dir, { recursive: true, force: true });
  });

  it('verify --relate mirrors the import mapping (COUNTs the typed predicate, not schema:mentions)', async () => {
    clear();
    // A Dataset→Table link: default mapping → schema:mentions; --relate → schema:hasPart.
    const dir = await mkdtemp(join(tmpdir(), 'okf-verify-relate-'));
    await writeFile(join(dir, 'index.md'), '---\nokf_version: "0.1"\n---\n# Root\n');
    await writeFile(join(dir, 'ds.md'), '---\ntype: Dataset\ntitle: DS\n---\n\nSee [t](t.md).\n');
    await writeFile(join(dir, 't.md'), '---\ntype: Table\ntitle: T\n---\n\nplain\n');

    const countOne: StubHandler = () => ({
      status: 200,
      body: { result: { bindings: tripleRows([['urn:okf:ds', 'http://schema.org/mentions', 'urn:okf:t']]) } },
    });
    const verifySparql = async (extra: string[]): Promise<string> => {
      const issued: string[] = [];
      stub.setHandler((req, body) => {
        issued.push(String(JSON.parse(body || '{}').sparql ?? ''));
        return countOne();
      });
      await runCli(['okf', 'verify', dir, '--context-graph-id', 'cg-vr', ...extra], env());
      return issued.join('\n');
    };

    // Without --relate: the offline expectation falls back to the default edge predicate.
    const def = await verifySparql([]);
    expect(def).toContain('<http://schema.org/mentions>');

    // With --relate: the expectation mirrors the import, so verify COUNTs schema:hasPart
    // for the typed edge and NEVER schema:mentions — a real --relate import now verifies
    // instead of reporting a false shortfall.
    const rel = await verifySparql(['--relate', 'Dataset>Table=hasPart']);
    expect(rel).toContain('<http://schema.org/hasPart>');
    expect(rel).not.toContain('<http://schema.org/mentions>');

    stub.setHandler(okfDaemonHandler(createdCGs));
    await rm(dir, { recursive: true, force: true });
  });
});
