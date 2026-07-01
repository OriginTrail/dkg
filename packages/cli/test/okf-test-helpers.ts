import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
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

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'dist', 'cli.js');

export interface StubCall {
  method: string;
  url: string;
  authorization?: string;
  body: string;
}

export interface StubResult {
  status: number;
  body: unknown;
}

export type StubHandler = (req: IncomingMessage, body: string) => StubResult;

export interface WrittenQuad {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

export async function ensureOkfCliBuilt(): Promise<void> {
  if (!existsSync(CLI_ENTRY)) {
    await execFileAsync('pnpm', ['build'], { cwd: join(__dirname, '..') });
  }
}

export async function makeOkfCliHome(port: number): Promise<string> {
  const dkgHome = await mkdtemp(join(tmpdir(), 'dkg-okf-cli-'));
  await writeFile(
    join(dkgHome, 'config.json'),
    JSON.stringify({ name: 'okf-cli-stub', apiPort: port, listenPort: 0, nodeRole: 'edge', paranets: [] }),
  );
  await writeFile(join(dkgHome, 'auth.token'), 'stub-token\n', { mode: 0o600 });
  return dkgHome;
}

export function startStub(): Promise<{
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
export function okfDaemonHandler(createdCGs: Set<string>): StubHandler {
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

export async function runCli(
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
 * Import prints human progress lines before the final JSON summary, so parse
 * from the first `{` (none of the progress lines contain a brace).
 */
export function parseJsonTail(stdout: string): Record<string, unknown> {
  const i = stdout.indexOf('{');
  return JSON.parse(stdout.slice(i)) as Record<string, unknown>;
}

export function callPath(call: StubCall): string {
  return call.url.split('?')[0];
}

export function callPaths(calls: StubCall[]): string[] {
  return calls.map((c) => `${c.method} ${callPath(c)}`);
}

export function bodyOf(call: StubCall): Record<string, unknown> {
  return JSON.parse(call.body || '{}') as Record<string, unknown>;
}

export function knowledgeAssetCreateBodies(calls: StubCall[]): Record<string, unknown>[] {
  return calls
    .filter((c) => c.method === 'POST' && callPath(c) === '/api/knowledge-assets')
    .map(bodyOf);
}

export function knowledgeAssetWriteBodies(calls: StubCall[], name: string): Record<string, unknown>[] {
  return calls
    .filter((c) => c.method === 'POST' && callPath(c) === `/api/knowledge-assets/${name}/wm/write`)
    .map(bodyOf);
}

export function writtenQuadsFor(calls: StubCall[], name: string): WrittenQuad[] {
  return knowledgeAssetWriteBodies(calls, name)
    .flatMap((body) => Array.isArray(body.quads) ? body.quads as WrittenQuad[] : []);
}

export function subjectBelongsToOkfConcept(subject: string, conceptId: string): boolean {
  const root = `urn:okf:${conceptId}`;
  return subject === root || subject.startsWith(`${root}/`);
}

export async function manifestFor(bundle: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(bundle, '.okf-import-manifest.json'), 'utf-8')) as Record<string, unknown>;
}

/** A minimal conformant 2-concept OKF bundle in a fresh temp dir. */
export async function makeBundle(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'okf-bundle-'));
  await writeFile(join(dir, 'index.md'), '---\nokf_version: "0.1"\n---\n\n# Root\n');
  await writeFile(join(dir, 'a.md'), '---\ntype: Thing\ntitle: A\n---\n\n# Notes\n\nSee [b](b.md).\n');
  await writeFile(join(dir, 'b.md'), '---\ntype: Thing\ntitle: B\n---\n\nplain body\n');
  return dir;
}

export async function makeLargeTaggedBundle(tagCount = 5200): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'okf-large-bundle-'));
  const tags = Array.from({ length: tagCount }, (_, i) => `  - tag-${String(i).padStart(4, '0')}`)
    .join('\n');
  await writeFile(join(dir, 'index.md'), '---\nokf_version: "0.1"\n---\n\n# Root\n');
  await writeFile(join(dir, 'bulk.md'), `---\ntype: Thing\ntitle: Bulk\ntags:\n${tags}\n---\n\nplain body\n`);
  return dir;
}
