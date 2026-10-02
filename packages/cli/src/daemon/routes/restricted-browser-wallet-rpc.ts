import type { BrowserWalletRpcMethod } from '@origintrail-official/dkg-chain';
import {
  classifyChainRpcTransportStatus,
  sanitizeRpcMessage,
} from '../http-utils.js';

type JsonRpcId = string | number | null;
const RESTRICTED_BROWSER_WALLET_RPC_MAX_BATCH = 20;
const RESTRICTED_BROWSER_WALLET_RPC_METHODS = new Set<BrowserWalletRpcMethod>([
  'eth_chainId',
  'eth_call',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_blockNumber',
  'eth_getBlockByNumber',
]);
const NULLABLE_RESULT_METHODS = new Set<BrowserWalletRpcMethod>([
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getBlockByNumber',
]);

export interface RestrictedEthCallAuthorization {
  available: boolean;
  error?: string | null;
}

export interface RestrictedEthCall {
  to: string;
  data: string;
  transaction: Readonly<Record<string, unknown>>;
}

/**
 * Feature-owned policy for the shared, read-only browser-wallet JSON-RPC
 * executor. The executor owns the global method allowlist, request-envelope
 * validation, transport classification, and error shape. Each feature still
 * owns its narrower parameter and contract-selector authorization policy.
 */
export interface RestrictedBrowserWalletRpcPolicy<
  Method extends BrowserWalletRpcMethod = BrowserWalletRpcMethod,
> {
  unavailableMessage: string;
  methodErrorPrefix: string;
  /** PCA receipt reconciliation deliberately needs full exact-block payloads. */
  allowFullTransactionsForExactBlocks?: boolean;
  authorizeEthCall?: (
    call: RestrictedEthCall,
    params: unknown[] | undefined,
  ) => Promise<RestrictedEthCallAuthorization>;
  request: (method: Method, params: unknown[]) => Promise<unknown>;
  isUnavailableError?: (error: unknown, sanitizedMessage: string) => boolean;
  readErrorPrefix: string;
}

export interface RestrictedBrowserWalletRpcHttpResult {
  status: 200 | 400;
  body: unknown;
}

