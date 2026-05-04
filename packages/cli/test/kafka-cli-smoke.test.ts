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

interface CapturedRequest {
  url: string;
  body: string;
  authHeader: string;
}

describe.sequential('kafka CLI smoke', () => {
  let dkgHome: string;
  let server: ReturnType<typeof createServer>;
  let smokeApiPort: string;
  let last: CapturedRequest = { url: '', body: '', authHeader: '' };

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
      if (req.method === 'POST' && (req.url ?? '').startsWith('/api/kafka/endpoint')) {
        const authHeader = String(req.headers.authorization ?? '');
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks).toString('utf8');
        last = { url: req.url ?? '', body, authHeader };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          uri: 'urn:dkg:kafka-endpoint:0xabc:hash',
          contextGraphId: 'devnet-test',
          verificationStatus: 'unattempted',
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

  beforeEach(() => {
    last = { url: '', body: '', authHeader: '' };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('registers a Kafka endpoint through the CLI (no creds)', async () => {
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
    expect(last.authHeader).toBe('Bearer smoke-token');
    expect(last.url).toBe('/api/kafka/endpoint');
    expect(JSON.parse(last.body)).toEqual({
      contextGraphId: 'devnet-test',
      broker: 'kafka.example.com:9092',
      topic: 'orders.created',
      messageFormat: 'application/json',
    });
  }, 15000);

  it('passes --username/--password into the request body', async () => {
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: smokeApiPort };

    await execFileAsync('node', [
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
      '--security-protocol',
      'SASL_PLAINTEXT',
      '--username',
      'alice',
      '--password',
      'cli-secret-XYZ',
    ], { env });

    const body = JSON.parse(last.body);
    expect(body.securityProtocol).toBe('SASL_PLAINTEXT');
    expect(body.sasl).toEqual({ mechanism: 'plain', username: 'alice', password: 'cli-secret-XYZ' });
  }, 15000);

  it('reads --ca-pem-path and ships the contents in body.ssl.ca', async () => {
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: smokeApiPort };
    const caPath = join(dkgHome, 'ca-from-cli.pem');
    await writeFile(caPath, '-----BEGIN CERTIFICATE-----\nCLI-FILE-CA\n-----END CERTIFICATE-----');

    await execFileAsync('node', [
      CLI_ENTRY,
      'kafka',
      'endpoint',
      'register',
      '--cg',
      'devnet-test',
      '--broker',
      'kafka.example.com:9093',
      '--topic',
      'orders.created',
      '--security-protocol',
      'SASL_SSL',
      '--username',
      'alice',
      '--password',
      'pw',
      '--ca-pem-path',
      caPath,
    ], { env });

    const body = JSON.parse(last.body);
    expect(body.ssl.ca).toContain('CLI-FILE-CA');
  }, 15000);

  it('passes --force as a ?force=true query param', async () => {
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: smokeApiPort };

    await execFileAsync('node', [
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
      '--security-protocol',
      'PLAINTEXT',
      '--force',
    ], { env });

    expect(last.url).toBe('/api/kafka/endpoint?force=true');
    const body = JSON.parse(last.body);
    expect(body.force).toBeUndefined();
    expect(body.securityProtocol).toBe('PLAINTEXT');
  }, 15000);

  it('honors --sasl-mechanism scram-sha-256 in the request body', async () => {
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: smokeApiPort };

    await execFileAsync('node', [
      CLI_ENTRY,
      'kafka',
      'endpoint',
      'register',
      '--cg',
      'devnet-test',
      '--broker',
      'kafka.example.com:9093',
      '--topic',
      'orders.created',
      '--security-protocol',
      'SASL_SSL',
      '--username',
      'alice',
      '--password',
      'cli-secret-XYZ',
      '--sasl-mechanism',
      'scram-sha-256',
    ], { env });

    const body = JSON.parse(last.body);
    expect(body.sasl).toEqual({
      mechanism: 'scram-sha-256',
      username: 'alice',
      password: 'cli-secret-XYZ',
    });
  }, 15000);

  it('rejects an unknown --sasl-mechanism with a non-zero exit and a clear error', async () => {
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: smokeApiPort };

    let exited = false;
    let stderr = '';
    try {
      await execFileAsync('node', [
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
        '--security-protocol',
        'SASL_PLAINTEXT',
        '--username',
        'alice',
        '--password',
        'pw',
        '--sasl-mechanism',
        'gibberish',
      ], { env });
    } catch (err) {
      exited = true;
      stderr = String((err as { stderr?: string }).stderr ?? '');
    }

    expect(exited).toBe(true);
    expect(stderr).toContain('--sasl-mechanism');
    expect(stderr).toContain('plain');
    expect(stderr).toContain('scram-sha-256');
    expect(stderr).toContain('scram-sha-512');
  }, 15000);
});
