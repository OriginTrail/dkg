import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  callPaths,
  ensureOkfCliBuilt,
  knowledgeAssetCreateBodies,
  knowledgeAssetWriteBodies,
  makeBundle,
  makeOkfCliHome,
  manifestFor,
  okfDaemonHandler,
  parseJsonTail,
  runCli,
  startStub,
  type StubHandler,
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
    expect(paths.some((p) => p.endsWith('/wm/discard'))).toBe(false);
    // No sealing/sharing in a plain WM import.
    expect(paths.some((p) => p.endsWith('/wm/finalize'))).toBe(false);
    expect(paths.some((p) => p.endsWith('/swm/share'))).toBe(false);

    // Manifest records the per-concept lifecycle checkpoint.
    const manifest = await manifestFor(bundle);
    expect(manifest.mode).toBe('per-concept');
    expect(manifest.stages).toEqual({ a: 'written', b: 'written' });
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
    // Must NOT re-create the assets that are already in WM.
    expect(paths.some((p) => p === 'POST /api/knowledge-assets')).toBe(false);

    const manifest = await manifestFor(bundle);
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

  it('verify gates on scoped per-predicate counts and normalizes object-form count cells', async () => {
    clear();
    // Clean 2-concept bundle, no headings/links: predicates are rdf:type×2, schema:name×2.
    const dir = await mkdtemp(join(tmpdir(), 'okf-verify-'));
    await writeFile(join(dir, 'index.md'), '---\nokf_version: "0.1"\n---\n# Root\n');
    await writeFile(join(dir, 'x.md'), '---\ntype: Thing\ntitle: X\n---\n\nplain body\n');
    await writeFile(join(dir, 'y.md'), '---\ntype: Thing\ntitle: Y\n---\n\nplain body\n');

    const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const NAME = 'http://schema.org/name';
    // COUNT(*) returned as a SPARQL-JSON OBJECT cell (exercises the cell() fix in verify).
    const issuedSparql: string[] = [];
    const countHandler =
      (counts: Record<string, number>): StubHandler =>
      (req, body) => {
        const sparql = String(JSON.parse(body || '{}').sparql ?? '');
        issuedSparql.push(sparql);
        const pred = Object.keys(counts).find((p) => sparql.includes(`<${p}>`)) ?? '';
        return {
          status: 200,
          body: { result: { bindings: [{ c: { value: String(counts[pred] ?? 0), type: 'literal' } }] } },
        };
      };

    // All present → complete, zero missing, exit 0.
    stub.setHandler(countHandler({ [TYPE]: 2, [NAME]: 2 }));
    const ok = await runCli(['okf', 'verify', dir, '--context-graph-id', 'cg-v'], env());
    expect(ok.exitCode).toBe(0);
    const okOut = parseJsonTail(ok.stdout);
    expect(okOut.complete).toBe(true);
    expect(okOut.totalMissingTriples).toBe(0);

    // SCOPING CONTRACT: every COUNT must be filtered to subjects under the bundle's
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

  it('verify --relate mirrors the import mapping (COUNTs the typed predicate, not schema:mentions)', async () => {
    clear();
    // A Dataset→Table link: default mapping → schema:mentions; --relate → schema:hasPart.
    const dir = await mkdtemp(join(tmpdir(), 'okf-verify-relate-'));
    await writeFile(join(dir, 'index.md'), '---\nokf_version: "0.1"\n---\n# Root\n');
    await writeFile(join(dir, 'ds.md'), '---\ntype: Dataset\ntitle: DS\n---\n\nSee [t](t.md).\n');
    await writeFile(join(dir, 't.md'), '---\ntype: Table\ntitle: T\n---\n\nplain\n');

    const countOne: StubHandler = () => ({
      status: 200,
      body: { result: { bindings: [{ c: { value: '1', type: 'literal' } }] } },
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
