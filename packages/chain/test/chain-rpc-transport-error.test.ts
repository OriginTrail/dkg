// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import {
  ChainRpcTransportError,
  isChainRpcTransportError,
} from '../src/chain-rpc-transport-error.js';

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

describe('isChainRpcTransportError (code-based guard)', () => {
  it('is true for every transport code, regardless of constructor', () => {
    for (const code of ['RPC_ENDPOINTS_EXHAUSTED', 'RPC_RECEIPT_LOOKUP_FAILED', 'TIMEOUT'] as const) {
      // A real typed instance...
      expect(isChainRpcTransportError(new ChainRpcTransportError(code, 'm'))).toBe(true);
      // ...AND a plain ethers-/CLI-shaped object with the same code (the guard is
      // code-based, NOT instanceof, so an ethers TIMEOUT is still recognised).
      expect(isChainRpcTransportError({ code, message: 'm' })).toBe(true);
    }
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
