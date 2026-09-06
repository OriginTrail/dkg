import { describe, expect, it, vi } from 'vitest';
import {
  resolveLiveOnChainAccessPolicyState,
  type LiveOnChainAccessPolicyDependencies,
} from '../src/internal/context-graph-authority/context-graph-access-policy.js';
import {
  CONTEXT_GRAPH_AGENT_GATE_UNAVAILABLE_REASONS,
  ContextGraphAuthorityUnavailableError,
  isContextGraphAuthorityUnavailableMarker,
} from
  '../src/internal/context-graph-authority/context-graph-authority.js';
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
  it.each(CONTEXT_GRAPH_AGENT_GATE_UNAVAILABLE_REASONS)(
    'recognizes canonical authority reason %s at the runtime marker boundary',
    (reason) => {
      expect(isContextGraphAuthorityUnavailableMarker({
        code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
        reason,
      })).toBe(true);
    },
  );

  it('rejects reasons outside the canonical runtime registry', () => {
    expect(isContextGraphAuthorityUnavailableMarker({
      code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
      reason: 'unknown-authority-reason',
    })).toBe(false);
  });

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
      const error = new ContextGraphAuthorityUnavailableError('policy unavailable', authority);
      expect(error).toMatchObject({ reason: 'chain-access-policy-unknown' });
      expect('retryable' in error).toBe(false);
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
      const error = new ContextGraphAuthorityUnavailableError('policy unavailable', authority);
      expect(error).toMatchObject({
        reason: 'chain-access-policy-timeout',
        detail: expect.stringContaining(`${readName}(7) timed out`),
      });
      expect('retryable' in error).toBe(false);
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
