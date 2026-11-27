import { describe, expect, it } from 'vitest';

import { MockChainAdapter, MOCK_DEFAULT_SIGNER } from '../src/mock-adapter.js';

describe('MockChainAdapter explicit fixture seams', () => {
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
