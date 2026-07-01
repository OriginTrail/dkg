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
// stub that mimics the daemon's knowledge-asset / query routes.
// The CLI talks to the stub via the standard DKG_API_PORT + auth-token channel
// ApiClient.connect() reads, so these run the compiled CLI binary end-to-end
// without booting the daemon. They lock down the behaviours the pure mapper
// tests cannot: dry-run must NOT connect, WM import vs --share advance, the
// --private per-concept lifecycle path + manifest, and the export skolem-node filter.

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
      const parsed = JSON.parse(body || '{}');
      const quads = Array.isArray(parsed.quads) ? parsed.quads : [];
      return { status: 201, body: { created: true, written: quads.length } };
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

function callPath(call: StubCall): string {
  return call.url.split('?')[0];
}

function callPaths(calls: StubCall[]): string[] {
  return calls.map((c) => `${c.method} ${callPath(c)}`);
}

function bodyOf(call: StubCall): Record<string, unknown> {
  return JSON.parse(call.body || '{}') as Record<string, unknown>;
}

function knowledgeAssetCreateBodies(calls: StubCall[]): Record<string, unknown>[] {
  return calls
    .filter((c) => c.method === 'POST' && callPath(c) === '/api/knowledge-assets')
    .map(bodyOf);
}

function knowledgeAssetWriteBodies(calls: StubCall[], name: string): Record<string, unknown>[] {
  return calls
    .filter((c) => c.method === 'POST' && callPath(c) === `/api/knowledge-assets/${name}/wm/write`)
    .map(bodyOf);
}

async function manifestFor(bundle: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(bundle, '.okf-import-manifest.json'), 'utf-8')) as Record<string, unknown>;
}

/** A minimal conformant 2-concept OKF bundle in a fresh temp dir. */
async function makeBundle(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'okf-bundle-'));
  await writeFile(join(dir, 'index.md'), '---\nokf_version: "0.1"\n---\n\n# Root\n');
  await writeFile(join(dir, 'a.md'), '---\ntype: Thing\ntitle: A\n---\n\n# Notes\n\nSee [b](b.md).\n');
  await writeFile(join(dir, 'b.md'), '---\ntype: Thing\ntitle: B\n---\n\nplain body\n');
  return dir;
}

async function makeLargeTaggedBundle(tagCount = 5200): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'okf-large-bundle-'));
  const tags = Array.from({ length: tagCount }, (_, i) => `  - tag-${String(i).padStart(4, '0')}`)
    .join('\n');
  await writeFile(join(dir, 'index.md'), '---\nokf_version: "0.1"\n---\n\n# Root\n');
  await writeFile(join(dir, 'bulk.md'), `---\ntype: Thing\ntitle: Bulk\ntags:\n${tags}\n---\n\nplain body\n`);
  return dir;
}

