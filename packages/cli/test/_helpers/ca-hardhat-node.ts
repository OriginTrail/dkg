/**
 * Conviction Account service spending (OT-RFC-27) on the shared Hardhat node,
 * for the tests that drive it end to end: one node's /api/ca routes, served on
 * a loopback port as the daemon dispatches them, by a DKGAgent over a real EVM
 * adapter; and the chain's schedule cut-over, which the local deployment
 * leaves unset.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ethers, Wallet } from 'ethers';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import type { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import { handleCaRoutes } from '../../src/daemon/routes/ca.js';
import { jsonResponse } from '../../src/daemon/http-utils.js';
import type { RequestContext } from '../../src/daemon/routes/context.js';
import { ApiClient } from '../../src/api-client.js';
import { requestAuthentication } from './request-authentication.js';
import { createProvider, getSharedContext, HARDHAT_KEYS } from '../../../chain/test/evm-test-context.js';

export interface CaNode {
  agent: DKGAgent;
  chain: EVMChainAdapter;
  client: ApiClient;
  server: Server;
  /** The loopback port of its /api/ca routes. */
  port: number;
}

/** Serve one node's /api/ca routes on a loopback port; `primaryWallet` is its primary operational wallet. */
export async function serveCaNode(name: string, chain: EVMChainAdapter, primaryWallet: string): Promise<CaNode> {
  const agent = await DKGAgent.create({
    name, listenHost: '127.0.0.1', listenPort: 0, nodeRole: 'edge', chainAdapter: chain,
    rfc64CatalogActivation: { enabled: false }, syncOnConnectEnabled: false,
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const ctx = {
      req, res, agent, url, path: url.pathname,
      authentication: requestAuthentication({ kind: 'anonymous', mode: 'disabled' }),
      opWallets: { wallets: [{ address: primaryWallet }] },
    } as unknown as RequestContext;
    handleCaRoutes(ctx)
      .then(() => { if (!res.writableEnded) jsonResponse(res, 404, { error: 'Not found' }); })
      .catch((err: unknown) => jsonResponse(res, 500, { error: String(err) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { agent, chain, server, port, client: new ApiClient(`http://127.0.0.1:${port}`) };
}

export async function stopCaNode(node: CaNode): Promise<void> {
  await new Promise<void>((resolve) => node.server.close(() => resolve()));
  await node.agent.stop().catch(() => {});
  node.chain.destroy();
}

/**
 * Set the schedule cut-over through the Hub (Hub.forwardCall), at the chain's
 * time, unless it is set: service spending refuses to switch on without it,
 * and only accounts created after it have an exact schedule. Answers the
 * chain's time.
 */
export async function ensureExactScheduleFrom(): Promise<number> {
  const provider = createProvider();
  const { hubAddress } = getSharedContext();
  const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, provider);
  const hub = new ethers.Contract(hubAddress, [
    'function getContractAddress(string) view returns (address)',
    'function forwardCall(address target, bytes data) returns (bytes)',
  ], deployer);
  const cssAddress = await hub.getContractAddress('ConvictionServiceStorage');
  const css = new ethers.Contract(cssAddress, [
    'function exactScheduleFrom() view returns (uint40)',
    'function setExactScheduleFrom(uint40 timestamp)',
  ], provider);
  const chainNow = (await provider.getBlock('latest'))!.timestamp;
  if (BigInt(await css.exactScheduleFrom()) === 0n) {
    await (await hub.forwardCall(cssAddress, css.interface.encodeFunctionData('setExactScheduleFrom', [chainNow]))).wait();
  }
  if (BigInt(await css.exactScheduleFrom()) === 0n) throw new Error('exactScheduleFrom is still unset');
  return chainNow;
}
