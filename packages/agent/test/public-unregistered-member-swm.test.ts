// SPDX-License-Identifier: Apache-2.0
//
// #2827: after a member joined a PUBLIC context graph that was never registered
// on chain, every SWM share failed in both directions:
//   - the joined member resolved its SWM authority as unavailable, because a
//     graph it did not create has no local-first shortcut and its finalized
//     name absence was not accepted as "unregistered" (only reads accepted it);
//   - the curator treated the allowlist the join approval wrote as a read gate
//     and switched SWM to sender-key encryption on a public graph.
// These tests pin the corrected decisions on the crypto side. The curator
// snapshot acceptance is covered in cg-resolve-refresh.test.ts.

import { describe, expect, it, vi } from 'vitest';

import { WorkspaceCryptoMethods } from '../src/dkg-agent-crypto.js';

const CG = '0x1111111111111111111111111111111111111111/public-p2p';
const CURATOR = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const MEMBER = '0x2222222222222222222222222222222222222222';
const MEMBER_KEY = `0x${'11'.repeat(32)}`;

interface RegisteredAuthorityOptions {
  allowAcceptedRfc64FinalizedAbsence?: boolean;
}

/**
 * Mirrors the registry for a node that did not create the graph: exact
 * finalized name absence is "unregistered" only when the caller has accepted
 * the owner-signed unregistered policy.
 */
function nonCreatorRegistry() {
  const calls: RegisteredAuthorityOptions[] = [];
  const resolve = async (_contextGraphId: string, options: RegisteredAuthorityOptions = {}) => {
    calls.push(options);
    return options.allowAcceptedRfc64FinalizedAbsence === true
      ? { kind: 'unregistered' as const }
      : {
          kind: 'unavailable' as const,
          reason: 'finalized-name-absence-unaccepted' as const,
          detail: 'finalized name absence has no accepted owner-signed unregistered authority',
        };
  };
  return { resolve, calls };
}

function joinedMember(options: {
  acceptedUnregistered: boolean;
  acceptedPublic?: boolean;
  allowedAgents?: string[];
}) {
  const registry = nonCreatorRegistry();
  const store = { query: vi.fn(async () => ({ type: 'bindings' as const, bindings: [] })) };
  const memberRecord = { agentAddress: MEMBER, privateKey: MEMBER_KEY };
  const agent = {
    resolveContextGraphAgentGateAuthority:
      WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority,
    resolveRegisteredContextGraphAuthority: registry.resolve,
    // A public graph has no RFC-64 private roster.
    resolveRfc64PrivateReadRosterV1: () => undefined,
    getCgMeta: async () => ({
      allowedAgents: options.allowedAgents ?? [],
      participantAgents: [],
      revokedAgents: [],
    }),
    subscribedContextGraphs: new Map(),
    hasAcceptedRfc64UnregisteredAuthorityV1: () => options.acceptedUnregistered,
    hasAcceptedRfc64PublicUnregisteredAuthorityV1: () => (
      options.acceptedUnregistered && options.acceptedPublic === true
    ),
    store,
    localAgents: new Map([[MEMBER, memberRecord]]),
    getWorkspaceGossipSigningAgent: () => memberRecord,
  };
  return { agent, registry, store };
}

describe('SWM authority for a joined member of an unregistered graph (#2827)', () => {
  it('resolves the agent gate from the accepted owner-signed policy instead of failing closed', async () => {
    const { agent, registry } = joinedMember({
      acceptedUnregistered: true,
      allowedAgents: [CURATOR, MEMBER],
    });

    const gate = await WorkspaceCryptoMethods.prototype.getContextGraphAgentGateAddresses.call(
      agent as never,
      CG,
    );

    expect(gate).toEqual([CURATOR, MEMBER]);
    expect(registry.calls).toEqual([
      expect.objectContaining({ allowAcceptedRfc64FinalizedAbsence: true }),
    ]);
  });

  it('keeps failing closed while no owner-signed policy is accepted', async () => {
    const { agent, registry } = joinedMember({
      acceptedUnregistered: false,
      allowedAgents: [CURATOR, MEMBER],
    });

    const authority = await WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority.call(
      agent as never,
      CG,
    );

    expect(authority).toEqual(expect.objectContaining({
      kind: 'unavailable',
      reason: 'finalized-name-absence-unaccepted',
    }));
    expect(registry.calls).toEqual([
      expect.objectContaining({ allowAcceptedRfc64FinalizedAbsence: false }),
    ]);
  });

  it("lets the joined member sign its own SWM writes", async () => {
    const { agent } = joinedMember({
      acceptedUnregistered: true,
      allowedAgents: [CURATOR, MEMBER],
    });

    const signer = await WorkspaceCryptoMethods.prototype.resolveWorkspaceGossipSigningAgent.call(
      agent as never,
      CG,
    );

    expect(signer?.agentAddress).toBe(MEMBER);
  });

  it('serves member recovery from the local gate once the owner-signed policy is accepted', async () => {
    const { agent, registry } = joinedMember({
      acceptedUnregistered: true,
      allowedAgents: [CURATOR, MEMBER],
    });

    const gate = await WorkspaceCryptoMethods.prototype.getMemberRecoveryGate.call(
      agent as never,
      CG,
    );

    expect(gate).toEqual([CURATOR, MEMBER]);
    expect(registry.calls).toEqual([
      expect.objectContaining({ allowAcceptedRfc64FinalizedAbsence: true }),
    ]);
  });
});

describe('SWM encryption on an unregistered public graph (#2827)', () => {
  it('stays plaintext when the accepted owner-signed policy is public, despite the join allowlist', async () => {
    const { agent, registry, store } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: true,
      allowedAgents: [CURATOR, MEMBER],
    });

    const resolution = await WorkspaceCryptoMethods.prototype
      .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(agent as never, { contextGraphId: CG });

    expect(resolution).toEqual({ requiresEncryption: false, recipients: [] });
    // The store resolver treats any allowlist as a read gate; it must not run.
    expect(store.query).not.toHaveBeenCalled();
    expect(registry.calls).toEqual([
      expect.objectContaining({ allowAcceptedRfc64FinalizedAbsence: true }),
    ]);
  });

  it('keeps the store resolver when the accepted unregistered policy is not public', async () => {
    const { agent, store } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: false,
    });

    await WorkspaceCryptoMethods.prototype
      .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(agent as never, { contextGraphId: CG });

    expect(store.query).toHaveBeenCalled();
  });
});
