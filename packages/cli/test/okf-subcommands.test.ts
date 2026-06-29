import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

// CLI subcommand tests for `dkg okf {import,export}` against a tiny in-process
// stub that mimics the daemon's knowledge-asset / shared-memory / query routes.
// The CLI talks to the stub via the standard DKG_API_PORT + auth-token channel
// ApiClient.connect() reads, so these run the compiled CLI binary end-to-end
// without booting the daemon. They lock down the behaviours the pure mapper
// tests cannot: dry-run must NOT connect, WM import vs --share advance, the
// --private bulk SWM path + manifest, and the export skolem-node filter.

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'dist', 'cli.js');

interface StubCall {
  method: string;
  url: string;
  authorization?: string;
  body: string;
}

interface StubResult {
  status: number;
  body: unknown;
}
type StubHandler = (req: IncomingMessage, body: string) => StubResult;

function startStub(): Promise<{
  port: number;
  setHandler: (h: StubHandler) => void;
  calls: StubCall[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    let handler: StubHandler = () => ({ status: 500, body: { error: 'No handler installed' } });
    const calls: StubCall[] = [];
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        calls.push({
          method: req.method ?? '',
          url: req.url ?? '',
          authorization: req.headers.authorization,
          body: raw,
        });
        const result = handler(req, raw);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        setHandler: (h) => {
          handler = h;
        },
        calls,
        close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
  });
}

/**
 * A stub daemon that records calls and serves the knowledge-asset lifecycle
 * with minimal success bodies. Tracks created Context Graphs so
 * `context-graph/exists` answers truthfully across CLI invocations.
 */
function okfDaemonHandler(createdCGs: Set<string>): StubHandler {
  return (req, body) => {
    const url = new URL(`http://x${req.url ?? ''}`);
    const path = url.pathname;
    const m = req.method ?? '';
    if (m === 'GET' && path === '/api/context-graph/exists') {
      return { status: 200, body: { id: url.searchParams.get('id'), exists: createdCGs.has(url.searchParams.get('id') ?? '') } };
    }
    if (m === 'POST' && path === '/api/context-graph/create') {
      const id = JSON.parse(body || '{}').id as string;
      createdCGs.add(id);
      return { status: 200, body: { created: id, uri: `did:dkg:context-graph:${id}` } };
    }
    if (m === 'POST' && path === '/api/context-graph/invite') {
      return { status: 200, body: { invited: 'ok', contextGraphId: JSON.parse(body || '{}').contextGraphId } };
    }
    if (m === 'POST' && path === '/api/knowledge-assets') {
      return { status: 200, body: { created: true } };
    }
    if (m === 'POST' && /\/api\/knowledge-assets\/.+\/wm\/write$/.test(path)) {
      const quads = JSON.parse(body || '{}').quads ?? [];
      return { status: 200, body: { written: quads.length } };
    }
    if (m === 'POST' && /\/api\/knowledge-assets\/.+\/wm\/discard$/.test(path)) {
      return { status: 200, body: { discarded: true } };
    }
    if (m === 'POST' && /\/api\/knowledge-assets\/.+\/wm\/finalize$/.test(path)) {
      return { status: 200, body: { merkleRoot: '0xroot', eip712Digest: '0xdig' } };
    }
    if (m === 'POST' && /\/api\/knowledge-assets\/.+\/swm\/share$/.test(path)) {
      return { status: 200, body: { swmShared: true, promotedCount: 1 } };
    }
    if (m === 'POST' && path === '/api/shared-memory/write') {
      const quads = JSON.parse(body || '{}').quads ?? [];
      return { status: 200, body: { shareOperationId: 'op-1', contextGraphId: 'x', graph: 'g', triplesWritten: quads.length } };
    }
    return { status: 404, body: { error: 'NotFound', path } };
  };
}

async function runCli(
  args: string[],
  env: { DKG_API_PORT: string; DKG_HOME: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const c = err as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    return { exitCode: typeof c.code === 'number' ? c.code : 1, stdout: c.stdout ?? '', stderr: c.stderr ?? '' };
  }
}

/**
 * Import prints human progress lines ("Created Context Graph …", "  WM  a → …")
 * before the final JSON summary, so parse from the first `{` (none of the
 * progress lines contain a brace).
 */
function parseJsonTail(stdout: string): Record<string, unknown> {
  const i = stdout.indexOf('{');
  return JSON.parse(stdout.slice(i)) as Record<string, unknown>;
}

