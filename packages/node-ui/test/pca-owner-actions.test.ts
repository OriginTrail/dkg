// @vitest-environment happy-dom
//
// Owner-action seam (plan §2.3) — the delegation CONTRACT. Guards the future §9
// swap: every owner-write method of `daemonOwnerActionSubmitter` must call the
// matching api.ts helper with the right args and pass its result straight through
// (P0 = pure indirection, byte-identical). `useOwnerActionSubmitter` always
// resolves to the daemon submitter in P0, for any accountId.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createPca: vi.fn(),
  pcaAddAgent: vi.fn(),
  pcaRemoveAgent: vi.fn(),
  pcaTopUp: vi.fn(),
  pcaSettle: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return { ...actual, ...mocks };
});

const { daemonOwnerActionSubmitter, useOwnerActionSubmitter } = await import('../src/ui/pca/ownerActions.js');

beforeEach(() => vi.clearAllMocks());

describe('daemonOwnerActionSubmitter delegation contract', () => {
  it('create → createPca(args), result passed through', async () => {
    mocks.createPca.mockResolvedValue({ accountId: '7' });
    const res = await daemonOwnerActionSubmitter.create({ tokens: '100', primaryNode: '42' });
    expect(mocks.createPca).toHaveBeenCalledWith({ tokens: '100', primaryNode: '42' });
    expect(res).toEqual({ accountId: '7' });
  });

  it('registerAgent → pcaAddAgent(accountId, agent)', async () => {
    mocks.pcaAddAgent.mockResolvedValue({ registered: true });
    const res = await daemonOwnerActionSubmitter.registerAgent('7', '0xabc');
    expect(mocks.pcaAddAgent).toHaveBeenCalledWith('7', '0xabc');
    expect(res).toEqual({ registered: true });
  });

  it('deregisterAgent → pcaRemoveAgent(accountId, agent)', async () => {
    mocks.pcaRemoveAgent.mockResolvedValue({ deregistered: true });
    const res = await daemonOwnerActionSubmitter.deregisterAgent('7', '0xabc');
    expect(mocks.pcaRemoveAgent).toHaveBeenCalledWith('7', '0xabc');
    expect(res).toEqual({ deregistered: true });
  });

  it('topUp → pcaTopUp(accountId, tokens)', async () => {
    mocks.pcaTopUp.mockResolvedValue({ addedTokens: '50' });
    const res = await daemonOwnerActionSubmitter.topUp('7', '50');
    expect(mocks.pcaTopUp).toHaveBeenCalledWith('7', '50');
    expect(res).toEqual({ addedTokens: '50' });
  });

  it('settle → pcaSettle(accountId)', async () => {
    mocks.pcaSettle.mockResolvedValue({ settled: true });
    const res = await daemonOwnerActionSubmitter.settle('7');
    expect(mocks.pcaSettle).toHaveBeenCalledWith('7');
    expect(res).toEqual({ settled: true });
  });

  it('useOwnerActionSubmitter resolves to the daemon submitter for ANY accountId (P0)', () => {
    expect(useOwnerActionSubmitter()).toBe(daemonOwnerActionSubmitter);
    expect(useOwnerActionSubmitter('7')).toBe(daemonOwnerActionSubmitter);
    expect(useOwnerActionSubmitter('999')).toBe(daemonOwnerActionSubmitter);
  });
});
