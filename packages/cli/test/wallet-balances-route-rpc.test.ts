// SPDX-License-Identifier: Apache-2.0

/**
 * `GET /api/wallets/balances` leaves no RPC work running once it answers.
 *
 * The route built a provider for every configured endpoint on every request,
 * with no static network, and never destroyed them. ethers retries network
 * discovery once a second for as long as a provider lives, so an endpoint that
 * never answered `eth_chainId` kept one retry loop per request running through
 * the daemon's shared request governor until the process exited.
 *
 * Pure: in-process route calls through the daemon's real route transport, over
 * one scripted JSON-RPC endpoint and one refused port. No daemon, no hardhat.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { ethers } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedChainConfig } from '../src/config.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { handleStatusRoutes } from '../src/daemon/routes/status.js';
import { createDaemonRpcRuntime, type DaemonRpcRuntime } from '../src/daemon/rpc-runtime.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

// Nothing listens here, so every request is refused, as one to a host with no DNS record fails.
const REFUSED_RPC = 'http://127.0.0.1:9';
const HUB = `0x${'ab'.repeat(20)}`;
const TOKEN = `0x${'cd'.repeat(20)}`;
const WALLETS = [`0x${'01'.repeat(20)}`, `0x${'02'.repeat(20)}`];
// Discovery retries once a second, so a provider left running asks at least twice in this window.
const QUIET_WINDOW_MS = 2_500;

const HUB_ABI = new ethers.Interface(['function getContractAddress(string) view returns (address)']);
const TOKEN_ABI = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
]);

interface ScriptedEndpoint {
  readonly server: Server;
  readonly url: string;
  /** Every JSON-RPC method the endpoint was asked, in order. */
  readonly methods: string[];
}

/** Chain 31337, a Hub that names TOKEN, and 1 ETH and 2 TRAC for every address. */
async function startScriptedEndpoint(): Promise<ScriptedEndpoint> {
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const request = JSON.parse(body) as { id: number; method: string; params: unknown[] };
    methods.push(request.method);
    let result: string | undefined;
    if (request.method === 'eth_chainId') result = '0x7a69';
    if (request.method === 'eth_blockNumber') result = '0x10';
    if (request.method === 'eth_getBalance') result = ethers.toQuantity(ethers.parseEther('1'));
    if (request.method === 'eth_call') {
      const { to, data } = request.params[0] as { to: string; data: string };
      if (to.toLowerCase() === HUB) {
        result = HUB_ABI.encodeFunctionResult('getContractAddress', [TOKEN]);
      } else if (TOKEN_ABI.parseTransaction({ data })?.name === 'symbol') {
        result = TOKEN_ABI.encodeFunctionResult('symbol', ['TRAC']);
      } else {
        result = TOKEN_ABI.encodeFunctionResult('balanceOf', [ethers.parseEther('2')]);
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result === undefined
      ? { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'method not found' } }
      : { jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, methods };
}

function chainConfig(chainId: string, rpcUrl: string): ResolvedChainConfig {
  return { type: 'evm', rpcUrl, rpcUrls: [REFUSED_RPC], hubAddress: HUB, chainId } as ResolvedChainConfig;
}

async function startBalancesServer(
  runtime: DaemonRpcRuntime,
  chain: ResolvedChainConfig,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    await handleStatusRoutes({
      req,
      res,
      url,
      path: url.pathname,
      routeRpcTransport: runtime.routeTransport,
      network: null,
      config: { name: 'wallet-balances-route-rpc-test', nodeRole: 'edge', chain },
      opWallets: { wallets: WALLETS.map((address) => ({ address })) },
      authentication: requestAuthentication({ kind: 'anonymous' }),
    } as unknown as RequestContext);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const EXPECTED_BALANCES = WALLETS.map((address) => ({ address, eth: '1.0', trac: '2.0', symbol: 'TRAC' }));

describe('GET /api/wallets/balances RPC lifetime', () => {
  const servers: Server[] = [];

  async function serve(chainId: string): Promise<{ endpoint: ScriptedEndpoint; runtime: DaemonRpcRuntime; baseUrl: string }> {
    const endpoint = await startScriptedEndpoint();
    servers.push(endpoint.server);
    const chain = chainConfig(chainId, endpoint.url);
    const runtime = createDaemonRpcRuntime(chain)!;
    const balances = await startBalancesServer(runtime, chain);
    servers.push(balances.server);
    return { endpoint, runtime, baseUrl: balances.baseUrl };
  }

  async function readBalances(baseUrl: string, times: number): Promise<void> {
    for (let call = 0; call < times; call += 1) {
      const response = await fetch(`${baseUrl}/api/wallets/balances`);
      const body = await response.json() as { balances: unknown; error?: string };
      expect(body.error).toBeUndefined();
      expect(body.balances).toEqual(EXPECTED_BALANCES);
    }
  }

  beforeEach(() => {
    // ethers reports every failed network discovery on the console.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it('uses the configured network, so no endpoint is asked for its chain id', async () => {
    const { endpoint, runtime, baseUrl } = await serve('evm:31337');
    await readBalances(baseUrl, 3);
    await sleep(QUIET_WINDOW_MS);

    expect(runtime.drainRouteRpcUsage().byMethod.eth_chainId ?? 0).toBe(0);
    expect(endpoint.methods).not.toContain('eth_chainId');
    expect(endpoint.methods).toContain('eth_getBalance');
  });

  it('destroys its providers once it answers, ending discovery that a refused endpoint never completes', async () => {
    // No numeric part, so the providers discover the network themselves.
    const { endpoint, runtime, baseUrl } = await serve('evm:local');
    await readBalances(baseUrl, 3);
    // The requests discovered the network; the refused endpoint was asked too, and failed.
    expect(endpoint.methods).toContain('eth_chainId');
    expect(runtime.drainRouteRpcUsage().byMethod.eth_chainId ?? 0).toBeGreaterThan(0);

    await sleep(QUIET_WINDOW_MS);
    expect(runtime.drainRouteRpcUsage().byMethod).toEqual({});
  });

  it('destroys them when the read throws as well', async () => {
    const { endpoint, runtime } = await serve('evm:local');
    await expect(runtime.routeTransport.withProvider(endpoint.url, [REFUSED_RPC], async (provider) => {
      await provider.getBlockNumber();
      throw new Error('read failed');
    })).rejects.toThrow('read failed');
    runtime.drainRouteRpcUsage();

    await sleep(QUIET_WINDOW_MS);
    expect(runtime.drainRouteRpcUsage().byMethod).toEqual({});
  });
});
