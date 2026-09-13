import { ethers } from 'ethers';
import type {
  BrowserWalletRpcMethod,
  IdentityWalletContracts,
} from '@origintrail-official/dkg-chain';
import {
  classifyChainRpcTransportStatus,
  jsonResponse,
  readBody,
  sanitizeRpcMessage,
  SMALL_BODY_BYTES,
} from '../http-utils.js';
import type { RequestContext } from './context.js';
import { executeRestrictedBrowserWalletRpc } from './restricted-browser-wallet-rpc.js';

const RPC_PATH = '/api/identity-wallets/rpc';
const MAX_BATCH = 20;
const ALLOWED_METHODS = new Set<BrowserWalletRpcMethod>([
  'eth_chainId',
  'eth_call',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_blockNumber',
  'eth_getBlockByNumber',
]);
const NULL_RESULT_METHODS = new Set<BrowserWalletRpcMethod>([
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getBlockByNumber',
]);
const IDENTITY_STORAGE_SELECTORS = new Set([
  ethers.id('keyHasPurpose(uint72,bytes32,uint256)').slice(0, 10),
  ethers.id('getKeysByPurpose(uint72,uint256)').slice(0, 10),
]);
const FEATURE_UNAVAILABLE = {
  error: 'Identity wallet management is not available on this deployment',
};

function parseJson(body: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (error) {
    return {
      ok: false,
      error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function isHash(value: unknown): boolean {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isBlockQuantity(value: unknown): boolean {
  return typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value);
}

function paramsError(method: BrowserWalletRpcMethod, params: unknown[] | undefined): string | null {
  const values = params ?? [];
  switch (method) {
    case 'eth_chainId':
    case 'eth_blockNumber':
      return values.length === 0 ? null : `${method} does not accept params`;
    case 'eth_getTransactionReceipt':
    case 'eth_getTransactionByHash':
      return values.length === 1 && isHash(values[0]) ? null : `${method} requires one transaction hash`;
    case 'eth_getBlockByNumber':
      if (values.length !== 2) return `${method} requires a block id and transaction-detail flag`;
      if (!(isBlockQuantity(values[0]) || ['latest', 'safe', 'finalized'].includes(String(values[0])))) {
        return `${method} requires latest/safe/finalized or a hex block id`;
      }
      return typeof values[1] === 'boolean' ? null : `${method} transaction-detail flag must be boolean`;
    case 'eth_call':
      if (values.length < 1 || values.length > 2) return 'Identity wallet RPC eth_call accepts one transaction and an optional block id';
      if (values.length === 2 && !(
        isBlockQuantity(values[1]) || ['latest', 'safe', 'finalized'].includes(String(values[1]))
      )) return 'Identity wallet RPC eth_call block id is not allowed';
      return null;
  }
}

function ethCallError(
  params: unknown[] | undefined,
  contracts: IdentityWalletContracts,
): string | null {
  const tx = params?.[0];
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) {
    return 'Identity wallet RPC eth_call requires a transaction object';
  }
  const keys = Object.keys(tx);
  if (keys.some((key) => !['to', 'data'].includes(key))) {
    return 'Identity wallet RPC eth_call accepts only to and data';
  }
  const { to, data } = tx as { to?: unknown; data?: unknown };
  if (
    typeof to !== 'string'
    || typeof data !== 'string'
    || !/^0x[0-9a-fA-F]+$/.test(data)
    || data.length < 10
  ) return 'Identity wallet RPC eth_call requires a target address and function selector';
  try {
    if (ethers.getAddress(to).toLowerCase() !== ethers.getAddress(contracts.storage).toLowerCase()) {
      return 'Identity wallet RPC eth_call target or selector is not allowed';
    }
  } catch {
    return 'Identity wallet RPC eth_call target address is invalid';
  }
  return IDENTITY_STORAGE_SELECTORS.has(data.slice(0, 10).toLowerCase())
    ? null
    : 'Identity wallet RPC eth_call target or selector is not allowed';
}

function supportsIdentityWallets(agent: RequestContext['agent']): boolean {
  const candidate = agent as RequestContext['agent'] & {
    supportsIdentityWalletManagement?: unknown;
    getIdentityWalletContracts?: unknown;
    requestIdentityWalletRpc?: unknown;
  };
  if (typeof candidate.supportsIdentityWalletManagement === 'boolean') {
    return candidate.supportsIdentityWalletManagement;
  }
  return typeof candidate.getIdentityWalletContracts === 'function'
    && typeof candidate.requestIdentityWalletRpc === 'function';
}

function walletRpcUrls(contracts: IdentityWalletContracts): string[] {
  return (contracts.walletRpcUrls ?? []).filter((url) => /^https?:\/\//i.test(url));
}

async function handleRpcRequest(agent: RequestContext['agent'], raw: unknown) {
  return executeRestrictedBrowserWalletRpc(raw, {
    allowedMethods: ALLOWED_METHODS,
    nullableResultMethods: NULL_RESULT_METHODS,
    unavailableMessage: FEATURE_UNAVAILABLE.error,
    methodErrorPrefix: 'Identity wallet RPC',
    paramsError,
    authorizeEthCall: async (params) => {
      const contracts = await agent.getIdentityWalletContracts();
      return contracts === null
        ? { available: false }
        : { available: true, error: ethCallError(params, contracts) };
    },
    request: (method, params) => agent.requestIdentityWalletRpc(method, params),
    readErrorPrefix: 'Identity wallet RPC read failed',
  });
}

export async function handleIdentityWalletRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path } = ctx;
  if (!path.startsWith('/api/identity-wallets')) return;

  if (!supportsIdentityWallets(agent)) {
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
    const parsed = parseJson(await readBody(req, SMALL_BODY_BYTES));
    if (!parsed.ok) return jsonResponse(res, 400, { error: parsed.error });
    if (Array.isArray(parsed.value)) {
      if (parsed.value.length === 0 || parsed.value.length > MAX_BATCH) {
        return jsonResponse(res, 400, {
          error: `JSON-RPC batch must contain between 1 and ${MAX_BATCH} requests`,
        });
      }
      return jsonResponse(
        res,
        200,
        await Promise.all(parsed.value.map((item) => handleRpcRequest(agent, item))),
      );
    }
    return jsonResponse(res, 200, await handleRpcRequest(agent, parsed.value));
  }

  return jsonResponse(res, 404, { error: 'Identity wallet route not found' });
}
