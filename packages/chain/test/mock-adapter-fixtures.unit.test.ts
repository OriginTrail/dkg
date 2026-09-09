import { describe, expect, it } from 'vitest';

import { MockChainAdapter, MOCK_DEFAULT_SIGNER } from '../src/mock-adapter.js';
import type { ChainAdapter } from '../src/chain-adapter.js';
import { NoChainAdapter } from '../src/no-chain-adapter.js';

describe('MockChainAdapter explicit fixture seams', () => {
  it.each([
    ['mock', new MockChainAdapter()],
    ['no-chain', new NoChainAdapter()],
  ] as const)('provides no finalized EVM evidence for the %s adapter', async (_name, adapter: ChainAdapter) => {
    // The optional capability must fail closed for local state: callers cannot
    // mistake a fixture or chain-disabled node for a finalized read source.
    const snapshot = await adapter.createFinalizedEvmSnapshotScope?.('rfc64') ?? null;
    expect(snapshot).toBeNull();
  });

  it('seeds the first numeric context graph id through immutable fixture setup', async () => {
    const mock = new MockChainAdapter('mock:31337', MOCK_DEFAULT_SIGNER, {
      initialContextGraphId: 14n,
    });
    const created = await mock.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
    });
    expect(created.contextGraphId).toBe(14n);
    await expect(mock.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
    })).resolves.toMatchObject({ contextGraphId: 15n });
    expect(() => new MockChainAdapter('mock:31337', MOCK_DEFAULT_SIGNER, {
      initialContextGraphId: 0n,
    })).toThrow('must be positive');
  });
});
