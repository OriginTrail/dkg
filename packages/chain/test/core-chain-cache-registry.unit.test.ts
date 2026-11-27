import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { ethers } from 'ethers';
import { createEvmCoreChainCacheRegistry } from '../src/evm-core-chain-cache.js';

const hub = '0x' + '1'.repeat(40), identity = '0x' + '2'.repeat(40), table = '0x' + '3'.repeat(40);
const abi = ethers.AbiCoder.defaultAbiCoder();
const selector = (name: string) => ethers.id(name).slice(0, 10);
it('rechecks operational keys and active registration on each proof and counts actual transport requests', async () => {
  let authorized = true, active = true, chainId = '0x64';
  const seen: Array<{ method: string; to?: string }> = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const r = JSON.parse(body), call = r.params[0]; seen.push({ method: r.method, to: call?.to });
    let result: string;
    if (r.method === 'eth_chainId') result = chainId;
    else if (call.data.startsWith(selector('getContractAddress(string)'))) {
      const [name] = abi.decode(['string'], '0x' + call.data.slice(10));
      result = abi.encode(['address'], [name === 'IdentityStorage' ? identity : table]);
    } else if (call.to.toLowerCase() === identity) result = abi.encode(['bool'], [authorized]);
    else result = abi.encode(['bool'], [active]);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const urls = [`http://127.0.0.1:${(server.address() as { port: number }).port}`];
  const config = { chainId: 'gnosis:100', hubAddress: hub, rpcUrls: urls, finalityConfirmations: 1 };
  const registry = createEvmCoreChainCacheRegistry(config);
  try {
    // Mutation of a caller-owned configuration cannot redirect the running authority reader.
    urls[0] = 'http://127.0.0.1:1'; config.hubAddress = ethers.ZeroAddress;
    const signer = ethers.Wallet.createRandom().address;
    expect(await registry.verifyACKIdentity(signer, 7n)).toBe(true);
    expect(registry.rpcUsage()).toEqual({ eth_chainId: 1, eth_call: 4 });
    expect(registry.drainRpcUsage!().byMethod).toEqual({ eth_chainId: 1, eth_call: 4 });
    expect(registry.drainRpcUsage!().byMethod).toEqual({});
    // Authentic-looking registration on the wrong chain cannot establish trust.
    const beforeWrongChain = seen.length;
    chainId = '0x1';
    await expect(registry.verifyACKIdentity(signer, 7n)).resolves.toBe(false);
    expect(seen.slice(beforeWrongChain)).toEqual([{ method: 'eth_chainId', to: undefined }]);
    chainId = '0x64';
    authorized = false;
    expect(await registry.verifyACKIdentity(signer, 7n)).toBe(false);
    authorized = true; active = false;
    expect(await registry.verifyACKIdentity(signer, 7n)).toBe(false);
    expect(seen.filter(r => r.to === hub)).toHaveLength(5);
    expect(Object.values(registry.rpcUsage()).reduce((a, b) => a + b, 0)).toBe(seen.length);
    const before = seen.length;
    await expect(registry.verifyACKIdentity(signer, 7n, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(seen.length).toBe(before);
  } finally { registry.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
