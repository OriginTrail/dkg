import type { BrowserWalletRpcMethod } from '@origintrail-official/dkg-chain';
import {
  classifyChainRpcTransportStatus,
  sanitizeRpcMessage,
} from '../http-utils.js';

type JsonRpcId = string | number | null;

export interface RestrictedEthCallAuthorization {
  available: boolean;
  error?: string | null;
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
  allowedMethods: ReadonlySet<Method>;
  nullableResultMethods: ReadonlySet<Method>;
  unavailableMessage: string;
  methodErrorPrefix: string;
  paramsError: (method: Method, params: unknown[] | undefined) => string | null;
  authorizeEthCall?: (params: unknown[] | undefined) => Promise<RestrictedEthCallAuthorization>;
  request: (method: Method, params: unknown[]) => Promise<unknown>;
  isUnavailableError?: (error: unknown, sanitizedMessage: string) => boolean;
  readErrorPrefix: string;
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

function allowedMethod<Method extends BrowserWalletRpcMethod>(
  method: string,
  methods: ReadonlySet<Method>,
): method is Method {
  return methods.has(method as Method);
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
  if (!allowedMethod(request.method, policy.allowedMethods)) {
    return rpcError(id, -32601, `${policy.methodErrorPrefix} method not allowed: ${request.method}`);
  }
  if (request.params !== undefined && !Array.isArray(request.params)) {
    return rpcError(id, -32602, `${policy.methodErrorPrefix} params must be an array`);
  }
  const params = request.params as unknown[] | undefined;
  const invalidParams = policy.paramsError(request.method, params);
  if (invalidParams) return rpcError(id, -32602, invalidParams);

  try {
    if (request.method === 'eth_call' && policy.authorizeEthCall) {
      const authorization = await policy.authorizeEthCall(params);
      if (!authorization.available) {
        return rpcError(id, -32004, policy.unavailableMessage);
      }
      if (authorization.error) return rpcError(id, -32602, authorization.error);
    }
    const result = await policy.request(request.method, params ?? []);
    if (result === null && !policy.nullableResultMethods.has(request.method)) {
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
