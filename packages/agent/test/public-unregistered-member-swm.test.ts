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
// accepted policy, and for a name the finalized index shows registered after
// the owner-signed public snapshot was accepted. The curator snapshot
// acceptance is covered in cg-resolve-refresh.test.ts.

import { describe, expect, it, vi } from 'vitest';

import { WorkspaceCryptoMethods } from '../src/dkg-agent-crypto.js';
import { Rfc64CatalogMethods } from '../src/dkg-agent-rfc64-catalog.js';

const CG = '0x1111111111111111111111111111111111111111/public-p2p';
const CURATOR = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const MEMBER = '0x2222222222222222222222222222222222222222';
const STALE_MEMBER = '0x3333333333333333333333333333333333333333';
const MEMBER_KEY = `0x${'11'.repeat(32)}`;

interface RegisteredAuthorityOptions {
  allowAcceptedRfc64FinalizedAbsence?: boolean;
  authorityReadMode?: string;
}

/** What the finalized authority index reports for the name. */
type IndexState =
  | { kind: 'absent' }
  /** The creator's own graph before its registration commits. */
  | { kind: 'local-first' }
  | { kind: 'public' }
  | { kind: 'private'; participantAgents: string[] }
  | { kind: 'unavailable' };

/**
 * Mirrors the registry: exact finalized name absence is "unregistered" only
 * when the caller accepts it, the creator's graph is local-first until its own
 * registration commits, and a registration the index shows always wins.
 */
function registryOver(index: IndexState) {
  const calls: RegisteredAuthorityOptions[] = [];
  const resolve = vi.fn(async (_contextGraphId: string, options: RegisteredAuthorityOptions = {}) => {
    calls.push(options);
    switch (index.kind) {
      case 'local-first':
        return { kind: 'unregistered' as const };
      case 'absent':
        return options.allowAcceptedRfc64FinalizedAbsence === true
          ? { kind: 'unregistered' as const }
          : {
              kind: 'unavailable' as const,
              reason: 'finalized-name-absence-unaccepted' as const,
              detail: 'finalized name absence has no accepted owner-signed unregistered authority',
            };
      case 'public':
        return { kind: 'public' as const, onChainId: 7n };
      case 'private':
        return { kind: 'private' as const, onChainId: 7n, participantAgents: index.participantAgents };
      case 'unavailable':
        return { kind: 'unavailable' as const, reason: 'chain-access-policy-unavailable' as const };
    }
  });
  return { resolve, calls };
}

