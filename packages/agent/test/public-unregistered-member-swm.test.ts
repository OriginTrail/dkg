// SPDX-License-Identifier: Apache-2.0
//
// #2827: after a member joined a PUBLIC context graph that was never registered
// on chain, every SWM share failed in both directions:
//   - the joined member resolved its SWM authority as unavailable, because a
//     graph it did not create has no local-first shortcut and its finalized
//     name absence was not accepted as "unregistered" (only reads accepted it);
//   - the curator treated the allowlist the join approval wrote as a read gate
//     and switched SWM to sender-key encryption on a public graph.
// These tests pin the corrected decisions on the crypto side, and that they
// stay fail-closed for accepted PRIVATE policies, for graphs without an
// accepted policy, and for a name that was registered after the owner-signed
// public snapshot was accepted. The curator snapshot acceptance is covered in
// cg-resolve-refresh.test.ts.

import { describe, expect, it, vi } from 'vitest';

import { WorkspaceCryptoMethods } from '../src/dkg-agent-crypto.js';

const CG = '0x1111111111111111111111111111111111111111/public-p2p';
const CURATOR = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const MEMBER = '0x2222222222222222222222222222222222222222';
const STALE_MEMBER = '0x3333333333333333333333333333333333333333';
const MEMBER_KEY = `0x${'11'.repeat(32)}`;

type LiveState = 0 | 1 | 'unregistered' | 'unknown';

interface RegisteredAuthorityOptions {
  allowAcceptedRfc64FinalizedAbsence?: boolean;
}

