// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import {
  ChainRpcTransportError,
  isChainRpcTransportError,
} from '../src/chain-rpc-transport-error.js';
import { withTimeout } from '../src/evm-adapter-rpc.js';

describe('ChainRpcTransportError (typed transport boundary)', () => {
  it('carries code + message + optional rpcUrls/txHash and is an Error', () => {
    const cause = new Error('connect ECONNREFUSED');
    const err = new ChainRpcTransportError('RPC_ENDPOINTS_EXHAUSTED', 'all endpoints failed', {
      cause,
      rpcUrls: ['https://a.example', 'https://b.example'],
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ChainRpcTransportError');
    expect(err.code).toBe('RPC_ENDPOINTS_EXHAUSTED');
    expect(err.message).toBe('all endpoints failed');
    expect(err.rpcUrls).toEqual(['https://a.example', 'https://b.example']);
    expect(err.txHash).toBeUndefined();
    expect((err as any).cause).toBe(cause);
  });

  it('defensively copies rpcUrls (caller cannot mutate the captured list)', () => {
    const urls = ['https://a.example'];
    const err = new ChainRpcTransportError('RPC_ENDPOINTS_EXHAUSTED', 'm', { rpcUrls: urls });
    urls.push('https://mutated.example');
    expect(err.rpcUrls).toEqual(['https://a.example']);
  });

  it('keeps txHash for receipt/timeout errors', () => {
    const err = new ChainRpcTransportError('RPC_RECEIPT_LOOKUP_FAILED', 'm', { txHash: '0xabc' });
    expect(err.txHash).toBe('0xabc');
  });
});

describe('isChainRpcTransportError (one structural namespaced-code guard)', () => {
  // The boundary is a single structural check over the three chain-NAMESPACED
  // codes — same model for every transport case (no instanceof/prototype
  // coupling), so instances AND plain-object re-wraps that keep `.code` match.
  it('is true for every transport case — instance OR plain object — uniformly', () => {
    for (const code of ['RPC_ENDPOINTS_EXHAUSTED', 'RPC_RECEIPT_LOOKUP_FAILED', 'RPC_TIMEOUT'] as const) {
      expect(isChainRpcTransportError(new ChainRpcTransportError(code, 'm'))).toBe(true);
      expect(isChainRpcTransportError({ code, message: 'm' })).toBe(true);
    }
  });

  it('is FALSE for a bare generic `code: TIMEOUT` (the chain timeout code is the namespaced RPC_TIMEOUT)', () => {
    // A timeout stamped by ethers or an unrelated subsystem uses the generic
    // `TIMEOUT`, which must NOT satisfy the chain-transport boundary — only the
    // namespaced RPC_TIMEOUT does. This is the #1332 review fix.
    expect(isChainRpcTransportError({ code: 'TIMEOUT', message: 'some other op timed out' })).toBe(false);
  });

  it('is false for on-chain reverts / app errors / non-objects (preserves #988)', () => {
    expect(isChainRpcTransportError({ code: 'CALL_EXCEPTION', message: 'execution reverted' })).toBe(false);
    expect(isChainRpcTransportError({ code: 'INSUFFICIENT_FUNDS' })).toBe(false);
    expect(isChainRpcTransportError(new Error('header not found'))).toBe(false);
    expect(isChainRpcTransportError('TIMEOUT')).toBe(false); // a bare string, not a coded error
    expect(isChainRpcTransportError(undefined)).toBe(false);
    expect(isChainRpcTransportError(null)).toBe(false);
  });
});

describe('production timeout emitters throw a recognised RPC_TIMEOUT', () => {
  // #1332 review: the chain-side `withTimeout` is a SEPARATE emitter from
  // cliWithTimeout / the receipt-wait deadline. Drive it directly so a regression
  // back to a bare `code: 'TIMEOUT'` shape (which the guard would reject) fails
  // loudly instead of silently dropping every per-attempt timeout from the boundary.
  it('withTimeout(..., 1, ...) rejects with a ChainRpcTransportError RPC_TIMEOUT the guard accepts', async () => {
    const err = await withTimeout(new Promise<never>(() => {}), 1, 'chain probe').catch((e) => e);
    expect(err).toBeInstanceOf(ChainRpcTransportError);
    expect((err as ChainRpcTransportError).code).toBe('RPC_TIMEOUT');
    expect(isChainRpcTransportError(err)).toBe(true);
  });
});