function joinedMember(options: {
  acceptedUnregistered: boolean;
  acceptedPublic?: boolean;
  allowedAgents?: string[];
  index?: IndexState;
  registryError?: Error;
  publicOnChain?: boolean;
  /** Whether RFC-64 catalog authority still governs transport (default yes). */
  transportActive?: boolean;
}) {
  const registry = registryOver(options.index ?? { kind: 'absent' });
  if (options.registryError) registry.resolve.mockRejectedValue(options.registryError);
  const store = { query: vi.fn(async () => ({ type: 'bindings' as const, bindings: [] })) };
  const memberRecord = { agentAddress: MEMBER, privateKey: MEMBER_KEY };
  const getCgMeta = vi.fn(async () => ({
    allowedAgents: options.allowedAgents ?? [],
    participantAgents: [],
    revokedAgents: [],
  }));
  const isContextGraphPublicOnChain = vi.fn(async () => options.publicOnChain === true);
  const warn = vi.fn();
  const agent = {
    resolveContextGraphAgentGateAuthority:
      WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority,
    resolveSwmRegisteredAuthority: WorkspaceCryptoMethods.prototype.resolveSwmRegisteredAuthority,
    resolveSwmTransportAuthority: WorkspaceCryptoMethods.prototype.resolveSwmTransportAuthority,
    isContextGraphSwmPublic: WorkspaceCryptoMethods.prototype.isContextGraphSwmPublic,
    resolveRegisteredContextGraphAuthority: registry.resolve,
    // A public graph has no RFC-64 private roster.
    resolveRfc64PrivateReadRosterV1: () => undefined,
    getCgMeta,
    getContextGraphAllowedPeers: async () => null,
    subscribedContextGraphs: new Map(),
    hasAcceptedRfc64UnregisteredAuthorityV1: () => options.acceptedUnregistered,
    // The retained snapshot alone, and the same snapshot behind the live
    // catalog-authority fence: SWM must consult only the fenced one.
    hasAcceptedRfc64PublicUnregisteredAuthorityV1: () => (
      options.acceptedUnregistered && options.acceptedPublic === true
    ),
    hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1: () => (
      options.acceptedUnregistered
      && options.acceptedPublic === true
      && options.transportActive !== false
    ),
    isContextGraphPublicOnChain,
    log: { warn },
    store,
    localAgents: new Map([[MEMBER, memberRecord]]),
    getWorkspaceGossipSigningAgent: () => memberRecord,
  };
  return { agent, registry, store, getCgMeta, isContextGraphPublicOnChain, warn };
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

  // #2831 review: an accepted public snapshot only lets exact name absence
  // count as unregistered. A registration the finalized index shows always
  // wins, so a member the private roster dropped gets neither the gate nor
  // recovery through the old allowlist.
  it('uses the registered private roster, not the old allowlist, once the index shows a private registration', async () => {
    const { agent, getCgMeta } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: true,
      allowedAgents: [CURATOR, STALE_MEMBER],
      index: { kind: 'private', participantAgents: [CURATOR] },
    });

    const gate = await WorkspaceCryptoMethods.prototype.getContextGraphAgentGateAddresses.call(
      agent as never,
      CG,
    );
    const recovery = await WorkspaceCryptoMethods.prototype.getMemberRecoveryGate.call(
      agent as never,
      CG,
    );

    expect(gate).toEqual([CURATOR]);
    expect(recovery).toEqual([CURATOR]);
    expect(getCgMeta).not.toHaveBeenCalled();
  });

  it.each([
    ['registered public', { kind: 'public' } as const],
    ['unavailable', { kind: 'unavailable' } as const],
  ])('denies member recovery through the old allowlist when the index shows the name %s', async (_label, index) => {
    const { agent, getCgMeta } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: true,
      allowedAgents: [CURATOR, STALE_MEMBER],
      index,
    });

    const recovery = await WorkspaceCryptoMethods.prototype.getMemberRecoveryGate.call(
      agent as never,
      CG,
    );

    expect(recovery).toBeNull();
    expect(getCgMeta).not.toHaveBeenCalled();
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
    const { agent, registry, store } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: true,
      allowedAgents: [CURATOR, MEMBER],
    });

    const resolution = await resolveRecipients(agent);

    expect(resolution).toEqual({ requiresEncryption: false, recipients: [] });
    // The store resolver treats any allowlist as a read gate; it must not run.
    expect(store.query).not.toHaveBeenCalled();
    // One registered-authority read decides it; there is no second lookup.
    expect(registry.calls).toEqual([
      expect.objectContaining({ allowAcceptedRfc64FinalizedAbsence: true }),
    ]);
  });

  it('keeps the creator on plaintext while its graph is local-first, whatever the accepted absence', async () => {
    // A graph stays local-first in the registry until its own creator
    // registers it; SWM must not depend on the chain meanwhile.
    const { agent, store } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: true,
      index: { kind: 'local-first' },
    });

    const resolution = await resolveRecipients(agent);

    expect(resolution).toEqual({ requiresEncryption: false, recipients: [] });
    expect(store.query).not.toHaveBeenCalled();
  });

  it('keeps the store roster for a local-first graph without an accepted public policy', async () => {
    // Only the accepted owner-signed PUBLIC policy turns an unregistered
    // answer into plaintext; any other unregistered graph keeps the store
    // resolver's allowlist-aware decision.
    const { agent, store } = joinedMember({
      acceptedUnregistered: false,
      index: { kind: 'local-first' },
    });

    await resolveRecipients(agent);

    expect(store.query).toHaveBeenCalled();
  });

  it('closes plaintext once the registry reports a private registration, for creator and member alike', async () => {
    // #2831 review: an accepted public snapshot never outvotes a registration.
    // The creator leaves its local-first answer inside the registry the moment
    // its own registration commits, and then gets this same answer.
    const { agent, registry } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: true,
      allowedAgents: [CURATOR, MEMBER],
      index: { kind: 'private', participantAgents: [CURATOR] },
    });

    // Encryption to the registered roster is required: its key lookup runs
    // (and finds no key in this fixture's store) instead of plaintext.
    await expect(resolveRecipients(agent)).rejects.toThrow(/Missing public encryption key/);
    await expect(WorkspaceCryptoMethods.prototype.isContextGraphSwmPublic.call(agent as never, CG))
      .resolves.toBe(false);
    expect(registry.resolve).toHaveBeenCalledTimes(2);
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

