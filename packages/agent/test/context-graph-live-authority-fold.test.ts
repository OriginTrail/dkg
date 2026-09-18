import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ContextGraphLiveAuthorityUnsupportedError,
  MockChainAdapter,
  type ContextGraphLiveAuthority,
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

  it('falls back to the three point reads when the single read cannot answer, and says so', async () => {
    const deps = dependencies({
      readLiveAuthority: vi.fn(async () => { throw new ContextGraphLiveAuthorityUnsupportedError('tuple layout'); }),
    });
    await expect(resolveLiveOnChainAccessPolicyState(deps, '7')).resolves.toEqual({
      kind: 'available',
      accessPolicy: 1,
    });
    expect(deps.isContextGraphActiveOnChain).toHaveBeenCalledTimes(1);
    expect(deps.getContextGraphAccessPolicy).toHaveBeenCalledTimes(1);
    // Never silent: on a permanent fault this path costs four reads per
    // resolution, and an operator has to be able to see that and why.
    expect(deps.warn).toHaveBeenCalledTimes(1);
    expect(deps.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/readLiveOnChainAccessPolicy\(7\).*falling back to the point reads.*tuple layout/),
    );
  });

  it('rate-limits the fallback warning through its claim, and still falls back when quiet', async () => {
    const deps = dependencies({
      readLiveAuthority: vi.fn(async () => { throw new ContextGraphLiveAuthorityUnsupportedError('tuple layout'); }),
      claimLiveAuthorityFallbackWarning: vi.fn(() => false),
    });
    await expect(resolveLiveOnChainAccessPolicyState(deps, '7')).resolves.toEqual({
      kind: 'available',
      accessPolicy: 1,
    });
    expect(deps.claimLiveAuthorityFallbackWarning).toHaveBeenCalledTimes(1);
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('truncates the cause: a decode failure quotes the whole return payload', async () => {
    const payload = `value="0x${'ab'.repeat(4_000)}"`;
    const deps = dependencies({
      readLiveAuthority: vi.fn(async () => { throw new ContextGraphLiveAuthorityUnsupportedError(payload); }),
    });
    await resolveLiveOnChainAccessPolicyState(deps, '7');
    const message = vi.mocked(deps.warn).mock.calls[0][1];
    expect(message.length).toBeLessThan(500);
    expect(message).toMatch(/… \(\d+ chars\)$/);
  });

  it('stays quiet on the normal single-read path', async () => {
    const deps = dependencies({
      readLiveAuthority: vi.fn(async () => ({ active: true, accessPolicy: 0, participantAgents: [] })),
    });
    await resolveLiveOnChainAccessPolicyState(deps, '7');
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it('propagates a transient failure exactly like a rejected liveness read', async () => {
    const deps = dependencies({
      readLiveAuthority: vi.fn(async () => { throw new Error('socket hang up'); }),
    });
    await expect(resolveLiveOnChainAccessPolicyState(deps, '7')).rejects.toThrow('socket hang up');
    expect(deps.isContextGraphActiveOnChain).not.toHaveBeenCalled();
  });

  it('maps a bounded-read timeout to the retryable timeout reason, with a warning', async () => {
    const deps = dependencies({
      readLiveAuthority: vi.fn(async () => ({ active: true, accessPolicy: 1, participantAgents: [MEMBER] })),
      runBoundedRead: async () => ({ kind: 'timeout' }),
    });
    const state = await resolveLiveOnChainAccessPolicyState(deps, '7');
    expect(state).toMatchObject({ kind: 'unavailable', reason: 'chain-access-policy-timeout' });
    expect((state as { detail?: string }).detail).toContain('getContextGraphLiveAuthority(7) timed out');
    expect(deps.warn).toHaveBeenCalledTimes(1);
    // A timeout is not an answer: nothing may be cached, and the point reads
    // must not be tried as if the single read had failed for good.
    expect(deps.cacheAccessPolicy).not.toHaveBeenCalled();
    expect(deps.isContextGraphActiveOnChain).not.toHaveBeenCalled();
  });

  it('carries the roster only with a PRIVATE policy', async () => {
    const deps = dependencies({
      readLiveAuthority: vi.fn(async () => ({ active: true, accessPolicy: 0, participantAgents: [MEMBER] })),
    });
    // A public graph has no roster consumer; nothing should travel with it.
    await expect(resolveLiveOnChainAccessPolicyState(deps, '7')).resolves.toEqual({
      kind: 'available',
      accessPolicy: 0,
    });
  });

  it('answers a public graph even when the adapter sent no roster at all', async () => {
    const deps = dependencies({
      // The roster is irrelevant to a public answer, so its absence must not
      // turn that answer into a throw (and from there into a retryable fault).
      readLiveAuthority: vi.fn(async () => (
        { active: true, accessPolicy: 0 } as unknown as ContextGraphLiveAuthority
      )),
    });
    await expect(resolveLiveOnChainAccessPolicyState(deps, '7')).resolves.toEqual({
      kind: 'available',
      accessPolicy: 0,
    });
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

  it('keeps a malformed roster TERMINAL on the single-read path', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FoldInvalidRoster', chainAdapter: chain });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue({ kind: 'registered', onChainId: 7n, provenance: 'numeric-id' });
    // Deliberately NOT iterable: a string would spread into characters and be
    // rejected downstream by address validation, hiding a missing shape check.
    vi.spyOn(chain, 'getContextGraphLiveAuthority').mockResolvedValue({
      active: true,
      accessPolicy: 1,
      participantAgents: { length: 1 } as unknown as string[],
    });

    // The three-read path answered a malformed roster with the terminal
    // `invalid` reason. Surfacing it as a retryable policy failure instead
    // would make a permanently-broken roster retry forever.
    await expect(agent.resolveRegisteredContextGraphAuthority('cg')).resolves.toEqual({
      kind: 'unavailable',
      onChainId: 7n,
      reason: 'chain-participant-authority-invalid',
    });
  });

  it('keeps a malformed roster ENTRY terminal on the single-read path', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FoldInvalidRosterEntry', chainAdapter: chain });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue({ kind: 'registered', onChainId: 7n, provenance: 'numeric-id' });
    vi.spyOn(chain, 'getContextGraphLiveAuthority').mockResolvedValue({
      active: true, accessPolicy: 1, participantAgents: ['did:dkg:agent:wrong'],
    });

    await expect(agent.resolveRegisteredContextGraphAuthority('cg')).resolves.toEqual({
      kind: 'unavailable',
      onChainId: 7n,
      reason: 'chain-participant-authority-invalid',
    });
  });

  it('keeps a malformed roster TERMINAL on the three-read fallback path too', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FoldFallbackInvalidRoster', chainAdapter: chain });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue({ kind: 'registered', onChainId: 7n, provenance: 'numeric-id' });
    vi.spyOn(chain, 'getContextGraphLiveAuthority')
      .mockRejectedValue(new ContextGraphLiveAuthorityUnsupportedError('tuple layout'));
    vi.spyOn(chain, 'isContextGraphActiveOnChain').mockResolvedValue(true);
    vi.spyOn(chain, 'getContextGraphAccessPolicy').mockResolvedValue(1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents')
      .mockResolvedValue('not-an-array' as unknown as string[]);

    await expect(agent.resolveRegisteredContextGraphAuthority('cg')).resolves.toEqual({
      kind: 'unavailable',
      onChainId: 7n,
      reason: 'chain-participant-authority-invalid',
    });
  });

  it('still takes the three point reads when the getter is unsupported', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FoldFallback', chainAdapter: chain });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue({ kind: 'registered', onChainId: 7n, provenance: 'numeric-id' });
    vi.spyOn(chain, 'getContextGraphLiveAuthority')
      .mockRejectedValue(new ContextGraphLiveAuthorityUnsupportedError('tuple layout'));
    vi.spyOn(chain, 'isContextGraphActiveOnChain').mockResolvedValue(true);
    vi.spyOn(chain, 'getContextGraphAccessPolicy').mockResolvedValue(1);
    const roster = vi.spyOn(chain, 'getContextGraphParticipantAgents').mockResolvedValue([MEMBER]);

    await expect(agent.resolveRegisteredContextGraphAuthority('cg')).resolves.toMatchObject({
      kind: 'private',
      participantAgents: [MEMBER],
    });
    expect(roster).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected roster read on the fallback leg as the retryable roster reason', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FoldFallbackRosterDown', chainAdapter: chain });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue({ kind: 'registered', onChainId: 7n, provenance: 'numeric-id' });
    vi.spyOn(chain, 'getContextGraphLiveAuthority')
      .mockRejectedValue(new ContextGraphLiveAuthorityUnsupportedError('tuple layout'));
    vi.spyOn(chain, 'isContextGraphActiveOnChain').mockResolvedValue(true);
    vi.spyOn(chain, 'getContextGraphAccessPolicy').mockResolvedValue(1);
    vi.spyOn(chain, 'getContextGraphParticipantAgents').mockRejectedValue(new Error('socket hang up'));

    await expect(agent.resolveRegisteredContextGraphAuthority('cg')).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'chain-participant-authority-unavailable',
    });
  });

  it('writes the fallback warning at most once a minute, however hot the path', async () => {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name: 'FoldFallbackWarnRate', chainAdapter: chain });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue({ kind: 'registered', onChainId: 7n, provenance: 'numeric-id' });
    vi.spyOn(chain, 'getContextGraphLiveAuthority')
      .mockRejectedValue(new ContextGraphLiveAuthorityUnsupportedError('tuple layout'));
    vi.spyOn(chain, 'isContextGraphActiveOnChain').mockResolvedValue(true);
    vi.spyOn(chain, 'getContextGraphAccessPolicy').mockResolvedValue(0);
    const warn = vi.spyOn((agent as unknown as { log: { warn: (...args: unknown[]) => void } }).log, 'warn')
      .mockImplementation(() => {});
    const fallbackWarnings = () => warn.mock.calls
      .filter(([, message]) => String(message).includes('falling back to the point reads')).length;

    const start = Date.now();
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(start);
      await agent.resolveRegisteredContextGraphAuthority('cg');
      await agent.resolveRegisteredContextGraphAuthority('cg');
      expect(fallbackWarnings()).toBe(1);

      clock.mockReturnValue(start + 59_999);
      await agent.resolveRegisteredContextGraphAuthority('cg');
      expect(fallbackWarnings()).toBe(1);

      clock.mockReturnValue(start + 60_000);
      await agent.resolveRegisteredContextGraphAuthority('cg');
      expect(fallbackWarnings()).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });
});

