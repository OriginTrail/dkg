import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'dist', 'cli.js');

describe.sequential('kafka CLI smoke', () => {
  let dkgHome: string;
  let server: ReturnType<typeof createServer>;
  let smokeApiPort: string;
  let lastBody = '';
  let lastAuthHeader = '';
  let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

  beforeAll(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-kafka-cli-'));
    if (!existsSync(CLI_ENTRY)) {
      await execFileAsync('pnpm', ['build'], { cwd: join(__dirname, '..') });
    }
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`CLI entry not found after build: ${CLI_ENTRY}`);
    }

    await writeFile(join(dkgHome, 'auth.token'), 'smoke-token\n');

    server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/api/kafka/endpoint') {
        lastAuthHeader = String(req.headers.authorization ?? '');
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        lastBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(nextResponse.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(nextResponse.body));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        smokeApiPort = typeof addr === 'object' && addr ? String(addr.port) : '0';
        resolve();
      });
    });
  });

  beforeEach(() => {
    lastBody = '';
    lastAuthHeader = '';
    nextResponse = {
      status: 200,
      body: {
        uri: 'urn:dkg:kafka-endpoint:0xabc:hash',
        contextGraphId: 'devnet-test',
        cgScope: 'shared',
      },
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('registers a Kafka endpoint through the CLI with --cg', async () => {
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: smokeApiPort };

    const result = await execFileAsync('node', [
      CLI_ENTRY,
      'kafka',
      'endpoint',
      'register',
      '--cg',
      'devnet-test',
      '--broker',
      'kafka.example.com:9092',
      '--topic',
      'orders.created',
    ], { env });

    expect(result.stdout).toContain('Kafka endpoint registered:');
    expect(result.stdout).toContain('urn:dkg:kafka-endpoint:0xabc:hash');
    expect(result.stdout).toContain('devnet-test');
    expect(result.stdout).toContain('CG scope:       shared');
    expect(lastAuthHeader).toBe('Bearer smoke-token');
    expect(JSON.parse(lastBody)).toEqual({
      contextGraphId: 'devnet-test',
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
      messageFormat: 'application/json',
    });
  }, 15000);

  it('registers a Kafka endpoint through the CLI with --local', async () => {
    // The daemon scopes the kafka-local CG id per-node as
    // `kafka-local-{peerId}`. The smoke test mocks the daemon, so we choose
    // a realistic prefixed value here and assert the CLI prints it back.
    const stubPeerId = '12D3KooWStubPeerIdForSmokeTest';
    const stubLocalId = `kafka-local-${stubPeerId}`;
    nextResponse = {
      status: 200,
      body: {
        uri: 'urn:dkg:kafka-endpoint:0xabc:hash',
        contextGraphId: stubLocalId,
        cgScope: 'local',
      },
    };
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: smokeApiPort };

    const result = await execFileAsync('node', [
      CLI_ENTRY,
      'kafka',
      'endpoint',
      'register',
      '--local',
      '--broker',
      'kafka.example.com:9092',
      '--topic',
      'orders.created',
    ], { env });

    expect(result.stdout).toContain('Kafka endpoint registered:');
    expect(result.stdout).toContain('urn:dkg:kafka-endpoint:0xabc:hash');
    expect(result.stdout).toContain(stubLocalId);
    expect(result.stdout).toContain('CG scope:       local');
    expect(JSON.parse(lastBody)).toEqual({
      useLocalCg: true,
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
      messageFormat: 'application/json',
    });
  }, 15000);

  it('rejects --cg and --local together at the parser level (no network call)', async () => {
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: smokeApiPort };
    lastBody = '__no_request__';

    await expect(
      execFileAsync('node', [
        CLI_ENTRY,
        'kafka',
        'endpoint',
        'register',
        '--cg',
        'devnet-test',
        '--local',
        '--broker',
        'kafka.example.com:9092',
        '--topic',
        'orders.created',
      ], { env }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/--cg.*--local|--local.*--cg/i),
    });

    expect(lastBody).toBe('__no_request__');
  }, 15000);

  it('rejects neither --cg nor --local at the action level (no network call)', async () => {
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: smokeApiPort };
    lastBody = '__no_request__';

    await expect(
      execFileAsync('node', [
        CLI_ENTRY,
        'kafka',
        'endpoint',
        'register',
        '--broker',
        'kafka.example.com:9092',
        '--topic',
        'orders.created',
      ], { env }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/--cg.*--local|--local.*--cg/),
    });

    expect(lastBody).toBe('__no_request__');
  }, 15000);
});
