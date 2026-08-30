import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const PREFLIGHT = path.join(REPO_ROOT, 'scripts/testnet-publish-stress/preflight.mjs');

async function networkIdFrom(relativePath) {
  const contents = await readFile(path.join(REPO_ROOT, relativePath), 'utf8');
  return JSON.parse(contents).networkId;
}

async function runPreflight(networkId) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') {
      res.end(JSON.stringify({
        name: 'test',
        version: 'test',
        nodeRole: 'edge',
        networkName: 'testnet',
        networkId,
        identityId: 'test',
        hasIdentity: true,
        connectedPeers: 0,
      }));
      return;
    }

    // A valid testnet ID gets past the guard. Stop there so this test never
    // creates a context graph or performs any other write.
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'test stop' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'dkg-preflight-'));
  const tokenFile = path.join(tempDirectory, 'auth.token');
  await writeFile(tokenFile, 'test-token\n');

  try {
    const child = spawn(process.execPath, [PREFLIGHT], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DKG_HOST: `http://127.0.0.1:${address.port}`,
        DKG_TOKEN_FILE: tokenFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { exitCode, requests, stderr, stdout };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('publish-stress preflight follows the canonical testnet network ID', async () => {
  const canonicalTestnetId = await networkIdFrom('network/testnet.json');
  const result = await runPreflight(canonicalTestnetId);

  assert.equal(result.exitCode, 1, result.stderr);
  assert.deepEqual(result.requests, [
    'GET /api/status',
    'GET /api/wallets/balances',
  ]);
  assert.match(result.stderr, /wallets failed: HTTP 500/);
});

test('publish-stress preflight rejects mainnet before balances or writes', async () => {
  const mainnetId = await networkIdFrom('network/mainnet-base.json');
  const result = await runPreflight(mainnetId);

  assert.equal(result.exitCode, 2, result.stderr);
  assert.deepEqual(result.requests, ['GET /api/status']);
  assert.match(result.stderr, /Aborting\./);
});

test('publish-stress preflight rejects unrelated networks before balances or writes', async () => {
  const result = await runPreflight('unrelated-test-network');

  assert.equal(result.exitCode, 2, result.stderr);
  assert.deepEqual(result.requests, ['GET /api/status']);
  assert.match(result.stderr, /Aborting\./);
});