describe('a retained public snapshot once catalog authority stops governing transport (#2831 review)', () => {
  it('stops the public shortcut for both the sender and the receiver', async () => {
    const { agent, registry, isContextGraphPublicOnChain } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: true,
      transportActive: false,
      allowedAgents: [CURATOR, MEMBER],
    });

    // Sender: no accepted-absence allowance, so the name absence fails closed.
    await expect(resolveRecipients(agent)).rejects.toMatchObject({
      reason: 'finalized-name-absence-unaccepted',
    });
    // Receiver: back on the plain on-chain probe, which does not say public.
    await expect(WorkspaceCryptoMethods.prototype.isContextGraphSwmPublic.call(agent as never, CG))
      .resolves.toBe(false);
    expect(isContextGraphPublicOnChain).toHaveBeenCalledTimes(1);
    expect(registry.calls).toEqual([
      expect.objectContaining({ allowAcceptedRfc64FinalizedAbsence: false }),
    ]);
  });

  it('denies the gate and member recovery the old allowlist', async () => {
    const { agent, getCgMeta } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: true,
      transportActive: false,
      allowedAgents: [CURATOR, MEMBER],
    });

    const gate = await WorkspaceCryptoMethods.prototype.resolveContextGraphAgentGateAuthority.call(
      agent as never,
      CG,
    );
    const recovery = await WorkspaceCryptoMethods.prototype.getMemberRecoveryGate.call(
      agent as never,
      CG,
    );

    expect(gate).toEqual(expect.objectContaining({ kind: 'unavailable' }));
    expect(recovery).toBeNull();
    expect(getCgMeta).not.toHaveBeenCalled();
  });

  it.each([
    ['active catalog authority', {}, true],
    ['a kill switch', { killSwitchActive: true }, false],
    ['legacy mode', { mode: 'legacy' }, false],
    ['inactive authority', { active: false }, false],
    ['a shadow-stage reconciliation lane', { reconciliationLane: 'shadow-stage' }, false],
  ] as const)('lets the snapshot govern transport only with %s', (_label, overrides, expected) => {
    const host = {
      resolveRfc64CatalogReceiverAuthorityV1: () => ({
        killSwitchActive: false,
        mode: 'catalog',
        active: true,
        reconciliationLane: 'catalog-apply',
        ...overrides,
      }),
      hasAcceptedRfc64PublicUnregisteredAuthorityV1: () => true,
      isRfc64CatalogTransportAuthorityActiveV1:
        Rfc64CatalogMethods.prototype.isRfc64CatalogTransportAuthorityActiveV1,
    };

    expect(Rfc64CatalogMethods.prototype.hasActiveAcceptedRfc64PublicUnregisteredAuthorityV1
      .call(host as never, CG)).toBe(expected);
  });
});

describe('isContextGraphSwmPublic: one plaintext predicate for sender and receiver (#2827)', () => {
  it('is exactly the on-chain probe without an accepted owner-signed public policy', async () => {
    const { agent, isContextGraphPublicOnChain, registry } = joinedMember({
      acceptedUnregistered: false,
      publicOnChain: true,
    });

    await expect(WorkspaceCryptoMethods.prototype.isContextGraphSwmPublic.call(agent as never, CG))
      .resolves.toBe(true);
    expect(isContextGraphPublicOnChain).toHaveBeenCalledTimes(1);
    expect(registry.resolve).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', { kind: 'absent' } as const, true],
    ['registered public', { kind: 'public' } as const, true],
    ['registered private', { kind: 'private', participantAgents: [CURATOR] } as const, false],
    ['unavailable', { kind: 'unavailable' } as const, false],
  ])('with an accepted public policy, answers from the index when the name is %s', async (_label, index, expected) => {
    const { agent, registry } = joinedMember({ acceptedUnregistered: true, acceptedPublic: true, index });

    await expect(WorkspaceCryptoMethods.prototype.isContextGraphSwmPublic.call(agent as never, CG))
      .resolves.toBe(expected);
    // The plaintext bit reads the finalized projection, like recipient selection.
    expect(registry.calls).toEqual([expect.objectContaining({
      allowAcceptedRfc64FinalizedAbsence: true,
      authorityReadMode: 'finalized-index-or-live',
    })]);
  });

  it('fails closed, and says so, when the registered authority read throws', async () => {
    const { agent, warn } = joinedMember({
      acceptedUnregistered: true,
      acceptedPublic: true,
      registryError: new Error('index unavailable'),
    });

    await expect(WorkspaceCryptoMethods.prototype.isContextGraphSwmPublic.call(agent as never, CG))
      .resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
