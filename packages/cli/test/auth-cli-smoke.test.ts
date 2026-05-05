/**
 * Slice 06 — CLI smoke tests for `dkg auth mint-token / list-tokens / revoke-token`.
 *
 * Stands up a real CLI subprocess (`node dist/cli.js`) against a stub
 * HTTP server impersonating the daemon. Mirrors the approach in
 * `kafka-cli-smoke.test.ts` so the auth-token flows are exercised
 * end-to-end through commander.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'dist', 'cli.js');

interface CapturedRequest {
  url: string;
  body: string;
  authHeader: string;
  method: string;
}
interface NextResponse {
  status: number;
  body?: unknown;
}

describe.sequential('auth CLI smoke', () => {
  let dkgHome: string;
  let server: ReturnType<typeof createServer>;
  let port: string;
  let last: CapturedRequest = { url: '', body: '', authHeader: '', method: '' };
  let mintResponse: NextResponse | null = null;
  let listResponse: NextResponse | null = null;
  let revokeResponse: NextResponse | null = null;

  beforeAll(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-auth-cli-'));
    if (!existsSync(CLI_ENTRY)) {
      await execFileAsync('pnpm', ['build'], { cwd: join(__dirname, '..') });
    }
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`CLI entry not found after build: ${CLI_ENTRY}`);
    }

    await writeFile(join(dkgHome, 'auth.token'), 'smoke-root-token\n');

    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString('utf8');
      last = {
        url: req.url ?? '',
        body,
        authHeader: String(req.headers.authorization ?? ''),
        method: req.method ?? '',
      };

      if (req.method === 'POST' && req.url === '/api/auth/tokens' && mintResponse) {
        const r = mintResponse;
        mintResponse = null;
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.body ?? {}));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/auth/tokens' && listResponse) {
        const r = listResponse;
        listResponse = null;
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.body ?? {}));
        return;
      }
      if (req.method === 'DELETE' && req.url?.startsWith('/api/auth/tokens/') && revokeResponse) {
        const r = revokeResponse;
        revokeResponse = null;
        if (r.status === 204) {
          res.writeHead(204);
          res.end();
        } else {
          res.writeHead(r.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(r.body ?? {}));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? String(addr.port) : '0';
        resolve();
      });
    });
  }, 90_000);

  beforeEach(() => {
    last = { url: '', body: '', authHeader: '', method: '' };
    mintResponse = null;
    listResponse = null;
    revokeResponse = null;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('dkg auth mint-token --scope kafka:endpoint:write prints the full token once', async () => {
    mintResponse = {
      status: 201,
      body: {
        token: 'minted-secret-XYZ',
        prefix: 'minted-s',
        scopes: ['kafka:endpoint:write'],
        name: 'producer-bot',
        createdAt: '2026-05-04T13:00:00.000Z',
      },
    };
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: port };
    const result = await execFileAsync('node', [
      CLI_ENTRY,
      'auth',
      'mint-token',
      '--scope',
      'kafka:endpoint:write',
      '--name',
      'producer-bot',
    ], { env });

    expect(last.method).toBe('POST');
    expect(last.url).toBe('/api/auth/tokens');
    expect(last.authHeader).toBe('Bearer smoke-root-token');
    expect(JSON.parse(last.body)).toEqual({
      scope: 'kafka:endpoint:write',
      name: 'producer-bot',
    });
    expect(result.stdout).toContain('minted-secret-XYZ');
    expect(result.stdout).toContain('Save this token now');
    expect(result.stdout).toContain('Prefix:');
    expect(result.stdout).toContain('producer-bot');
  }, 30_000);

  it('dkg auth mint-token without --scope exits with error (commander required-option)', async () => {
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: port };
    let exited = false;
    let stderr = '';
    try {
      await execFileAsync('node', [CLI_ENTRY, 'auth', 'mint-token'], { env });
    } catch (err) {
      exited = true;
      stderr = String((err as { stderr?: string }).stderr ?? '');
    }
    expect(exited).toBe(true);
    expect(stderr).toMatch(/required option.*--scope/i);
  }, 30_000);

  it('dkg auth list-tokens prints prefix-only rows', async () => {
    listResponse = {
      status: 200,
      body: {
        tokens: [
          { prefix: 'rootabcd', scopes: '*' },
          {
            prefix: 'reader01',
            scopes: ['kafka:endpoint:read'],
            name: 'catchup',
            createdAt: '2026-05-04T13:00:00.000Z',
          },
        ],
      },
    };
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: port };
    const result = await execFileAsync('node', [CLI_ENTRY, 'auth', 'list-tokens'], { env });
    expect(last.method).toBe('GET');
    expect(last.url).toBe('/api/auth/tokens');
    expect(result.stdout).toContain('PREFIX');
    expect(result.stdout).toContain('rootabcd');
    expect(result.stdout).toContain('reader01');
    expect(result.stdout).toContain('kafka:endpoint:read');
    expect(result.stdout).toContain('catchup');
  }, 30_000);

  it('dkg auth list-tokens shows "No tokens" on empty list', async () => {
    listResponse = { status: 200, body: { tokens: [] } };
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: port };
    const result = await execFileAsync('node', [CLI_ENTRY, 'auth', 'list-tokens'], { env });
    expect(result.stdout).toContain('No tokens configured');
  }, 30_000);

  it('dkg auth revoke-token <prefix> on hit prints success', async () => {
    revokeResponse = { status: 204 };
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: port };
    const result = await execFileAsync('node', [
      CLI_ENTRY, 'auth', 'revoke-token', 'reader01',
    ], { env });
    expect(last.method).toBe('DELETE');
    expect(last.url).toBe('/api/auth/tokens/reader01');
    expect(result.stdout).toContain('reader01 revoked');
  }, 30_000);

  it('dkg auth revoke-token <prefix> on miss exits 1 with helpful message', async () => {
    revokeResponse = { status: 404, body: { error: 'No token with prefix "missing0"' } };
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: port };
    let exited = false;
    let stderr = '';
    try {
      await execFileAsync('node', [
        CLI_ENTRY, 'auth', 'revoke-token', 'missing0',
      ], { env });
    } catch (err) {
      exited = true;
      stderr = String((err as { stderr?: string }).stderr ?? '');
    }
    expect(exited).toBe(true);
    expect(stderr).toContain('missing0');
  }, 30_000);

  it('dkg auth mint-token surfaces 403 with a clear "root token required" message', async () => {
    mintResponse = {
      status: 403,
      body: { error: 'Root token required for token administration' },
    };
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: port };
    let exited = false;
    let stderr = '';
    try {
      await execFileAsync('node', [
        CLI_ENTRY, 'auth', 'mint-token', '--scope', 'kafka:endpoint:read',
      ], { env });
    } catch (err) {
      exited = true;
      stderr = String((err as { stderr?: string }).stderr ?? '');
    }
    expect(exited).toBe(true);
    expect(stderr).toMatch(/root token/i);
  }, 30_000);
});
