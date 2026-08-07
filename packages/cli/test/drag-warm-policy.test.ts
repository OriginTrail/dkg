import { describe, expect, it, vi } from 'vitest';
import {
  warmDragIndexIfAllowed,
  type DragWarmPolicyAgent,
} from '../src/daemon/drag-warm-policy.js';

function policyAgent(options: {
  policy?: 'public' | 'private' | null;
  publicOnChain?: boolean;
  policyError?: Error;
  publicLookupError?: Error;
} = {}) {
  const warm = vi.fn(async () => {});
  const getExplicitAccessPolicy = options.policyError
    ? vi.fn(async () => { throw options.policyError; })
    : vi.fn(async () => options.policy ?? null);
  const isContextGraphPublicOnChain = options.publicLookupError
    ? vi.fn(async () => { throw options.publicLookupError; })
    : vi.fn(async () => options.publicOnChain ?? false);
  const agent: DragWarmPolicyAgent = {
    entityRetriever: { warm },
    getExplicitAccessPolicy,
    isContextGraphPublicOnChain,
  };
  return { agent, warm, getExplicitAccessPolicy, isContextGraphPublicOnChain };
}

describe('background dRAG warm privacy policy', () => {
  it('does not warm an explicitly private context graph by default', async () => {
    const f = policyAgent({ policy: 'private', publicOnChain: true });

    expect(await warmDragIndexIfAllowed(f.agent, 'private-cg')).toBe(false);
    expect(f.warm).not.toHaveBeenCalled();
    expect(f.isContextGraphPublicOnChain).not.toHaveBeenCalled();
  });

  it('does not warm an unknown context graph', async () => {
    const f = policyAgent({ policy: null, publicOnChain: false });

    expect(await warmDragIndexIfAllowed(f.agent, 'unknown-cg')).toBe(false);
    expect(f.warm).not.toHaveBeenCalled();
    expect(f.isContextGraphPublicOnChain).toHaveBeenCalledWith('unknown-cg');
  });

  it('fails closed when the access-policy lookup throws', async () => {
    const f = policyAgent({
      policyError: new Error('store unavailable'),
      publicOnChain: true,
    });

    expect(await warmDragIndexIfAllowed(f.agent, 'lookup-error-cg')).toBe(false);
    expect(f.warm).not.toHaveBeenCalled();
    expect(f.isContextGraphPublicOnChain).not.toHaveBeenCalled();
  });

  it('fails closed when the live public-policy lookup throws', async () => {
    const f = policyAgent({
      policy: null,
      publicLookupError: new Error('chain unavailable'),
    });

    expect(await warmDragIndexIfAllowed(f.agent, 'lookup-error-cg')).toBe(false);
    expect(f.warm).not.toHaveBeenCalled();
    expect(f.isContextGraphPublicOnChain).toHaveBeenCalledWith('lookup-error-cg');
  });

  it('warms a context graph with explicit public metadata', async () => {
    const f = policyAgent({ policy: 'public' });

    expect(await warmDragIndexIfAllowed(f.agent, 'public-cg')).toBe(true);
    expect(f.warm).toHaveBeenCalledWith('public-cg');
    expect(f.isContextGraphPublicOnChain).not.toHaveBeenCalled();
  });

  it('warms a legacy context graph proven public on chain', async () => {
    const f = policyAgent({ policy: null, publicOnChain: true });

    expect(await warmDragIndexIfAllowed(f.agent, 'legacy-public-cg')).toBe(true);
    expect(f.warm).toHaveBeenCalledWith('legacy-public-cg');
  });

  it('warms a private context graph only after explicit operator opt-in', async () => {
    const f = policyAgent({ policy: 'private' });

    expect(await warmDragIndexIfAllowed(f.agent, 'private-cg', true)).toBe(true);
    expect(f.warm).toHaveBeenCalledWith('private-cg');
    expect(f.getExplicitAccessPolicy).not.toHaveBeenCalled();
    expect(f.isContextGraphPublicOnChain).not.toHaveBeenCalled();
  });
});