/**
 * One binder now serves all three agent-bound reads, so a single slip would
 * drop cancellation - or the adapter's `this` - for all of them at once.
 */
describe('agent-bound chain reads keep their arity, signal and receiver', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) await agent.stop().catch(() => undefined);
    agent = null;
  });

  async function boundAgent(name: string) {
    const chain = new MockChainAdapter();
    agent = await DKGAgent.create({ name, chainAdapter: chain });
    vi.spyOn(agent, 'resolveContextGraphRegistrationBinding')
      .mockResolvedValue({ kind: 'registered', onChainId: 7n, provenance: 'numeric-id' });
    return { agent, chain };
  }

  it('hands the caller signal to the single read, called ON the adapter', async () => {
    const { agent: bound, chain } = await boundAgent('BinderLive');
    const live = vi.spyOn(chain, 'getContextGraphLiveAuthority')
      .mockResolvedValue({ active: true, accessPolicy: 0, participantAgents: [] });
    const { signal } = new AbortController();

    await bound.resolveRegisteredContextGraphAuthority('cg', { signal });
    expect(live.mock.calls[0]).toEqual([7n, { signal }]);
    // Identity, not shape: two different AbortSignals are deep-equal.
    expect((live.mock.calls[0][1] as { signal?: AbortSignal }).signal).toBe(signal);
    expect(live.mock.contexts[0]).toBe(chain);
  });

  it('hands it to both point reads on the fallback leg too', async () => {
    const { agent: bound, chain } = await boundAgent('BinderPointReads');
    vi.spyOn(chain, 'getContextGraphLiveAuthority')
      .mockRejectedValue(new ContextGraphLiveAuthorityUnsupportedError('tuple layout'));
    const liveness = vi.spyOn(chain, 'isContextGraphActiveOnChain').mockResolvedValue(true);
    const policy = vi.spyOn(chain, 'getContextGraphAccessPolicy').mockResolvedValue(0);
    const { signal } = new AbortController();

    await bound.resolveRegisteredContextGraphAuthority('cg', { signal });
    expect(liveness.mock.calls[0]).toEqual([7n, { signal }]);
    expect(policy.mock.calls[0]).toEqual([7n, { signal }]);
    expect((liveness.mock.calls[0][1] as { signal?: AbortSignal }).signal).toBe(signal);
    expect((policy.mock.calls[0][1] as { signal?: AbortSignal }).signal).toBe(signal);
    expect(liveness.mock.contexts[0]).toBe(chain);
    expect(policy.mock.contexts[0]).toBe(chain);
  });
});