function jsonRpcId(value: unknown): JsonRpcId {
  return typeof value === 'string' || typeof value === 'number' || value === null ? value : null;
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function rpcSuccess(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function allowedMethod(method: string): method is BrowserWalletRpcMethod {
  return RESTRICTED_BROWSER_WALLET_RPC_METHODS.has(method as BrowserWalletRpcMethod);
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isBlockQuantity(value: unknown): value is string {
  return typeof value === 'string' && /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value);
}

function isNamedBlockTag(value: unknown): value is string {
  return value === 'latest' || value === 'safe' || value === 'finalized';
}

function restrictedEthCall(params: unknown[] | undefined): RestrictedEthCall | null {
  const transaction = params?.[0];
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) return null;
  const { to, data } = transaction as { to?: unknown; data?: unknown };
  if (
    typeof to !== 'string'
    || !/^0x[0-9a-fA-F]{40}$/.test(to)
    || typeof data !== 'string'
    || !/^0x[0-9a-fA-F]+$/.test(data)
    || data.length < 10
  ) return null;
  return { to, data, transaction: transaction as Record<string, unknown> };
}

function commonParamsError(
  method: BrowserWalletRpcMethod,
  params: unknown[] | undefined,
  policy: Pick<RestrictedBrowserWalletRpcPolicy, 'allowFullTransactionsForExactBlocks' | 'methodErrorPrefix'>,
): string | null {
  const values = params ?? [];
  const prefix = policy.methodErrorPrefix;
  switch (method) {
    case 'eth_chainId':
    case 'eth_blockNumber':
      return values.length === 0 ? null : `${prefix} ${method} does not accept params`;
    case 'eth_getTransactionReceipt':
    case 'eth_getTransactionByHash':
      return values.length === 1 && isHash(values[0])
        ? null
        : `${prefix} ${method} requires one 32-byte transaction hash`;
    case 'eth_getBlockByNumber': {
      if (values.length !== 2) {
        return `${prefix} eth_getBlockByNumber requires block id and includeTransactions=false`;
      }
      const block = values[0];
      const includeTransactions = values[1];
      if (isNamedBlockTag(block) && includeTransactions === false) return null;
      if (
        isBlockQuantity(block)
        && (includeTransactions === false
          || (policy.allowFullTransactionsForExactBlocks === true && includeTransactions === true))
      ) return null;
      return policy.allowFullTransactionsForExactBlocks
        ? `${prefix} eth_getBlockByNumber only allows latest/safe/finalized with includeTransactions=false, or exact hex block ids with includeTransactions true/false`
        : `${prefix} eth_getBlockByNumber only allows latest/safe/finalized or exact hex block ids with includeTransactions=false`;
    }
    case 'eth_call':
      if (values.length < 1 || values.length > 2) {
        return `${prefix} eth_call requires a transaction object and optional block id`;
      }
      if (values.length === 2 && !(isNamedBlockTag(values[1]) || isBlockQuantity(values[1]))) {
        return `${prefix} eth_call only allows latest/safe/finalized or hex block ids`;
      }
      return restrictedEthCall(values) === null
        ? `${prefix} eth_call requires a target address and function selector`
        : null;
  }
}

export async function executeRestrictedBrowserWalletRpc<
  Method extends BrowserWalletRpcMethod,
>(
  raw: unknown,
  policy: RestrictedBrowserWalletRpcPolicy<Method>,
): Promise<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return rpcError(null, -32600, 'Invalid JSON-RPC request');
  }
  const request = raw as { id?: unknown; method?: unknown; params?: unknown };
  const id = jsonRpcId(request.id ?? null);
  if (typeof request.method !== 'string' || request.method.length === 0) {
    return rpcError(id, -32600, 'Invalid JSON-RPC method');
  }
  if (!allowedMethod(request.method)) {
    return rpcError(id, -32601, `${policy.methodErrorPrefix} method not allowed: ${request.method}`);
  }
  if (request.params !== undefined && !Array.isArray(request.params)) {
    return rpcError(id, -32602, `${policy.methodErrorPrefix} params must be an array`);
  }
  const params = request.params as unknown[] | undefined;
  const invalidParams = commonParamsError(request.method, params, policy);
  if (invalidParams) return rpcError(id, -32602, invalidParams);

  try {
    if (request.method === 'eth_call' && policy.authorizeEthCall) {
      // commonParamsError already validated this shape.
      const authorization = await policy.authorizeEthCall(restrictedEthCall(params)!, params);
      if (!authorization.available) {
        return rpcError(id, -32004, policy.unavailableMessage);
      }
      if (authorization.error) return rpcError(id, -32602, authorization.error);
    }
    const result = await policy.request(request.method as Method, params ?? []);
    if (result === null && !NULLABLE_RESULT_METHODS.has(request.method)) {
      return rpcError(id, -32004, policy.unavailableMessage);
    }
    return rpcSuccess(id, result);
  } catch (error) {
    const transport = classifyChainRpcTransportStatus(error);
    if (transport) {
      return rpcError(id, -32002, String(transport.body.error ?? 'Chain RPC transport unavailable'), {
        code: transport.body.code,
        ...(transport.body.txHash ? { txHash: transport.body.txHash } : {}),
      });
    }
    const message = sanitizeRpcMessage(error instanceof Error ? error.message : String(error));
    if (policy.isUnavailableError?.(error, message)) {
      return rpcError(id, -32004, policy.unavailableMessage);
    }
    return rpcError(id, -32000, `${policy.readErrorPrefix}: ${message}`);
  }
}

/**
 * Parse and execute one bounded JSON-RPC HTTP body. Both wallet features use
 * this entry point so envelope parsing, batch limits, method membership,
 * nullability, and common parameter schemas cannot drift between routes.
 */
export async function executeRestrictedBrowserWalletRpcBody<
  Method extends BrowserWalletRpcMethod,
>(
  rawBody: string,
  policy: RestrictedBrowserWalletRpcPolicy<Method>,
): Promise<RestrictedBrowserWalletRpcHttpResult> {
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch (error) {
    return {
      status: 400,
      body: {
        error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > RESTRICTED_BROWSER_WALLET_RPC_MAX_BATCH) {
      return {
        status: 400,
        body: {
          error: `JSON-RPC batch must contain between 1 and ${RESTRICTED_BROWSER_WALLET_RPC_MAX_BATCH} requests`,
        },
      };
    }
    return {
      status: 200,
      body: await Promise.all(value.map((item) => executeRestrictedBrowserWalletRpc(item, policy))),
    };
  }
  return {
    status: 200,
    body: await executeRestrictedBrowserWalletRpc(value, policy),
  };
}
