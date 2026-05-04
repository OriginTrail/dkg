import { beforeAll, afterAll, describe, expect, it } from 'vitest';
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
  // Track what privacy flag the server should echo back in its response
  let serverPrivate = true;

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
        const requestedPrivate = (JSON.parse(lastBody) as Record<string, unknown>).private;
        // Mirror what the real route does: omitted → private, false → public
        serverPrivate = requestedPrivate !== false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          uri: 'urn:dkg:kafka-endpoint:0xabc:hash',
          contextGraphId: 'devnet-test',
          private: serverPrivate,
        }));
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

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('registers a Kafka endpoint (default: private) through the CLI', async () => {
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
    // Default (no --public flag) → private: true displayed in stdout
    expect(result.stdout).toContain('Private:        true');
    expect(lastAuthHeader).toBe('Bearer smoke-token');

    // No --public flag: `private` field is OMITTED from the request body
    // (route defaults to private when the field is absent).
    const parsedBody = JSON.parse(lastBody) as Record<string, unknown>;
    expect(parsedBody).toEqual({
      contextGraphId: 'devnet-test',
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
      messageFormat: 'application/json',
    });
    expect(parsedBody).not.toHaveProperty('private');
  }, 15000);

  it('registers a public Kafka endpoint when --public flag is provided', async () => {
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
      'public-orders',
      '--public',
    ], { env });

    expect(result.stdout).toContain('Kafka endpoint registered:');
    // --public flag → private: false displayed in stdout
    expect(result.stdout).toContain('Private:        false');
    expect(lastAuthHeader).toBe('Bearer smoke-token');

    // --public flag: `private: false` sent in request body
    const parsedBody = JSON.parse(lastBody) as Record<string, unknown>;
    expect(parsedBody.private).toBe(false);
    expect(parsedBody.contextGraphId).toBe('devnet-test');
    expect(parsedBody.broker).toBe('kafka.example.com:9092');
    expect(parsedBody.topic).toBe('public-orders');
  }, 15000);
});
