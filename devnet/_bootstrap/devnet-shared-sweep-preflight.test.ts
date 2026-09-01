import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const DEVNET = resolve(import.meta.dirname, '..');
const ROOT = resolve(DEVNET, '..');
const manifest = JSON.parse(readFileSync(resolve(DEVNET, 'suites.json'), 'utf8')) as {
  sharedSweep: {
    nodeCount: number;
    publisherWalletIndex: number;
  };
};
const SWEEP_PREFLIGHT = resolve(ROOT, 'scripts/devnet-shared-sweep-preflight.mjs');
const fixtureDirs: string[] = [];
const fixtureServers: ChildProcess[] = [];

function wallet(nodeNumber: number, walletIndex: number) {
  const value = nodeNumber * 10 + walletIndex + 1;
  return {
    address: `0x${value.toString(16).padStart(40, '0')}`,
    privateKey: `0x${value.toString(16).padStart(64, '0')}`,
  };
}

function createSharedSweepFixture(
  selectedWalletIndex: number,
  options: { extraNodes?: number[]; apiPortBase?: number } = {},
): string {
  const root = mkdtempSync(resolve(tmpdir(), 'dkg-shared-sweep-'));
  fixtureDirs.push(root);
  const nodeNumbers = [
    ...Array.from({ length: manifest.sharedSweep.nodeCount }, (_, index) => index + 1),
    ...(options.extraNodes ?? []),
  ];
  for (const nodeNumber of nodeNumbers) {
    const nodeDir = resolve(root, `node${nodeNumber}`);
    const wallets = [0, 1, 2].map((index) => wallet(nodeNumber, index));
    mkdirSync(nodeDir, { recursive: true });
    writeFileSync(
      resolve(nodeDir, 'config.json'),
      JSON.stringify({
        publisher: { enabled: true },
        ...(options.apiPortBase !== undefined
          ? { apiPort: options.apiPortBase + nodeNumber - 1 }
          : {}),
      }),
    );
    writeFileSync(resolve(nodeDir, 'wallets.json'), JSON.stringify({ wallets }));
    writeFileSync(
      resolve(nodeDir, 'publisher-wallets.json'),
      JSON.stringify({ wallets: [wallets[selectedWalletIndex]] }),
    );
  }
  return root;
}

async function startStatusServer(status: Record<string, unknown>): Promise<number> {
  const encodedStatus = Buffer.from(JSON.stringify(status)).toString('base64');
  const serverSource = `
    const http = require('node:http');
    const body = Buffer.from(process.argv[1], 'base64');
    const server = http.createServer((request, response) => {
      if (request.url !== '/api/status') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `;
  const child = spawn(process.execPath, ['-e', serverSource, encodedStatus], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fixtureServers.push(child);
  return new Promise((resolvePort, reject) => {
    const timeout = setTimeout(() => reject(new Error('fixture status server did not start')), 5_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`fixture status server exited before listening (code ${code})`));
    });
    child.stdout?.once('data', (chunk) => {
      clearTimeout(timeout);
      resolvePort(Number(String(chunk).trim()));
    });
  });
}

function runSharedSweepPreflight(devnetDir: string) {
  return spawnSync(process.execPath, [SWEEP_PREFLIGHT], {
    encoding: 'utf8',
    env: { ...process.env, DEVNET_DIR: devnetDir },
  });
}

afterEach(() => {
  for (const child of fixtureServers.splice(0)) child.kill();
  for (const path of fixtureDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('shared devnet sweep topology preflight', () => {
  it('accepts the manifest-declared publisher topology', () => {
    const result = runSharedSweepPreflight(
      createSharedSweepFixture(manifest.sharedSweep.publisherWalletIndex),
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('6 nodes, publisher wallet index 1');
  });

  it('rejects the ordinary wallet-0 publisher topology with exact recovery', () => {
    const result = runSharedSweepPreflight(createSharedSweepFixture(0));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'node1 publisher wallet does not match operational wallet index 1',
    );
    expect(result.stderr).toContain(
      'DEVNET_ENABLE_PUBLISHER=1 DEVNET_PUBLISHER_WALLET_INDEX=1 ./scripts/devnet.sh start 6',
    );
  });

  it('rejects a configured node7 beyond the six-node shared-sweep manifest', () => {
    const result = runSharedSweepPreflight(createSharedSweepFixture(
      manifest.sharedSweep.publisherWalletIndex,
      { extraNodes: [7] },
    ));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('extra configured devnet node directories found: node7');
    expect(result.stderr).toContain('sharedSweep.nodeCount=6 requires exactly node1-node6');
    expect(result.stderr).toContain('./scripts/devnet.sh clean');
  });

  it('rejects an active node7 API without a remaining node7 directory', async () => {
    const node7Port = await startStatusServer({
      name: 'devnet-node-7',
      peerId: '12D3KooWDevnetNode7',
      nodeRole: 'edge',
    });
    const apiPortBase = node7Port - manifest.sharedSweep.nodeCount;
    const result = runSharedSweepPreflight(createSharedSweepFixture(
      manifest.sharedSweep.publisherWalletIndex,
      { apiPortBase },
    ));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`extra active devnet APIs found: node7 (API :${node7Port})`);
    expect(result.stderr).toContain('stop stray nodes');
    expect(result.stderr).toContain('./scripts/devnet.sh clean');
  });

  it('ignores an unrelated service on the port where node7 would normally listen', async () => {
    const unrelatedPort = await startStatusServer({ name: 'unrelated-service', status: 'ok' });
    const apiPortBase = unrelatedPort - manifest.sharedSweep.nodeCount;
    const result = runSharedSweepPreflight(createSharedSweepFixture(
      manifest.sharedSweep.publisherWalletIndex,
      { apiPortBase },
    ));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('6 nodes, publisher wallet index 1');
  });
});
