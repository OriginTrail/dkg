// SPDX-License-Identifier: Apache-2.0

import { assertCanonicalChainId } from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';
import { bindFinalizedEvmReadBindingProvider } from '../src/finalized-evm-read-binding-provider.js';
import { NoChainAdapter } from '../src/no-chain-adapter.js';
import { createStrictCurrentFinalizedEvmSnapshotScopeV1 } from '../src/strict-current-finalized-evm-snapshot-factory.js';
import type { FinalizedChainReadOwnerV1 } from '../src/finalized-chain-read-admission.js';

describe('optional finalized EVM binding provider', () => {
  it('captures a provider once and preserves its receiver and read owner', async () => {
    const chainId = '20430';
    assertCanonicalChainId(chainId);
    const binding = Object.freeze({
      chainId,
      snapshot: createStrictCurrentFinalizedEvmSnapshotScopeV1({
        chainId, endpoints: ['http://127.0.0.1:8545'], owner: 'rfc64',
      }),
    });
    const adapter = new NoChainAdapter();
    const create = vi.fn(function (this: NoChainAdapter, owner: FinalizedChainReadOwnerV1) {
      expect(this).toBe(adapter);
      expect(owner).toBe('rfc64');
      return Promise.resolve(binding);
    });
    const read = vi.fn(() => create);
    Object.defineProperty(adapter, 'createFinalizedEvmReadBinding', { get: read });
    const capability = bindFinalizedEvmReadBindingProvider(adapter);
    expect(capability.status).toBe('supported');
    if (capability.status !== 'supported') throw new Error('Expected provider');
    await expect(capability.provider.createFinalizedEvmReadBinding('rfc64')).resolves.toBe(binding);
    expect(read).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability.provider)).toBe(true);
  });

  it.each([undefined, null, false])('treats a legacy non-function capability %s as unsupported', method => {
    const adapter = new NoChainAdapter();
    Object.defineProperty(adapter, 'createFinalizedEvmReadBinding', { value: method });
    expect(bindFinalizedEvmReadBindingProvider(adapter)).toEqual({
      status: 'unsupported', reason: 'finalized-evm-read-binding-unavailable',
    });
  });

  it('preserves a provider refusal and error without substituting another RPC source', async () => {
    const refused = bindFinalizedEvmReadBindingProvider(Object.assign(new NoChainAdapter(), {
      createFinalizedEvmReadBinding: async () => null,
    }));
    if (refused.status !== 'supported') throw new Error('Expected provider');
    await expect(refused.provider.createFinalizedEvmReadBinding('rfc64')).resolves.toBeNull();
    const failure = new Error('adapter configuration failed');
    const failed = bindFinalizedEvmReadBindingProvider(Object.assign(new NoChainAdapter(), {
      createFinalizedEvmReadBinding: async () => { throw failure; },
    }));
    if (failed.status !== 'supported') throw new Error('Expected provider');
    await expect(failed.provider.createFinalizedEvmReadBinding('rfc64')).rejects.toBe(failure);
  });
});