/**
 * Mirrors the registry for a node that did not create the graph: exact
 * finalized name absence is "unregistered" only when the caller accepts it.
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
  liveState?: LiveState | Error;
  creator?: boolean;
  publicOnChain?: boolean;
}) {
  const registry = nonCreatorRegistry();
  const store = { query: vi.fn(async () => ({ type: 'bindings' as const, bindings: [] })) };
  const memberRecord = { agentAddress: MEMBER, privateKey: MEMBER_KEY };
  const getCgMeta = vi.fn(async () => ({
    allowedAgents: options.allowedAgents ?? [],
    participantAgents: [],
    revokedAgents: [],
  }));
  const resolveOnChainAccessPolicyState = vi.fn(async (): Promise<LiveState> => {
    const state = options.liveState ?? 'unregistered';
    if (state instanceof Error) throw state;
    return state;
  });
  const isContextGraphPublicOnChain = vi.fn(async () => options.publicOnChain === true);
  const warn = vi.fn();
  const agent = {
    resolveContextGraphAgentGateAuthority:
      WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority,
    swmAcceptedAbsenceOption: WorkspaceCryptoMethods.prototype.swmAcceptedAbsenceOption,
    isContextGraphSwmPublic: WorkspaceCryptoMethods.prototype.isContextGraphSwmPublic,
    resolveRegisteredContextGraphAuthority: registry.resolve,
    // A public graph has no RFC-64 private roster.
    resolveRfc64PrivateReadRosterV1: () => undefined,
    getCgMeta,
    subscribedContextGraphs: new Map(),
    hasAcceptedRfc64UnregisteredAuthorityV1: () => options.acceptedUnregistered,
    hasAcceptedRfc64PublicUnregisteredAuthorityV1: () => (
      options.acceptedUnregistered && options.acceptedPublic === true
    ),
    localContextGraphProvenance: { hasLocalCreate: () => options.creator === true },
    isLocalFirstUnregisteredContextGraph: async () => options.creator === true,
    resolveOnChainAccessPolicyState,
    isContextGraphPublicOnChain,
    log: { warn },
    store,
    localAgents: new Map([[MEMBER, memberRecord]]),
    getWorkspaceGossipSigningAgent: () => memberRecord,
  };
  return { agent, registry, store, getCgMeta, resolveOnChainAccessPolicyState, isContextGraphPublicOnChain, warn };
}

const resolveRecipients = (agent: unknown) => WorkspaceCryptoMethods.prototype
  .resolveWorkspaceAgentRecipientsForCurrentAuthority.call(agent as never, { contextGraphId: CG });

describe('SWM authority for a joined member of an unregistered graph (#2827)', () => {
  it('resolves the agent gate from an accepted owner-signed public policy instead of failing closed', async () => {
    const { agent, registry } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: true,
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

  it('keeps an accepted PRIVATE owner-signed policy fail-closed on the gate', async () => {
    // Its roster is the accepted RFC-64 one, not the legacy projection the
    // accepted-absence path would fall back to.
    const { agent, registry } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: false,
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

  it('lets the joined member sign its own SWM writes', async () => {
    const { agent } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: true,
      allowedAgents: [CURATOR, MEMBER],
    });

    const signer = await WorkspaceCryptoMethods.prototype.resolveWorkspaceGossipSigningAgent.call(
      agent as never,
      CG,
    );

    expect(signer?.agentAddress).toBe(MEMBER);
  });

  it('serves member recovery from the local gate once the owner-signed public policy is accepted', async () => {
    const { agent, registry } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: true,
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

  it('denies member recovery without an accepted owner-signed public policy, without reading local metadata', async () => {
    const { agent, registry, getCgMeta } = joinedMember({
      acceptedUnregistered: false,
      allowedAgents: [CURATOR, MEMBER],
    });

    const gate = await WorkspaceCryptoMethods.prototype.getMemberRecoveryGate.call(
      agent as never,
      CG,
    );

    expect(gate).toBeNull();
    expect(getCgMeta).not.toHaveBeenCalled();
    expect(registry.calls).toEqual([
      expect.objectContaining({ allowAcceptedRfc64FinalizedAbsence: false }),
    ]);
  });
});

describe('SWM encryption on an unregistered public graph (#2827)', () => {
  it('stays plaintext while the name is still unregistered, despite the join allowlist', async () => {
    const { agent, registry, store, resolveOnChainAccessPolicyState } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: true,
      allowedAgents: [CURATOR, MEMBER],
      liveState: 'unregistered',
    });

    const resolution = await resolveRecipients(agent);

    expect(resolution).toEqual({ requiresEncryption: false, recipients: [] });
    // The store resolver treats any allowlist as a read gate; it must not run.
    expect(store.query).not.toHaveBeenCalled();
    expect(resolveOnChainAccessPolicyState).toHaveBeenCalledTimes(1);
    expect(registry.calls).toEqual([
      expect.objectContaining({ allowAcceptedRfc64FinalizedAbsence: true }),
    ]);
  });

  it('lets the creator decide plaintext locally, without a chain read', async () => {
    // A graph stays local-first until its own creator registers it; SWM must
    // not depend on the chain meanwhile.
    const { agent, store, resolveOnChainAccessPolicyState } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: true,
      creator: true,
      liveState: new Error('chain unreachable'),
    });

    const resolution = await resolveRecipients(agent);

    expect(resolution).toEqual({ requiresEncryption: false, recipients: [] });
    expect(resolveOnChainAccessPolicyState).not.toHaveBeenCalled();
    expect(store.query).not.toHaveBeenCalled();
  });

  it('fails closed when the name was registered private after the public snapshot was accepted', async () => {
    const { agent, store } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: true,
      allowedAgents: [CURATOR, MEMBER],
      liveState: 1,
    });

    await expect(resolveRecipients(agent)).rejects.toMatchObject({
      reason: 'chain-access-policy-unavailable',
    });
    expect(store.query).not.toHaveBeenCalled();
  });

  it('gives a stale local member no key for an accepted PRIVATE graph', async () => {
    // The accepted RFC-64 roster dropped STALE_MEMBER while the local `_meta`
    // projection still lists it: the legacy store roster must not be used.
    const { agent, store, registry } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: false,
      allowedAgents: [CURATOR, STALE_MEMBER],
    });

    await expect(resolveRecipients(agent)).rejects.toMatchObject({
      reason: 'finalized-name-absence-unaccepted',
    });
    expect(store.query).not.toHaveBeenCalled();
    expect(registry.calls).toEqual([
      expect.objectContaining({ allowAcceptedRfc64FinalizedAbsence: false }),
    ]);
  });

  it('fails closed without an accepted policy, without reading local metadata', async () => {
    const { agent, store, registry } = joinedMember({
      acceptedUnregistered: false,
      allowedAgents: [CURATOR, MEMBER],
    });

    await expect(resolveRecipients(agent)).rejects.toMatchObject({
      reason: 'finalized-name-absence-unaccepted',
    });
    expect(store.query).not.toHaveBeenCalled();
    expect(registry.calls).toEqual([
      expect.objectContaining({ allowAcceptedRfc64FinalizedAbsence: false }),
    ]);
  });
});

describe('isContextGraphSwmPublic: one plaintext predicate for sender and receiver (#2827)', () => {
  it('is exactly the on-chain probe without an accepted owner-signed public policy', async () => {
    const { agent, isContextGraphPublicOnChain, resolveOnChainAccessPolicyState } = joinedMember({
      acceptedUnregistered: false,
      publicOnChain: true,
    });

    await expect(WorkspaceCryptoMethods.prototype.isContextGraphSwmPublic.call(agent as never, CG))
      .resolves.toBe(true);
    expect(isContextGraphPublicOnChain).toHaveBeenCalledTimes(1);
    expect(resolveOnChainAccessPolicyState).not.toHaveBeenCalled();
  });

  it('answers public for a registered-public name even with an accepted owner-signed policy', async () => {
    const { agent } = joinedMember({ acceptedUnregistered: true, acceptedPublic: true, liveState: 0 });

    await expect(WorkspaceCryptoMethods.prototype.isContextGraphSwmPublic.call(agent as never, CG))
      .resolves.toBe(true);
  });

  it('lets a later private registration override the accepted public snapshot', async () => {
    const { agent } = joinedMember({ acceptedUnregistered: true, acceptedPublic: true, liveState: 1 });

    await expect(WorkspaceCryptoMethods.prototype.isContextGraphSwmPublic.call(agent as never, CG))
      .resolves.toBe(false);
  });

  it('fails closed when the chain cannot confirm the name is unregistered', async () => {
    const unknown = joinedMember({ acceptedUnregistered: true, acceptedPublic: true, liveState: 'unknown' });
    await expect(WorkspaceCryptoMethods.prototype.isContextGraphSwmPublic.call(unknown.agent as never, CG))
      .resolves.toBe(false);

    const failing = joinedMember({ acceptedUnregistered: true, acceptedPublic: true, liveState: new Error('rpc down') });
    await expect(WorkspaceCryptoMethods.prototype.isContextGraphSwmPublic.call(failing.agent as never, CG))
      .resolves.toBe(false);
    expect(failing.warn).toHaveBeenCalledTimes(1);
  });
});
