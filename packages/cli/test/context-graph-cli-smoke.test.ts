import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'dist', 'cli.js');

describe.sequential('context-graph CLI smoke', () => {
  let dkgHome: string;
  let server: ReturnType<typeof createServer>;
  let apiPort: string;
  let requests: Array<{ url: string | undefined; body: unknown }> = [];

  beforeAll(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-context-graph-cli-'));
    if (!existsSync(CLI_ENTRY)) {
      await execFileAsync('pnpm', ['build'], { cwd: join(__dirname, '..') });
    }
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`CLI entry not found after build: ${CLI_ENTRY}`);
    }

    server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/api/sub-graph/create') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      requests.push({ url: req.url, body });

      if (body.subGraphName === 'duplicate') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Sub-graph already exists' }));
        return;
      }

      if (body.subGraphName === 'bad/name') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid subGraphName: bad/name' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ created: body.subGraphName, contextGraphId: body.contextGraphId }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        apiPort = typeof addr === 'object' && addr ? String(addr.port) : '0';
        resolve();
      });
    });
  });

  beforeEach(() => {
    requests = [];
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('registers a sub-graph through the daemon route', async () => {
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: apiPort };

    const result = await execFileAsync('node', [
      CLI_ENTRY,
      'context-graph',
      'create-sub-graph',
      'research',
      'lab',
    ], { env });

    expect(result.stdout).toContain('Sub-graph registered:');
    expect(result.stdout).toContain('Context Graph: research');
    expect(result.stdout).toContain('Sub-graph:     lab');
    expect(requests).toEqual([{
      url: '/api/sub-graph/create',
      body: { contextGraphId: 'research', subGraphName: 'lab' },
    }]);
  });

  it('treats an already-registered sub-graph as success', async () => {
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: apiPort };

    const result = await execFileAsync('node', [
      CLI_ENTRY,
      'context-graph',
      'create-sub-graph',
      'research',
      'duplicate',
    ], { env });

    expect(result.stdout).toContain('Sub-graph "duplicate" already exists in context graph "research"');
    expect(result.stderr).toBe('');
  });

  it('exits non-zero for daemon validation errors other than already exists', async () => {
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: apiPort };

    await expect(execFileAsync('node', [
      CLI_ENTRY,
      'context-graph',
      'create-sub-graph',
      'research',
      'bad/name',
    ], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('Invalid subGraphName: bad/name'),
    });
  });
});
