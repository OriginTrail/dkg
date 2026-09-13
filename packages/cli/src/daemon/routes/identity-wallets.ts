import { ethers } from 'ethers';
import type { IdentityWalletContracts } from '@origintrail-official/dkg-chain';
import {
  IDENTITY_STORAGE_WALLET_ABI,
  identityWalletFunctionSignature,
} from '@origintrail-official/dkg-core';
import {
  classifyChainRpcTransportStatus,
  jsonResponse,
  readBody,
  sanitizeRpcMessage,
  SMALL_BODY_BYTES,
} from '../http-utils.js';
import type { RequestContext } from './context.js';
import {
  executeRestrictedBrowserWalletRpcBody,
  type RestrictedEthCall,
} from './restricted-browser-wallet-rpc.js';

const RPC_PATH = '/api/identity-wallets/rpc';
const IDENTITY_STORAGE_SELECTORS = new Set(IDENTITY_STORAGE_WALLET_ABI.map((fragment) =>
  ethers.id(identityWalletFunctionSignature(fragment)).slice(0, 10),
));
const FEATURE_UNAVAILABLE = {
  error: 'Identity wallet management is not available on this deployment',
  code: 'IDENTITY_WALLET_MANAGEMENT_UNAVAILABLE',
};

function ethCallError(
  call: RestrictedEthCall,
  contracts: IdentityWalletContracts,
): string | null {
  const keys = Object.keys(call.transaction);
  if (keys.some((key) => !['to', 'data'].includes(key))) {
    return 'Identity wallet RPC eth_call accepts only to and data';
  }
  try {
    if (ethers.getAddress(call.to).toLowerCase() !== ethers.getAddress(contracts.storage).toLowerCase()) {
      return 'Identity wallet RPC eth_call target or selector is not allowed';
    }
  } catch {
    return 'Identity wallet RPC eth_call target address is invalid';
  }
  return IDENTITY_STORAGE_SELECTORS.has(call.data.slice(0, 10).toLowerCase())
    ? null
    : 'Identity wallet RPC eth_call target or selector is not allowed';
}

function walletRpcUrls(contracts: IdentityWalletContracts): string[] {
  return (contracts.walletRpcUrls ?? []).filter((url) => /^https?:\/\//i.test(url));
}

async function handleRpcBody(agent: RequestContext['agent'], body: string) {
  return executeRestrictedBrowserWalletRpcBody(body, {
    unavailableMessage: FEATURE_UNAVAILABLE.error,
    methodErrorPrefix: 'Identity wallet RPC',
    authorizeEthCall: async (call) => {
      const contracts = await agent.getIdentityWalletContracts();
      return contracts === null
        ? { available: false }
        : { available: true, error: ethCallError(call, contracts) };
    },
    request: (method, params) => agent.requestBrowserWalletRpc(method, params),
    readErrorPrefix: 'Identity wallet RPC read failed',
  });
}

export async function handleIdentityWalletRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path } = ctx;
  if (!path.startsWith('/api/identity-wallets')) return;

  if (!agent.supportsIdentityWalletManagement) {
    return jsonResponse(res, 503, FEATURE_UNAVAILABLE);
  }

  if (req.method === 'GET' && path === '/api/identity-wallets/contracts') {
    try {
      const contracts = await agent.getIdentityWalletContracts();
      if (contracts === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE);
      return jsonResponse(res, 200, {
        ...contracts,
        rpcUrls: [RPC_PATH],
        walletRpcUrls: walletRpcUrls(contracts),
      });
    } catch (error) {
      const transport = classifyChainRpcTransportStatus(error);
      if (transport) return jsonResponse(res, transport.status, transport.body);
      return jsonResponse(res, 500, {
        error: `getIdentityWalletContracts failed: ${sanitizeRpcMessage(
          error instanceof Error ? error.message : String(error),
        )}`,
      });
    }
  }

  if (req.method === 'POST' && path === RPC_PATH) {
    const result = await handleRpcBody(agent, await readBody(req, SMALL_BODY_BYTES));
    return jsonResponse(res, result.status, result.body);
  }

  return jsonResponse(res, 404, { error: 'Identity wallet route not found' });
}
