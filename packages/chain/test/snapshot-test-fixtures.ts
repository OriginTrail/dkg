/**
 * Shared fixtures for the finalized-snapshot suites.
 *
 * `strict-current-finalized-evm-snapshot.unit.test.ts` already covers endpoint
 * pinning, preflight, budgets, cancellation, forged selectors and session
 * behaviour. Process-wide admission is a separate concern with its own file, and
 * both need the same loopback handler and request/call shapes — so the helpers
 * live here rather than being duplicated or absorbed into the behaviour matrix.
 */
import type { ChainIdV1, EvmAddressV1 } from '@origintrail-official/dkg-core';

import type { StrictCurrentFinalizedEvmReadCallV1 } from '../src/current-finalized-evm-read-model.js';

import {
  sendJsonRpcError,
  sendJsonRpcResult,
  type LoopbackJsonRpcHandler,
} from './loopback-rpc-harness.js';

export const CHAIN_ID = '20430' as ChainIdV1;
export const CHAIN_QUANTITY = '0x4fce';
export const TO = '0x1111111111111111111111111111111111111111' as EvmAddressV1;
export const PREFLIGHT_PROBE_TO = '0x0000000000000000000000000000000000000000';
export const BLOCK_HASH = `0x${'22'.repeat(32)}`;
export const FIRST_DATA = '0x11111111';
export const SECOND_DATA = '0x22222222';

export function request(): { readonly chainId: ChainIdV1; readonly signal: AbortSignal } {
  return { chainId: CHAIN_ID, signal: new AbortController().signal };
}

export function call(data: string, maxReturnBytes = 2): StrictCurrentFinalizedEvmReadCallV1 {
  return Object.freeze({ to: TO, data, maxReturnBytes });
}

export function successfulHandler(): LoopbackJsonRpcHandler {
  return (rpcCall, response) => {
    switch (rpcCall.method) {
      case 'eth_chainId':
        sendJsonRpcResult(response, rpcCall, CHAIN_QUANTITY);
        return;
      case 'eth_getBlockByNumber':
        sendJsonRpcResult(response, rpcCall, { number: '0x7b', hash: BLOCK_HASH });
        return;
      case 'eth_getCode':
        sendJsonRpcResult(response, rpcCall, '0x6000');
        return;
      case 'eth_call': {
        const callObject = rpcCall.params[0] as { readonly data?: unknown };
        if (callObject.data === '0x') sendJsonRpcResult(response, rpcCall, '0x');
        else if (callObject.data === FIRST_DATA) sendJsonRpcResult(response, rpcCall, '0xaaaa');
        else if (callObject.data === SECOND_DATA) sendJsonRpcResult(response, rpcCall, '0xbbbb');
        else sendJsonRpcError(response, rpcCall, -32602, 'unexpected calldata');
        return;
      }
      default:
        sendJsonRpcError(response, rpcCall, -32601, 'method not found');
    }
  };
}

export function isPreflightProbe(rpcCall: { readonly params: readonly unknown[] }): boolean {
  const callObject = rpcCall.params[0] as { readonly to?: unknown; readonly data?: unknown };
  return callObject.to === PREFLIGHT_PROBE_TO && callObject.data === '0x';
}

export function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
