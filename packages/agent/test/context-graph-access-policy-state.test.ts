import { describe, expect, it, vi } from 'vitest';
import {
  resolveLiveOnChainAccessPolicyState,
  type LiveOnChainAccessPolicyDependencies,
} from '../src/internal/promote/context-graph-access-policy-state.js';
import { ContextGraphAuthorityUnavailableError } from
  '../src/internal/promote/context-graph-agent-gate-authority.js';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import { WorkspaceCryptoMethods } from '../src/dkg-agent-crypto.js';

function policyDependencies(
  overrides: Partial<LiveOnChainAccessPolicyDependencies> = {},
): LiveOnChainAccessPolicyDependencies {
  return {
    isContextGraphActiveOnChain: vi.fn(async () => true),
    getContextGraphAccessPolicy: vi.fn(async () => 0),
    runBoundedRead: async (start) => ({ kind: 'value', value: await start() }),
    claimMissingLivenessWarning: vi.fn(() => true),
    warn: vi.fn(),
    cacheAccessPolicy: vi.fn(),
    ...overrides,
  };
}

describe('live access policy to registered authority boundary', () => {
  it.each([
    ['malformed numeric id', 'not-a-number', {}],
    ['zero id', '0', {}],
    ['negative id', '-1', {}],
    ['missing liveness capability', '7', { isContextGraphActiveOnChain: undefined }],
    ['inactive graph', '7', { isContextGraphActiveOnChain: async () => false }],
    ['missing policy capability', '7', { getContextGraphAccessPolicy: undefined }],
    ['invalid policy value', '7', { getContextGraphAccessPolicy: async () => 2 }],
  ] satisfies [string, string, Partial<LiveOnChainAccessPolicyDependencies>][])(
    'keeps %s terminal through authority resolution and legacy null projection',
    async (_label, onChainId, overrides) => {
      const dependencies = policyDependencies(overrides);
      const state = await resolveLiveOnChainAccessPolicyState(dependencies, onChainId);
      expect(state).toEqual({ kind: 'unavailable', reason: 'chain-access-policy-unknown' });
      expect(dependencies.cacheAccessPolicy).not.toHaveBeenCalled();

      const receiver = {
        resolveContextGraphRegistrationBinding: vi.fn(async () => ({
          kind: 'registered', onChainId: 7n,
        })),
        resolveLiveOnChainAccessPolicyState: vi.fn().mockResolvedValue(state),
      };
      const authority = await ContextGraphResolveMethods.prototype
        .resolveRegisteredContextGraphAuthority.call(receiver as never, 'cg-1');
      expect(authority).toEqual({ ...state, onChainId: 7n });
      if (authority.kind !== 'unavailable') throw new Error('Expected unavailable authority');
      expect(new ContextGraphAuthorityUnavailableError('policy unavailable', authority).retryable)
        .toBe(false);
      await expect(WorkspaceCryptoMethods.prototype.readLiveOnChainAccessPolicy.call(
        receiver as never, onChainId,
      )).resolves.toBeNull();
    },
  );

  it.each(['isContextGraphActiveOnChain', 'getContextGraphAccessPolicy'])(
    'preserves %s timeout disposition and diagnostics through both consumers',
    async (readName) => {
      const dependencies = policyDependencies({
        runBoundedRead: async (start, label) => label.startsWith(readName)
          ? { kind: 'timeout' }
          : { kind: 'value', value: await start() },
      });
      const state = await resolveLiveOnChainAccessPolicyState(dependencies, '7');
      expect(state).toEqual({
        kind: 'unavailable',
        reason: 'chain-access-policy-timeout',
        detail: expect.stringContaining(`${readName}(7) timed out`),
      });
      expect(dependencies.warn).toHaveBeenCalledWith(
        expect.anything(), expect.stringContaining(`${readName}(7) timed out`),
      );
      expect(dependencies.cacheAccessPolicy).not.toHaveBeenCalled();

      const receiver = {
        resolveContextGraphRegistrationBinding: vi.fn(async () => ({
          kind: 'registered', onChainId: 7n,
        })),
        resolveLiveOnChainAccessPolicyState: vi.fn().mockResolvedValue(state),
      };
      const authority = await ContextGraphResolveMethods.prototype
        .resolveRegisteredContextGraphAuthority.call(receiver as never, 'cg-1');
      expect(authority).toEqual({ ...state, onChainId: 7n });
      if (authority.kind !== 'unavailable') throw new Error('Expected unavailable authority');
      expect(new ContextGraphAuthorityUnavailableError('policy unavailable', authority).retryable)
        .toBe(true);
      await expect(WorkspaceCryptoMethods.prototype.readLiveOnChainAccessPolicy.call(
        receiver as never, '7',
      )).resolves.toBeNull();
    },
  );

  it.each([0, 1] as const)('caches and projects proven policy %s unchanged', async (accessPolicy) => {
    const dependencies = policyDependencies({ getContextGraphAccessPolicy: async () => accessPolicy });
    const state = await resolveLiveOnChainAccessPolicyState(dependencies, '7');
    expect(state).toEqual({ kind: 'available', accessPolicy });
    expect(dependencies.cacheAccessPolicy).toHaveBeenCalledWith('7', accessPolicy);
    await expect(WorkspaceCryptoMethods.prototype.readLiveOnChainAccessPolicy.call({
      resolveLiveOnChainAccessPolicyState: vi.fn().mockResolvedValue(state),
    } as never, '7')).resolves.toBe(accessPolicy);
  });
});
