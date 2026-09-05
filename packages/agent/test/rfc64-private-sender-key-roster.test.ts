import { describe, expect, it, vi } from 'vitest';
import {
  ContextGraphAuthorityUnavailableError,
  isContextGraphAuthorityUnavailableError,
} from '../src/context-graph-authority-unavailable-error.js';
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
      retryable: true,
    });
  });

  it('marks an unavailable signing authority so durable promotion can retry it', async () => {
    const receiver = {
      resolveContextGraphAgentGateAuthority: async () => ({
        kind: 'unavailable' as const,
        reason: 'rfc64-private-read-roster-unavailable' as const,
        retryable: true,
      }),
      localAgents: new Map(),
    };

    const error = await WorkspaceCryptoMethods.prototype.resolveWorkspaceGossipSigningAgent.call(
      receiver as never,
      CG,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ContextGraphAuthorityUnavailableError);
    expect(error).toMatchObject({
      code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
      reason: 'rfc64-private-read-roster-unavailable',
    });
    expect(isContextGraphAuthorityUnavailableError(error)).toBe(true);
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

  it('does not mark authoritative empty or unsupported authority as retryable', async () => {
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
    expect(isContextGraphAuthorityUnavailableError(signingError)).toBe(false);
    expect(recipientError).toBeInstanceOf(Error);
    expect(recipientError).toMatchObject({ message: expect.stringContaining('unsupported') });
    expect(isContextGraphAuthorityUnavailableError(recipientError)).toBe(false);
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
