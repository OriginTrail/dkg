import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDevnetChain, resolveDevnetRpc } from './devnet-chain.mjs';

const HUB = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const GENESIS = `0x${'ab'.repeat(32)}`;
const OTHER_GENESIS = `0x${'cd'.repeat(32)}`;

function devnetDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'devnet-chain-test-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe('resolveDevnetRpc', () => {
  const recorded = devnetDir({
    'hardhat/rpc_url': 'http://127.0.0.1:8547\n',
    'node1/config.json': JSON.stringify({ chain: { rpcUrl: 'http://127.0.0.1:8600' } }),
  });
  const legacy = devnetDir({
    'node1/config.json': JSON.stringify({ chain: { rpcUrl: 'http://127.0.0.1:8600' } }),
  });
  afterAll(() => {
    rmSync(recorded, { recursive: true, force: true });
    rmSync(legacy, { recursive: true, force: true });
  });

  it('prefers DEVNET_RPC, then HARDHAT_PORT, then the recorded RPC, then node1, then 8545', () => {
    expect(resolveDevnetRpc({ DEVNET_RPC: 'http://127.0.0.1:9000', HARDHAT_PORT: '8547' }, recorded))
      .toBe('http://127.0.0.1:9000');
    expect(resolveDevnetRpc({ HARDHAT_PORT: '8548' }, recorded)).toBe('http://127.0.0.1:8548');
    expect(resolveDevnetRpc({}, recorded)).toBe('http://127.0.0.1:8547');
    expect(resolveDevnetRpc({}, legacy)).toBe('http://127.0.0.1:8600');
    expect(resolveDevnetRpc({}, join(legacy, 'missing'))).toBe('http://127.0.0.1:8545');
  });

  it('rejects a HARDHAT_PORT that is not a port number', () => {
    expect(() => resolveDevnetRpc({ HARDHAT_PORT: '8547/evil' }, recorded)).toThrow(/HARDHAT_PORT/);
  });
});

describe('assertDevnetChain', () => {
  let server: Server;
  let rpc: string;
  let chain = { chainId: '0x7a69', genesis: GENESIS, hubCode: '0x6080' };
  const dirs: string[] = [];
  const dir = (files: Record<string, string>) => {
    const d = devnetDir(files);
    dirs.push(d);
    return d;
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const { id, method } = JSON.parse(body) as { id: number; method: string };
        const result = method === 'eth_chainId' ? chain.chainId
          : method === 'eth_getBlockByNumber' ? { number: '0x0', hash: chain.genesis }
            : method === 'eth_getCode' ? chain.hubCode
              : null;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no server port');
    rpc = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('accepts the chain whose genesis this devnet recorded', async () => {
    chain = { chainId: '0x7a69', genesis: GENESIS, hubCode: '0x6080' };
    const d = dir({ 'hardhat/hub_address': HUB, 'hardhat/genesis_hash': GENESIS });
    await expect(assertDevnetChain(rpc, { devnetDir: d })).resolves.toEqual({
      rpc,
      hubAddress: HUB,
      genesisHash: GENESIS,
    });
  });

  it('refuses another devnet: same chain id and Hub code, different genesis', async () => {
    chain = { chainId: '0x7a69', genesis: OTHER_GENESIS, hubCode: '0x6080' };
    const d = dir({ 'hardhat/hub_address': HUB, 'hardhat/genesis_hash': GENESIS });
    await expect(assertDevnetChain(rpc, { devnetDir: d })).rejects.toThrow(/not the one .* deployed/);
  });

  it('refuses a chain that is not the Hardhat devnet chain', async () => {
    chain = { chainId: '0x14a34', genesis: GENESIS, hubCode: '0x6080' };
    const d = dir({ 'hardhat/hub_address': HUB, 'hardhat/genesis_hash': GENESIS });
    await expect(assertDevnetChain(rpc, { devnetDir: d })).rejects.toThrow(/chain 84532/);
  });

  it('refuses when the devnet recorded no genesis to compare against', async () => {
    chain = { chainId: '0x7a69', genesis: GENESIS, hubCode: '0x6080' };
    const d = dir({ 'hardhat/hub_address': HUB });
    await expect(assertDevnetChain(rpc, { devnetDir: d })).rejects.toThrow(/genesis_hash is missing/);
  });

  it('refuses a matching genesis with no Hub deployed', async () => {
    chain = { chainId: '0x7a69', genesis: GENESIS, hubCode: '0x' };
    const d = dir({ 'hardhat/hub_address': HUB, 'hardhat/genesis_hash': GENESIS });
    await expect(assertDevnetChain(rpc, { devnetDir: d })).rejects.toThrow(/no Hub contract/);
  });
});
