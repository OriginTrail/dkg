import { describe, expect, it } from 'vitest';
import type { BrowserWalletRpcMethod } from '../src/chain-adapter.js';
import { classifyBrowserWalletRead } from '../src/browser-wallet-rpc-policy.js';

describe('classifyBrowserWalletRead', () => {
  it.each([
    ['eth_blockNumber', [], 'tipTransparent'],
    ['eth_call', [{ to: '0x1' }], 'tipTransparent'],
    ['eth_call', [{ to: '0x1' }, 'latest'], 'tipTransparent'],
    ['eth_call', [{ to: '0x1' }, '0x10'], 'sticky'],
    ['eth_getBlockByNumber', ['pending', false], 'tipNullableTransparent'],
    ['eth_getBlockByNumber', ['0x10', false], 'stickyNullable'],
    ['eth_getTransactionReceipt', ['0xhash'], 'stickyNullable'],
    ['eth_getTransactionByHash', ['0xhash'], 'stickyNullable'],
    ['eth_chainId', [], 'sticky'],
  ] as const)('classifies %s as %s', (method, params, expected) => {
    expect(classifyBrowserWalletRead(method, params)).toBe(expected);
  });

  it('rejects an unexpected runtime method at the classifier boundary', () => {
    const unexpected = 'eth_unexpected' as BrowserWalletRpcMethod;

    expect(() => classifyBrowserWalletRead(unexpected, []))
      .toThrow('Unsupported browser-wallet RPC method: eth_unexpected');
  });
});