/** A minimal conformant 2-concept OKF bundle in a fresh temp dir. */
async function makeBundle(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'okf-bundle-'));
  await writeFile(join(dir, 'index.md'), '---\nokf_version: "0.1"\n---\n\n# Root\n');
  await writeFile(join(dir, 'a.md'), '---\ntype: Thing\ntitle: A\n---\n\n# Notes\n\nSee [b](b.md).\n');
  await writeFile(join(dir, 'b.md'), '---\ntype: Thing\ntitle: B\n---\n\nplain body\n');
  return dir;
}

describe.sequential('dkg okf subcommands', { timeout: 120_000 }, () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  let dkgHome: string;
  const createdCGs = new Set<string>();

  beforeAll(async () => {
    if (!existsSync(CLI_ENTRY)) {
      await execFileAsync('pnpm', ['build'], { cwd: join(__dirname, '..') });
    }
    stub = await startStub();
    stub.setHandler(okfDaemonHandler(createdCGs));
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-okf-cli-'));
    await writeFile(
      join(dkgHome, 'config.json'),
      JSON.stringify({ name: 'okf-cli-stub', apiPort: stub.port, listenPort: 0, nodeRole: 'edge', paranets: [] }),
    );
    await writeFile(join(dkgHome, 'auth.token'), 'stub-token\n', { mode: 0o600 });
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

    const paths = stub.calls.map((c) => `${c.method} ${c.url.split('?')[0]}`);
    expect(paths).toContain('POST /api/context-graph/create');
    expect(paths.filter((p) => p === 'POST /api/knowledge-assets')).toHaveLength(2);
    expect(paths.some((p) => p.endsWith('/wm/write'))).toBe(true);
    // No sealing/sharing in a plain WM import.
    expect(paths.some((p) => p.endsWith('/wm/finalize'))).toBe(false);
    expect(paths.some((p) => p.endsWith('/swm/share'))).toBe(false);

    // Manifest records the per-concept stage as 'wm'.
    const manifest = JSON.parse(await readFile(join(bundle, '.okf-import-manifest.json'), 'utf-8'));
    expect(manifest.mode).toBe('per-concept');
    expect(manifest.stages).toEqual({ a: 'wm', b: 'wm' });
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

    const paths = stub.calls.map((c) => `${c.method} ${c.url.split('?')[0]}`);
    expect(paths.filter((p) => p.endsWith('/wm/finalize'))).toHaveLength(2);
    expect(paths.filter((p) => p.endsWith('/swm/share'))).toHaveLength(2);
    // Must NOT re-create the assets that are already in WM.
    expect(paths.some((p) => p === 'POST /api/knowledge-assets')).toBe(false);

    const manifest = JSON.parse(await readFile(join(bundle, '.okf-import-manifest.json'), 'utf-8'));
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });
  });

  it('--private bulk-streams quads via /api/shared-memory/write with a chunked manifest', async () => {
    clear();
    const bundle = await makeBundle();
    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv', '--private', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.importMode).toBe('bulk-private-swm');
    expect(out.datasetPointer).toBe('did:dkg:context-graph:cg-priv');
    expect(out.triplesWritten).toBeGreaterThan(0);

    const paths = stub.calls.map((c) => `${c.method} ${c.url.split('?')[0]}`);
    expect(paths).toContain('POST /api/shared-memory/write');
    // The private bulk path never creates per-concept KAs.
    expect(paths.some((p) => p === 'POST /api/knowledge-assets')).toBe(false);

    const manifest = JSON.parse(await readFile(join(bundle, '.okf-import-manifest.json'), 'utf-8'));
    expect(manifest.mode).toBe('bulk-private-swm');
    expect(manifest.chunksDone).toBe(manifest.totalChunks);
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
    const paths = stub.calls.map((c) => `${c.method} ${c.url.split('?')[0]}`);
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
    await symlink(secret, join(dir, 'leak.md'));
    const r = await runCli(['okf', 'import', dir, '--context-graph-id', 'cg', '--dry-run'], env());
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('skipped symlinked bundle entry');
    expect(r.stdout).not.toContain('SECRET-XYZ');
    const out = parseJsonTail(r.stdout);
    expect(out.concepts).toBe(1); // only a.md, not the symlink
    await rm(dir, { recursive: true, force: true });
  });
});
