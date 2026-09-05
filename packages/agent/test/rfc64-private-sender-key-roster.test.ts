import { describe, expect, it, vi } from 'vitest';
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
      resolveRegisteredContextGraphAuthority: async () => ({ kind: 'unregistered' as const }),
      resolveRfc64PrivateReadRosterV1: () => [MEMBER_A_LOWERCASE, MEMBER_B, MEMBER_A],
      resolveLocalContextGraphAgentGateAddresses:
        WorkspaceCryptoMethods.prototype.resolveLocalContextGraphAgentGateAddresses,
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
      resolveRegisteredContextGraphAuthority: async () => ({ kind: 'unregistered' as const }),
      resolveRfc64PrivateReadRosterV1: () => null,
      resolveLocalContextGraphAgentGateAddresses:
        WorkspaceCryptoMethods.prototype.resolveLocalContextGraphAgentGateAddresses,
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

  it('preserves legacy meta and subscription resolution for non-RFC-64 graphs', async () => {
    const receiver = {
      resolveRegisteredContextGraphAuthority: async () => ({ kind: 'unregistered' as const }),
      resolveRfc64PrivateReadRosterV1: () => undefined,
      resolveLocalContextGraphAgentGateAddresses:
        WorkspaceCryptoMethods.prototype.resolveLocalContextGraphAgentGateAddresses,
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
