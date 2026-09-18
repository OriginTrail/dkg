import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ContextGraphLiveAuthorityUnsupportedError,
  MockChainAdapter,
} from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import {
  resolveLiveOnChainAccessPolicyState,
  type LiveOnChainAccessPolicyDependencies,
} from '../src/internal/context-graph-authority/context-graph-access-policy.js';

const MEMBER = '0x0000000000000000000000000000000000000001';

function dependencies(
  overrides: Partial<LiveOnChainAccessPolicyDependencies> = {},
): LiveOnChainAccessPolicyDependencies {
  return {
    isContextGraphActiveOnChain: vi.fn(async () => true),
    getContextGraphAccessPolicy: vi.fn(async () => 1),
    runBoundedRead: async (start) => ({ kind: 'value', value: await start() }),
    claimMissingLivenessWarning: vi.fn(() => true),
    warn: vi.fn(),
    cacheAccessPolicy: vi.fn(),
    ...overrides,
  };
}

describe('folding liveness + policy + roster into one live authority read', () => {
  it('serves liveness, policy AND roster from the single read; the point reads stay idle', async () => {
    const deps = dependencies({
      readLiveAuthority: vi.fn(async () => ({ active: true, accessPolicy: 1, participantAgents: [MEMBER] })),
    });
    await expect(resolveLiveOnChainAccessPolicyState(deps, '7')).resolves.toEqual({
      kind: 'available',
      accessPolicy: 1,
      participantAgents: [MEMBER],
    });
    expect(deps.isContextGraphActiveOnChain).not.toHaveBeenCalled();
    expect(deps.getContextGraphAccessPolicy).not.toHaveBeenCalled();
    expect(deps.cacheAccessPolicy).toHaveBeenCalledWith('7', 1);
  });

  it('checks liveness BEFORE policy: an inactive public-policy graph is unknown, never public', async () => {
    const deps = dependencies({
      readLiveAuthority: vi.fn(async () => ({ active: false, accessPolicy: 0, participantAgents: [] })),
    });
    await expect(resolveLiveOnChainAccessPolicyState(deps, '7')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'chain-access-policy-unknown',
    });
    // A deactivated graph must not seed the policy cache either.
    expect(deps.cacheAccessPolicy).not.toHaveBeenCalled();
  });

  it('maps a proven-nonexistent id to the TERMINAL unknown reason, not a retryable one', async () => {
    const deps = dependencies({ readLiveAuthority: vi.fn(async () => null) });
    await expect(resolveLiveOnChainAccessPolicyState(deps, '7')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'chain-access-policy-unknown',
    });
    expect(deps.isContextGraphActiveOnChain).not.toHaveBeenCalled();
  });

  it('falls back to the three point reads when the deployment lacks the getter', async () => {
    const deps = dependencies({
      readLiveAuthority: vi.fn(async () => { throw new ContextGraphLiveAuthorityUnsupportedError('old deployment'); }),
    });
    await expect(resolveLiveOnChainAccessPolicyState(deps, '7')).resolves.toEqual({
      kind: 'available',
      accessPolicy: 1,
    });
    expect(deps.isContextGraphActiveOnChain).toHaveBeenCalledTimes(1);
    expect(deps.getContextGraphAccessPolicy).toHaveBeenCalledTimes(1);
  });

  it('propagates a transient failure exactly like a rejected liveness read', async () => {
    const deps = dependencies({
      readLiveAuthority: vi.fn(async () => { throw new Error('socket hang up'); }),
    });
    await expect(resolveLiveOnChainAccessPolicyState(deps, '7')).rejects.toThrow('socket hang up');
    expect(deps.isContextGraphActiveOnChain).not.toHaveBeenCalled();
  });

  it('keeps the policy-value validation: an out-of-range policy is unknown', async () => {
    const deps = dependencies({
      readLiveAuthority: vi.fn(async () => ({ active: true, accessPolicy: 2, participantAgents: [] })),
    });
    await expect(resolveLiveOnChainAccessPolicyState(deps, '7')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'chain-access-policy-unknown',
    });
    expect(deps.cacheAccessPolicy).not.toHaveBeenCalled();
  });
});

describe('registered authority resolution uses the roster from the single read', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) await agent.stop().catch(() => undefined);
    agent = null;
  });

  it('does not issue a separate roster read when the live read carried one', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FoldRoster', chainAdapter: chain });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue({ kind: 'registered', onChainId: 7n, provenance: 'numeric-id' });
    const live = vi.spyOn(chain, 'getContextGraphLiveAuthority')
      .mockResolvedValue({ active: true, accessPolicy: 1, participantAgents: [MEMBER] });
    const roster = vi.spyOn(chain, 'getContextGraphParticipantAgents');

    await expect(agent.resolveRegisteredContextGraphAuthority('cg')).resolves.toEqual({
      kind: 'private',
      onChainId: 7n,
      participantAgents: [MEMBER],
    });
    expect(live).toHaveBeenCalledTimes(1);
    expect(roster).not.toHaveBeenCalled();
  });

  it('still takes the three point reads when the getter is unsupported', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FoldFallback', chainAdapter: chain });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue({ kind: 'registered', onChainId: 7n, provenance: 'numeric-id' });
    vi.spyOn(chain, 'getContextGraphLiveAuthority')
      .mockRejectedValue(new ContextGraphLiveAuthorityUnsupportedError('old deployment'));
    vi.spyOn(chain, 'isContextGraphActiveOnChain').mockResolvedValue(true);
    vi.spyOn(chain, 'getContextGraphAccessPolicy').mockResolvedValue(1);
    const roster = vi.spyOn(chain, 'getContextGraphParticipantAgents').mockResolvedValue([MEMBER]);

    await expect(agent.resolveRegisteredContextGraphAuthority('cg')).resolves.toMatchObject({
      kind: 'private',
      participantAgents: [MEMBER],
    });
    expect(roster).toHaveBeenCalledTimes(1);
  });
});