describe.sequential('dkg okf subcommands', { timeout: 180_000 }, () => {
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

    const paths = callPaths(stub.calls);
    expect(paths).toContain('POST /api/context-graph/create');
    expect(paths.filter((p) => p === 'POST /api/knowledge-assets')).toHaveLength(2);
    const createBodies = knowledgeAssetCreateBodies(stub.calls);
    expect(createBodies.map((b) => b.name).sort()).toEqual(['a', 'b']);
    expect(createBodies.every((b) => b.quads === undefined)).toBe(true);
    const writeBodies = ['a', 'b'].flatMap((name) => knowledgeAssetWriteBodies(stub.calls, name));
    expect(writeBodies).toHaveLength(2);
    expect(writeBodies.every((b) => Array.isArray(b.quads) && b.quads.length > 0)).toBe(true);
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

  it('--private imports every concept as its own lifecycle KA in a private CG', async () => {
    clear();
    const bundle = await makeBundle();
    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv', '--private', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.importMode).toBe('per-concept');
    expect(out.memoryLayer).toBe('SWM');
    expect(out.triplesWritten).toBeGreaterThan(0);
    expect(out.assetsCreated).toBe(2);
    expect(out.assetsShared).toBe(2);
    expect(out.assetName).toBeUndefined();

    const paths = callPaths(stub.calls);
    expect(paths.filter((p) => p === 'POST /api/knowledge-assets')).toHaveLength(2);
    const createBodies = knowledgeAssetCreateBodies(stub.calls);
    expect(createBodies.map((b) => b.name).sort()).toEqual(['a', 'b']);
    expect(createBodies.every((b) => b.quads === undefined && b.alsoShareSwm === undefined)).toBe(true);
    const writeBodies = ['a', 'b'].flatMap((name) => knowledgeAssetWriteBodies(stub.calls, name));
    expect(writeBodies).toHaveLength(2);
    expect(writeBodies.every((b) => Array.isArray(b.quads) && b.quads.length > 0)).toBe(true);
    expect(paths.filter((p) => p.endsWith('/wm/finalize'))).toHaveLength(2);
    expect(paths.filter((p) => p.endsWith('/swm/share'))).toHaveLength(2);
    expect(paths.some((p) => /private-bulk/.test(p))).toBe(false);
    expect(paths.some((p) => p.startsWith('POST /api/shared-memory'))).toBe(false);

    // PRIVACY CONTRACT: the Context Graph must be created invite-only. A regression
    // that dropped `{ private: true, accessPolicy: 1 }` would import the corpus
    // into a public CG — exactly the substance-leak this mode must prevent.
    const createCall = stub.calls.find(
      (c) => c.method === 'POST' && callPath(c) === '/api/context-graph/create',
    );
    expect(createCall).toBeDefined();
    const createBody = bodyOf(createCall!);
    expect(createBody.private).toBe(true);
    expect(createBody.accessPolicy).toBe(1);

    const manifest = await manifestFor(bundle);
    expect(manifest.mode).toBe('per-concept');
    expect(manifest.assetName).toBeUndefined();
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });
  });

  it('--private resumes per-concept WM stages by sharing without recreating or rewriting', async () => {
    clear();
    const bundle = await makeBundle();
    await writeFile(
      join(bundle, '.okf-import-manifest.json'),
      JSON.stringify(
        {
          contextGraphId: 'cg-priv-resume',
          mode: 'per-concept',
          stages: { a: 'wm' },
        },
        null,
        2,
      ),
    );

    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-resume', '--private', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.importMode).toBe('per-concept');
    expect(out.assetsCreated).toBe(1);
    expect(out.assetsShared).toBe(2);

    const paths = callPaths(stub.calls);
    const createBodies = knowledgeAssetCreateBodies(stub.calls);
    expect(createBodies.map((b) => b.name)).toEqual(['b']);
    expect(knowledgeAssetWriteBodies(stub.calls, 'b')).toHaveLength(1);
    expect(paths).toContain('POST /api/knowledge-assets/a/wm/finalize');
    expect(paths).toContain('POST /api/knowledge-assets/a/swm/share');
    expect(paths.some((p) => p === 'POST /api/knowledge-assets/a/wm/write')).toBe(false);

    const manifest = await manifestFor(bundle);
    expect(manifest.mode).toBe('per-concept');
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });
  });

  it('--private records finalized progress before a failed share and resumes without rewriting', async () => {
    clear();
    const bundle = await makeBundle();
    let failFirstShare = true;
    stub.setHandler((req, raw) => {
      const url = new URL(`http://127.0.0.1${req.url}`);
      if (req.method === 'POST' && url.pathname === '/api/knowledge-assets/a/swm/share' && failFirstShare) {
        failFirstShare = false;
        return { status: 200, body: { swmShared: false, promotedCount: 0 } };
      }
      return okfDaemonHandler(createdCGs)(req, raw);
    });

    const failed = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-share-fail', '--private', '--create-context-graph'],
      env(),
    );
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr).toContain('share did not report swmShared:true');
    let manifest = await manifestFor(bundle);
    expect(manifest.stages).toEqual({ a: 'finalized' });

    clear();
    stub.setHandler(okfDaemonHandler(createdCGs));
    const resumed = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-share-fail', '--private', '--create-context-graph'],
      env(),
    );
    expect(resumed.exitCode).toBe(0);
    const paths = callPaths(stub.calls);
    const createBodies = knowledgeAssetCreateBodies(stub.calls);
    expect(createBodies.map((b) => b.name)).toEqual(['b']);
    expect(knowledgeAssetWriteBodies(stub.calls, 'b')).toHaveLength(1);
    expect(paths).toContain('POST /api/knowledge-assets/a/swm/share');
    expect(paths).not.toContain('POST /api/knowledge-assets/a/wm/finalize');
    expect(paths.some((p) => p === 'POST /api/knowledge-assets/a/wm/write')).toBe(false);
    manifest = await manifestFor(bundle);
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });
  });

  it('--private ignores real bulk-private-lifecycle manifests and starts per-concept lifecycle', async () => {
    clear();
    const bundle = await makeBundle();
    await writeFile(
      join(bundle, '.okf-import-manifest.json'),
      JSON.stringify(
        {
          contextGraphId: 'cg-priv-legacy',
          mode: 'bulk-private-lifecycle',
          assetName: 'okf-private-bulk-root',
          chunkSize: 5000,
          chunksDone: 999,
          totalChunks: 999,
          draftCreated: true,
          finalized: true,
          shared: true,
        },
        null,
        2,
      ),
    );

    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-legacy', '--private', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.assetsCreated).toBe(2);
    expect(r.stderr).toContain('ignoring incompatible OKF manifest');

    const paths = callPaths(stub.calls);
    expect(paths.filter((p) => p === 'POST /api/knowledge-assets')).toHaveLength(2);
    expect(paths.some((p) => p.includes('okf-private-bulk-root'))).toBe(false);

    const manifest = await manifestFor(bundle);
    expect(manifest.mode).toBe('per-concept');
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });
    expect(manifest.assetName).toBeUndefined();
  });

  it('--private forwards --sub-graph-name through lifecycle bodies + manifest', async () => {
    clear();
    const bundle = await makeBundle();
    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-sg', '--sub-graph-name', 'team', '--private', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    // Every lifecycle call must carry the sub-graph so data lands in cg/team SWM, not root.
    const lifecycleCalls = stub.calls.filter((c) =>
      c.method === 'POST' && callPath(c).startsWith('/api/knowledge-assets'),
    );
    expect(lifecycleCalls.length).toBeGreaterThan(0);
    for (const call of lifecycleCalls) expect(bodyOf(call).subGraphName).toBe('team');
    // The resumability manifest records the sub-graph (so a resume can't mix root/sub-graph).
    const manifest = await manifestFor(bundle);
    expect(manifest.subGraphName).toBe('team');
    expect(manifest.mode).toBe('per-concept');
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });
    expect(manifest.assetName).toBeUndefined();
  });

  it('--private ignores root manifest stages when importing a sub-graph target', async () => {
    clear();
    const bundle = await makeBundle();
    await writeFile(
      join(bundle, '.okf-import-manifest.json'),
      JSON.stringify(
        {
          contextGraphId: 'cg-sg-isolated',
          mode: 'per-concept',
          stages: { a: 'swm', b: 'swm' },
        },
        null,
        2,
      ),
    );

    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-sg-isolated', '--sub-graph-name', 'team', '--private', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    const createBodies = knowledgeAssetCreateBodies(stub.calls);
    expect(createBodies.map((b) => b.name).sort()).toEqual(['a', 'b']);
    expect(createBodies.every((b) => b.subGraphName === 'team')).toBe(true);
    const manifest = await manifestFor(bundle);
    expect(manifest.subGraphName).toBe('team');
    expect(manifest.stages).toEqual({ a: 'swm', b: 'swm' });
  });

  it('--private uses chunked lifecycle for concepts over the write chunk contract', async () => {
    clear();
    const bundle = await makeLargeTaggedBundle();

    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-large', '--private', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.assetsCreated).toBe(1);
    expect(out.assetsShared).toBe(1);

    const paths = callPaths(stub.calls);
    expect(paths.filter((p) => p === 'POST /api/knowledge-assets')).toHaveLength(1);
    const createBody = knowledgeAssetCreateBodies(stub.calls)[0];
    expect(createBody.quads).toBeUndefined();
    expect(paths.filter((p) => p === 'POST /api/knowledge-assets/bulk/wm/write')).toHaveLength(2);
    const writeLengths = knowledgeAssetWriteBodies(stub.calls, 'bulk')
      .map((b) => Array.isArray(b.quads) ? b.quads.length : 0);
    expect(writeLengths.every((length) => length <= 5000)).toBe(true);
    const totalWritten = writeLengths.reduce((sum, length) => sum + length, 0);
    expect(totalWritten).toBe(out.triplesWritten);
    expect(totalWritten).toBe(out.triples);
    expect(paths).toContain('POST /api/knowledge-assets/bulk/wm/finalize');
    expect(paths).toContain('POST /api/knowledge-assets/bulk/swm/share');
    expect(paths.some((p) => /private-bulk/.test(p))).toBe(false);
  });

  it('--private discards and replays a draft after a mid-concept write failure', async () => {
    clear();
    const bundle = await makeLargeTaggedBundle();
    const manifestPath = join(bundle, '.okf-import-manifest.json');
    const acceptedBeforeFailure: number[] = [];
    let writeAttempts = 0;
    stub.setHandler((req, raw) => {
      const url = new URL(`http://127.0.0.1${req.url}`);
      if (req.method === 'POST' && url.pathname === '/api/knowledge-assets/bulk/wm/write') {
        writeAttempts += 1;
        const quads = JSON.parse(raw || '{}').quads ?? [];
        if (writeAttempts === 2) {
          return { status: 500, body: { error: 'simulated write failure' } };
        }
        acceptedBeforeFailure.push(quads.length);
      }
      return okfDaemonHandler(createdCGs)(req, raw);
    });

    const failed = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-mid-write-fail', '--private', '--create-context-graph'],
      env(),
    );
    expect(failed.exitCode).not.toBe(0);
    expect(acceptedBeforeFailure).toEqual([5000]);
    expect(existsSync(manifestPath)).toBe(false);

    clear();
    stub.setHandler(okfDaemonHandler(createdCGs));
    const retried = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-mid-write-fail', '--private', '--create-context-graph'],
      env(),
    );
    expect(retried.exitCode).toBe(0);
    const out = parseJsonTail(retried.stdout);
    const paths = callPaths(stub.calls);
    const discardIndex = paths.indexOf('POST /api/knowledge-assets/bulk/wm/discard');
    const createIndex = paths.indexOf('POST /api/knowledge-assets');
    const firstWriteIndex = paths.indexOf('POST /api/knowledge-assets/bulk/wm/write');
    expect(discardIndex).toBeGreaterThanOrEqual(0);
    expect(discardIndex).toBeLessThan(createIndex);
    expect(createIndex).toBeLessThan(firstWriteIndex);
    const writeTotal = knowledgeAssetWriteBodies(stub.calls, 'bulk')
      .map((b) => Array.isArray(b.quads) ? b.quads.length : 0)
      .reduce((sum, length) => sum + length, 0);
    expect(writeTotal).toBe(out.triplesWritten);
    expect(writeTotal).toBe(out.triples);
    expect(paths).toContain('POST /api/knowledge-assets/bulk/wm/finalize');
    expect(paths).toContain('POST /api/knowledge-assets/bulk/swm/share');
    const manifest = await manifestFor(bundle);
    expect(manifest.stages).toEqual({ bulk: 'swm' });
  });

  it('--private recursively splits oversized lifecycle write chunks on 413', async () => {
    clear();
    const bundle = await makeLargeTaggedBundle();
    const acceptedWriteSizes: number[] = [];
    stub.setHandler((req, raw) => {
      const url = new URL(`http://127.0.0.1${req.url}`);
      if (req.method === 'POST' && url.pathname === '/api/knowledge-assets/bulk/wm/write') {
        const quads = JSON.parse(raw || '{}').quads ?? [];
        if (quads.length > 1000) {
          return { status: 413, body: { error: 'payload too large' } };
        }
        acceptedWriteSizes.push(quads.length);
      }
      return okfDaemonHandler(createdCGs)(req, raw);
    });

    const r = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-priv-write-split', '--private', '--create-context-graph'],
      env(),
    );
    expect(r.exitCode).toBe(0);
    const out = parseJsonTail(r.stdout);
    expect(out.assetsCreated).toBe(1);
    expect(out.assetsShared).toBe(1);

    const paths = callPaths(stub.calls);
    const writeLengths = knowledgeAssetWriteBodies(stub.calls, 'bulk')
      .map((b) => Array.isArray(b.quads) ? b.quads.length : 0);
    expect(writeLengths).toContain(5000);
    expect(writeLengths.some((length) => length > 1000)).toBe(true);
    expect(acceptedWriteSizes.length).toBeGreaterThan(2);
    expect(acceptedWriteSizes.every((length) => length <= 1000)).toBe(true);
    const acceptedTotal = acceptedWriteSizes.reduce((sum, length) => sum + length, 0);
    expect(acceptedTotal).toBe(out.triplesWritten);
    expect(acceptedTotal).toBe(out.triples);
    expect(paths).toContain('POST /api/knowledge-assets/bulk/wm/finalize');
    expect(paths).toContain('POST /api/knowledge-assets/bulk/swm/share');
    const manifest = await manifestFor(bundle);
    expect(manifest.stages).toEqual({ bulk: 'swm' });

    stub.setHandler(okfDaemonHandler(createdCGs));
  });

  it('refuses --private into an existing PUBLIC Context Graph; --allow-public-context-graph overrides', async () => {
    clear();
    const bundle = await makeBundle();
    const publicCgHandler: StubHandler = (req, raw) => {
      const url = new URL(`http://127.0.0.1${req.url}`);
      const path = url.pathname;
      if (req.method === 'GET' && path === '/api/context-graph/exists') {
        return { status: 200, body: { id: url.searchParams.get('id'), exists: true } };
      }
      if (req.method === 'GET' && path === '/api/context-graph/list') {
        return { status: 200, body: { contextGraphs: [{ id: 'cg-pub', accessPolicy: 'public' }] } };
      }
      return okfDaemonHandler(createdCGs)(req, raw); // everything else succeeds
    };
    stub.setHandler(publicCgHandler);

    // Refusal: non-zero exit, and NO knowledge-asset mutation happened.
    const refused = await runCli(['okf', 'import', bundle, '--context-graph-id', 'cg-pub', '--private'], env());
    expect(refused.exitCode).not.toBe(0);
    expect(stub.calls.some((c) => {
      const path = callPath(c);
      return c.method === 'POST' && (path === '/api/knowledge-assets' || path.startsWith('/api/knowledge-assets/'));
    })).toBe(false);
    expect(refused.stderr).toMatch(/Refusing --private/);

    // Override: --allow-public-context-graph proceeds and writes.
    const before = stub.calls.length;
    const allowed = await runCli(
      ['okf', 'import', bundle, '--context-graph-id', 'cg-pub', '--private', '--allow-public-context-graph'],
      env(),
    );
    expect(allowed.exitCode).toBe(0);
    const allowedCalls = stub.calls.slice(before);
    expect(knowledgeAssetCreateBodies(allowedCalls).map((b) => b.name).sort()).toEqual(['a', 'b']);
    expect(['a', 'b'].flatMap((name) => knowledgeAssetWriteBodies(allowedCalls, name))).toHaveLength(2);

    stub.setHandler(okfDaemonHandler(createdCGs));
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
