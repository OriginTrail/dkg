import { describe, expect, it } from 'vitest';

import { MockChainAdapter } from '../src/mock-adapter.js';

describe('MockChainAdapter explicit fixture seams', () => {
  it('seeds a numeric context graph id once without exposing adapter internals', async () => {
    const mock = new MockChainAdapter();
    const created = await mock.createOnChainContextGraphAtIdForTesting(14n, {
      accessPolicy: 0,
      publishPolicy: 1,
    });
    expect(created.contextGraphId).toBe(14n);
    await expect(mock.createOnChainContextGraphAtIdForTesting(15n, {
      accessPolicy: 0,
      publishPolicy: 1,
    })).rejects.toThrow('before any CG exists');
  });
});
