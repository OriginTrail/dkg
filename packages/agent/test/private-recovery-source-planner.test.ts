import { describe, expect, it, vi } from 'vitest';
import { planPrivateRecoverySource } from '../src/sync/private-recovery-source-planner.js';

const CURATOR = '0x1111111111111111111111111111111111111111';
const STRUCTURAL_CG = `${CURATOR}/private-cg`;
const REMOTE_PEER = '12D3KooWRemoteCurator';

function input(overrides: Partial<Parameters<typeof planPrivateRecoverySource>[0]> = {}) {
  return {
    contextGraphId: STRUCTURAL_CG,
    remotePeerId: REMOTE_PEER,
    completeProviderSelected: false,
    localAgentAddresses: [] as string[],
    localPeerId: '12D3KooWLocalPeer',
    isLegacyLocalCurator: vi.fn(async () => false),
    resolveStructuralCuratorPeers: vi.fn(async () => [REMOTE_PEER]),
    resolveLegacyCuratorPeer: vi.fn(async () => REMOTE_PEER),
    ...overrides,
  };
}

describe('private recovery source planner', () => {
  it('prohibits local-curator recovery before considering a provider pin', async () => {
    const resolveStructuralCuratorPeers = vi.fn(async () => [REMOTE_PEER]);

    await expect(planPrivateRecoverySource(input({
      completeProviderSelected: true,
      localAgentAddresses: [CURATOR],
      resolveStructuralCuratorPeers,
    }))).resolves.toMatchObject({
      kind: 'skip',
      reason: 'local-curator',
      authority: 'structural',
    });
    expect(resolveStructuralCuratorPeers).not.toHaveBeenCalled();
  });

  it('uses a pinned complete provider without curator discovery', async () => {
    const resolveStructuralCuratorPeers = vi.fn(async () => []);

    await expect(planPrivateRecoverySource(input({
      completeProviderSelected: true,
      resolveStructuralCuratorPeers,
    }))).resolves.toEqual({
      kind: 'recover',
      source: 'rfc64-complete-provider',
      curatorPeerId: REMOTE_PEER,
    });
    expect(resolveStructuralCuratorPeers).not.toHaveBeenCalled();
  });

  it('accepts a connecting peer found through structural curator discovery', async () => {
    await expect(planPrivateRecoverySource(input())).resolves.toEqual({
      kind: 'recover',
      source: 'structural-curator',
      curatorPeerId: REMOTE_PEER,
    });
  });

  it('falls back to legacy curator discovery for non-wallet-scoped graphs', async () => {
    const resolveLegacyCuratorPeer = vi.fn(async () => REMOTE_PEER);

    await expect(planPrivateRecoverySource(input({
      contextGraphId: 'legacy-private-cg',
      resolveLegacyCuratorPeer,
    }))).resolves.toEqual({
      kind: 'recover',
      source: 'legacy-curator',
      curatorPeerId: REMOTE_PEER,
    });
    expect(resolveLegacyCuratorPeer).toHaveBeenCalledOnce();
  });
});
