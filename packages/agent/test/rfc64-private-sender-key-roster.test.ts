import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE,
  ContextGraphAuthorityUnavailableError,
  isContextGraphAuthorityUnavailableMarker,
} from '../src/context-graph-authority.js';
import { CHAIN_POLICY_READ_TIMEOUT_MS } from '../src/dkg-agent-constants.js';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import { WorkspaceCryptoMethods } from '../src/dkg-agent-crypto.js';

const CG = '0x1111111111111111111111111111111111111111/private-cg';
const MEMBER_A = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const MEMBER_A_LOWERCASE = '0x8ba1f109551bd432803012645ac136ddd64dba72';
const MEMBER_B = '0x2222222222222222222222222222222222222222';

describe('RFC-64 private Sender Key roster authority', () => {
  it('uses the accepted RFC-64 roster before an empty store has a meta projection', async () => {
    const getCgMeta = vi.fn(async () => {
      throw new Error('legacy metadata must not be required for an RFC-64 cold join');
    });
    const receiver = {
      resolveContextGraphAgentGateAuthority:
        WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority,
      resolveRegisteredContextGraphAuthority: async () => ({ kind: 'unregistered' as const }),
      resolveRfc64PrivateReadRosterV1: () => [MEMBER_A_LOWERCASE, MEMBER_B, MEMBER_A],
      getCgMeta,
      subscribedContextGraphs: new Map(),
    };

    const result = await WorkspaceCryptoMethods.prototype.getContextGraphAgentGateAddresses.call(
      receiver as never,
      CG,
    );

    expect(result).toEqual([MEMBER_A, MEMBER_B]);
    expect(getCgMeta).not.toHaveBeenCalled();
  });

  it('keeps an RFC-64 selected private graph gated while roster authority is unavailable', async () => {
    const getCgMeta = vi.fn(async () => ({
      allowedAgents: [MEMBER_A],
      participantAgents: [],
      revokedAgents: [],
    }));
    const receiver = {
      resolveContextGraphAgentGateAuthority:
        WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority,
      resolveRegisteredContextGraphAuthority: async () => ({ kind: 'unregistered' as const }),
      resolveRfc64PrivateReadRosterV1: () => null,
      getCgMeta,
      subscribedContextGraphs: new Map(),
    };

    const result = await WorkspaceCryptoMethods.prototype.getContextGraphAgentGateAddresses.call(
      receiver as never,
      CG,
    );

    expect(result).toEqual([]);
    expect(getCgMeta).not.toHaveBeenCalled();
  });

  it('distinguishes an authoritative empty registered roster from an authority outage', async () => {
    const availableReceiver = {
      resolveRegisteredContextGraphAuthority: async () => ({
        kind: 'private' as const,
        onChainId: 7n,
        participantAgents: [],
      }),
    };
    const unavailableReceiver = {
      resolveRegisteredContextGraphAuthority: async () => ({
        kind: 'unavailable' as const,
        reason: 'chain-participant-authority-unavailable' as const,
      }),
    };

    await expect(WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority.call(
      availableReceiver as never,
      CG,
    )).resolves.toEqual({ kind: 'available', agentAddresses: [] });
    await expect(WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority.call(
      unavailableReceiver as never,
      CG,
    )).resolves.toEqual({
      kind: 'unavailable',
      reason: 'chain-participant-authority-unavailable',
    });
  });

  it('preserves every registered-authority reason without adding caller retry policy', async () => {
    const cases = [
      'chain-name-binding-unavailable',
      'local-chain-binding-unavailable',
      'local-existence-unavailable',
      'chain-access-policy-unavailable',
      'chain-access-policy-timeout',
      'chain-access-policy-unknown',
      'chain-participant-authority-unsupported',
      'chain-participant-authority-unavailable',
      'chain-participant-authority-invalid',
    ] as const;

    for (const reason of cases) {
      const receiver = {
        resolveContextGraphAgentGateAuthority:
          WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority,
        resolveRegisteredContextGraphAuthority: async () => ({
          kind: 'unavailable' as const,
          reason,
        }),
        localAgents: new Map(),
      };

      await expect(WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority.call(
        receiver as never,
        CG,
      )).resolves.toEqual({ kind: 'unavailable', reason });

      const outcome = await WorkspaceCryptoMethods.prototype.resolveWorkspaceGossipSigningAgent.call(
        receiver as never,
        CG,
      ).then(
        value => ({ status: 'fulfilled' as const, value }),
        error => ({ status: 'rejected' as const, error: error as unknown }),
      );

      expect(outcome.status, reason).toBe('rejected');
      if (outcome.status !== 'rejected') continue;
      expect(outcome.error, reason).toBeInstanceOf(ContextGraphAuthorityUnavailableError);
      expect(outcome.error, reason).toMatchObject({ reason });
      expect('retryable' in Object(outcome.error), reason).toBe(false);
      expect(isContextGraphAuthorityUnavailableMarker(outcome.error), reason).toBe(true);
    }
  });

  it('preserves bounded liveness and policy timeouts as typed authority unavailability', async () => {
    vi.useFakeTimers();
    try {
      const raceChainPolicyRead = Reflect.get(
        WorkspaceCryptoMethods.prototype,
        'raceChainPolicyRead',
      ) as (...args: unknown[]) => Promise<unknown>;
      for (const [hangingRead, chain] of [
        [
          'isContextGraphActiveOnChain',
          {
            isContextGraphActiveOnChain: () => new Promise<boolean>(() => {}),
            getContextGraphAccessPolicy: async () => 1 as const,
          },
        ],
        [
          'getContextGraphAccessPolicy',
          {
            isContextGraphActiveOnChain: async () => true,
            getContextGraphAccessPolicy: () => new Promise<0 | 1>(() => {}),
          },
        ],
      ] as const) {
        const receiver = {
          resolveContextGraphAgentGateAuthority:
            WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority,
          resolveRegisteredContextGraphAuthority:
            ContextGraphResolveMethods.prototype.resolveRegisteredContextGraphAuthority,
          resolveLiveOnChainAccessPolicyState:
            WorkspaceCryptoMethods.prototype.resolveLiveOnChainAccessPolicyState,
          resolveContextGraphRegistrationBinding: async () => ({
            kind: 'registered' as const,
            onChainId: 7n,
          }),
          raceChainPolicyRead,
          chain,
          log: { warn: vi.fn() },
          warnedMissingCgLivenessProbe: false,
          onChainAccessPolicyCache: new Map(),
          localAgents: new Map(),
        };

        const errorPromise = WorkspaceCryptoMethods.prototype.resolveWorkspaceGossipSigningAgent.call(
          receiver as never,
          CG,
        ).catch((cause: unknown) => cause);
        await vi.advanceTimersByTimeAsync(CHAIN_POLICY_READ_TIMEOUT_MS);

        await expect(errorPromise).resolves.toMatchObject({
          code: CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE,
          reason: 'chain-access-policy-timeout',
          detail: expect.stringContaining(hangingRead),
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('recognizes only a reason-valid cross-boundary authority failure', () => {
    expect(isContextGraphAuthorityUnavailableMarker(
      new ContextGraphAuthorityUnavailableError('temporarily unavailable', {
        reason: 'chain-participant-authority-unavailable',
      }),
    )).toBe(true);
    expect(isContextGraphAuthorityUnavailableMarker({
      code: CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE,
      reason: 'chain-participant-authority-unavailable',
    })).toBe(true);
    expect(isContextGraphAuthorityUnavailableMarker({
      code: CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE,
    })).toBe(false);
    expect(isContextGraphAuthorityUnavailableMarker({
      code: CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE,
      reason: 'chain-participant-authority-unsupported',
      retryable: true,
    })).toBe(true);
    expect(isContextGraphAuthorityUnavailableMarker({
      code: `${CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE}_LOOKALIKE`,
      reason: 'chain-participant-authority-unavailable',
    })).toBe(false);
    expect(isContextGraphAuthorityUnavailableMarker({
      code: CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE,
      reason: 'toString',
      retryable: undefined,
    })).toBe(false);
    expect(isContextGraphAuthorityUnavailableMarker({ reason: 'chain-participant-authority-unavailable' }))
      .toBe(false);
  });

  it('marks an unavailable signing authority so durable promotion can retry it', async () => {
    const getCgMeta = vi.fn(async () => {
      throw new Error('legacy metadata must not mask RFC-64 authority unavailability');
    });
    const receiver = {
      resolveContextGraphAgentGateAuthority:
        WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority,
      resolveRegisteredContextGraphAuthority: async () => ({ kind: 'unregistered' as const }),
      resolveRfc64PrivateReadRosterV1: () => null,
      getCgMeta,
      subscribedContextGraphs: new Map(),
      localAgents: new Map(),
    };

    await expect(WorkspaceCryptoMethods.prototype.getContextGraphAgentGateAddresses.call(
      receiver as never,
      CG,
    )).resolves.toEqual([]);

    const error = await WorkspaceCryptoMethods.prototype.resolveWorkspaceGossipSigningAgent.call(
      receiver as never,
      CG,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ContextGraphAuthorityUnavailableError);
    expect(error).toMatchObject({
      code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
      reason: 'rfc64-private-read-roster-unavailable',
    });
    expect(isContextGraphAuthorityUnavailableMarker(error)).toBe(true);
    expect(getCgMeta).not.toHaveBeenCalled();
  });

  it('marks an unavailable recipient authority so durable promotion can retry it', async () => {
    const receiver = {
      resolveRegisteredContextGraphAuthority: async () => ({
        kind: 'unavailable' as const,
        reason: 'chain-access-policy-unavailable' as const,
      }),
    };

    await expect(WorkspaceCryptoMethods.prototype.resolveWorkspaceAgentRecipientsForCurrentAuthority.call(
      receiver as never,
      { contextGraphId: CG },
    )).rejects.toMatchObject({
      code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
    });
  });

  it('keeps authoritative empty and unsupported authority terminal', async () => {
    const emptySigningReceiver = {
      resolveContextGraphAgentGateAuthority: async () => ({
        kind: 'available' as const,
        agentAddresses: [],
      }),
      localAgents: new Map(),
    };
    const unsupportedRecipientReceiver = {
      resolveRegisteredContextGraphAuthority: async () => ({
        kind: 'unavailable' as const,
        reason: 'chain-participant-authority-unsupported' as const,
      }),
    };

    const signingError = await WorkspaceCryptoMethods.prototype.resolveWorkspaceGossipSigningAgent.call(
      emptySigningReceiver as never,
      CG,
    ).catch((cause: unknown) => cause);
    const recipientError = await WorkspaceCryptoMethods.prototype.resolveWorkspaceAgentRecipientsForCurrentAuthority.call(
      unsupportedRecipientReceiver as never,
      { contextGraphId: CG },
    ).catch((cause: unknown) => cause);

    expect(signingError).toBeInstanceOf(Error);
    expect(signingError).toMatchObject({ message: expect.stringContaining('authoritative signing roster is empty') });
    expect(isContextGraphAuthorityUnavailableMarker(signingError)).toBe(false);
    expect(recipientError).toBeInstanceOf(ContextGraphAuthorityUnavailableError);
    expect(recipientError).toMatchObject({
      message: expect.stringContaining('unsupported'),
      reason: 'chain-participant-authority-unsupported',
    });
    expect('retryable' in Object(recipientError)).toBe(false);
    expect(isContextGraphAuthorityUnavailableMarker(recipientError)).toBe(true);
  });

  it('keeps a fully revoked legacy gate authoritative and empty', async () => {
    const receiver = {
      resolveContextGraphAgentGateAuthority:
        WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority,
      resolveRegisteredContextGraphAuthority: async () => ({ kind: 'unregistered' as const }),
      resolveRfc64PrivateReadRosterV1: () => undefined,
      getCgMeta: async () => ({
        allowedAgents: [MEMBER_A],
        participantAgents: [],
        revokedAgents: [MEMBER_A_LOWERCASE],
      }),
      subscribedContextGraphs: new Map(),
    };

    await expect(WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority.call(
      receiver as never,
      'legacy/private-cg',
    )).resolves.toEqual({ kind: 'available', agentAddresses: [] });
  });

  it('preserves legacy meta and subscription resolution for non-RFC-64 graphs', async () => {
    const receiver = {
      resolveContextGraphAgentGateAuthority:
        WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority,
      resolveRegisteredContextGraphAuthority: async () => ({ kind: 'unregistered' as const }),
      resolveRfc64PrivateReadRosterV1: () => undefined,
      getCgMeta: async () => ({
        allowedAgents: [MEMBER_A],
        participantAgents: [],
        revokedAgents: [],
      }),
      subscribedContextGraphs: new Map(),
    };

    const result = await WorkspaceCryptoMethods.prototype.getContextGraphAgentGateAddresses.call(
      receiver as never,
      'legacy/private-cg',
    );

    expect(result).toEqual([MEMBER_A]);
  });
});
