import { describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import {
  resolveActivePublicContextGraphChainProof,
  type OnChainAccessPolicyState,
} from '../src/active-public-context-graph-chain-proof.js';

describe('active-public Context Graph chain proof', () => {
  it.each([
    [0, { state: 'public' }],
    [1, { state: 'not-public', reason: 'private' }],
    ['unregistered', { state: 'not-public', reason: 'unregistered' }],
    ['unknown', { state: 'unknown', reason: 'unprovable' }],
  ] as const)(
    'maps policy state %s through one operation-aware resolver',
    async (state, expected) => {
      const operationContext = createOperationContext('init');
      const resolvePolicyState = vi.fn(async () => state as OnChainAccessPolicyState);

      await expect(resolveActivePublicContextGraphChainProof(
        resolvePolicyState,
        'test-context-graph',
        operationContext,
        'chain-attested-repair',
      )).resolves.toEqual(expected);
      expect(resolvePolicyState).toHaveBeenCalledWith(
        'test-context-graph',
        operationContext,
        { slotBindingMode: 'chain-attested-repair' },
      );
    },
  );
});
