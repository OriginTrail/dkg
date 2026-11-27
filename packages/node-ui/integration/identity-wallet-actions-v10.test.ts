/**
 * Browser identity-wallet actions against the deployed V10 contracts.
 *
 * This crosses the node-UI viem ABI/transaction boundary with a real admin
 * signer, waits for real receipts, and verifies IdentityStorage after every
 * add/remove operation. Unit mocks cannot catch ABI/address integration drift.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ADMIN_KEY_PURPOSE,
  OPERATIONAL_KEY_PURPOSE,
  identityStorageWalletAbi,
  identityWalletActionSubmitter,
  identityWalletKey,
  readIdentityWalletSummary,
  type IdentityWalletActionDeps,
} from '../src/ui/web3/identityWalletActions.js';
import type { IdentityWalletContracts } from '../src/ui/identity-wallet-api.js';
import type { Eip1193Provider } from '../src/ui/web3/eip6963.js';
import { EVMChainAdapter } from '../../chain/src/evm-adapter.js';
import { DKGAgent } from '../../agent/src/dkg-agent.js';
import { handleIdentityWalletRoutes } from '../../cli/src/daemon/routes/identity-wallets.js';
import type { RequestContext } from '../../cli/src/daemon/routes/context.js';
import {
  HARDHAT_KEYS,
  killHardhat,
  makeAdapterConfig,
  spawnHardhatEnv,
  type HardhatContext,
} from '../../chain/test/hardhat-harness.js';

let hardhat: HardhatContext;
let bridgeServer: Server | undefined;

async function closeBridgeServer(): Promise<void> {
  const server = bridgeServer;
  bridgeServer = undefined;
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

describe('V10 identity-wallet browser transaction integration', () => {
  beforeAll(async () => { hardhat = await spawnHardhatEnv(); }, 120_000);
  afterAll(async () => {
    await closeBridgeServer();
    await killHardhat(hardhat);
  });

  it('adds and removes operational and admin keys through real viem clients', async () => {
    const { rpcUrl, hubAddress, coreProfileId } = hardhat;
    const adapter = new EVMChainAdapter(makeAdapterConfig(rpcUrl, hubAddress, HARDHAT_KEYS.CORE_OP));
    const rpcSpy = vi.spyOn(adapter, 'requestBrowserWalletRpc');
    const agent = await DKGAgent.create({
      name: 'IdentityWalletBridgeIntegration',
      listenHost: '127.0.0.1',
      listenPort: 0,
      chainAdapter: adapter,
      nodeRole: 'core',
    });
    bridgeServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      void handleIdentityWalletRoutes({
        req,
        res,
        agent,
        path: url.pathname,
        url,
      } as unknown as RequestContext).catch(() => {
        // Never reflect exception details: they may contain stack traces or attacker-controlled HTML.
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Internal server error');
      });
    });
    await new Promise<void>((resolve, reject) => {
      bridgeServer!.once('error', reject);
      bridgeServer!.listen(0, '127.0.0.1', resolve);
    });
    const bridgeAddress = bridgeServer.address() as AddressInfo;
    const bridgeOrigin = `http://127.0.0.1:${bridgeAddress.port}`;
    const bootstrapResponse = await fetch(`${bridgeOrigin}/api/identity-wallets/contracts`);
    expect(bootstrapResponse.status).toBe(200);
    const bootstrapWire = await bootstrapResponse.json() as IdentityWalletContracts;
    expect(bootstrapWire.rpcUrls).toEqual(['/api/identity-wallets/rpc']);
    const bootstrap = {
      ...bootstrapWire,
      rpcUrls: bootstrapWire.rpcUrls.map((url) => new URL(url, bridgeOrigin).toString()),
    };
    const admin = privateKeyToAccount(HARDHAT_KEYS.CORE_ADMIN as Hex);
    const operationalTarget = privateKeyToAccount(HARDHAT_KEYS.EXTRA1 as Hex).address;
    const adminTarget = privateKeyToAccount(HARDHAT_KEYS.EXTRA2 as Hex).address;
    const chain = defineChain({
      id: 31337,
      name: 'hardhat',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    // Reads and receipt polling use the exact same-origin daemon bridge the UI
    // receives from bootstrap. Only hardware-wallet-signed writes remain direct.
    const publicClient = createPublicClient({ chain, transport: http(bootstrap.rpcUrls[0]) });
    const walletClient = createWalletClient({ account: admin, chain, transport: http(rpcUrl) });
    const provider: Eip1193Provider = {
      request: async ({ method, params }) => {
        if (method === 'eth_accounts') return [admin.address];
        if (method === 'eth_chainId') return '0x7a69';
        throw new Error(`Unexpected injected-provider request: ${method} ${JSON.stringify(params ?? [])}`);
      },
    };
    const deps: IdentityWalletActionDeps = {
      bootstrap,
      getWalletState: () => ({
        provider,
        address: admin.address,
        chainId: 31337,
        expectedChainId: 31337,
        bootstrap: null,
      }),
      publicClientFor: () => publicClient,
      walletClientFromProvider: () => walletClient,
    };
    const actions = identityWalletActionSubmitter(deps);
    const identityId = BigInt(coreProfileId);
    const keyHasPurpose = (address: Address, purpose: bigint) => publicClient.readContract({
      address: bootstrap.storage as Address,
      abi: identityStorageWalletAbi,
      functionName: 'keyHasPurpose',
      args: [identityId, identityWalletKey(address), purpose],
    });

    const initialSummary = await readIdentityWalletSummary(
      bootstrap,
      publicClient,
      identityId,
      [admin.address, operationalTarget, adminTarget],
    );
    expect(initialSummary.addresses).toEqual(expect.arrayContaining([
      expect.objectContaining({ address: admin.address, admin: true }),
      expect.objectContaining({ address: operationalTarget, operational: false }),
      expect.objectContaining({ address: adminTarget, admin: false }),
    ]));

    await expect(keyHasPurpose(operationalTarget, OPERATIONAL_KEY_PURPOSE)).resolves.toBe(false);
    const addedOperational = await actions.addOperational(identityId, operationalTarget);
    expect(addedOperational.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(addedOperational.blockNumber).toBeGreaterThan(0);
    await expect(keyHasPurpose(operationalTarget, OPERATIONAL_KEY_PURPOSE)).resolves.toBe(true);

    await expect(keyHasPurpose(adminTarget, ADMIN_KEY_PURPOSE)).resolves.toBe(false);
    const addedAdmin = await actions.addAdmin(identityId, adminTarget);
    expect(addedAdmin.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    await expect(keyHasPurpose(adminTarget, ADMIN_KEY_PURPOSE)).resolves.toBe(true);

    const removedOperational = await actions.removeOperational(
      identityId,
      operationalTarget,
      privateKeyToAccount(HARDHAT_KEYS.CORE_OP as Hex).address,
    );
    expect(removedOperational.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    await expect(keyHasPurpose(operationalTarget, OPERATIONAL_KEY_PURPOSE)).resolves.toBe(false);

    const removedAdmin = await actions.removeAdmin(identityId, adminTarget);
    expect(removedAdmin.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
    await expect(keyHasPurpose(adminTarget, ADMIN_KEY_PURPOSE)).resolves.toBe(false);

    expect(rpcSpy.mock.calls.some(([method]) => method === 'eth_call')).toBe(true);
    expect(rpcSpy.mock.calls.some(([method]) => method === 'eth_getTransactionReceipt')).toBe(true);
  });
});
