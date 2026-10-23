// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { agentFromPrivateKey, DKGAgent } from '../src/index.js';
import {
  answerJoinFromHeldApproval,
  curatorSnapshotOmitsApprovedMember,
  isApprovedMemberMetadataConfirmed,
  readApprovedMemberMetadataPending,
  refuseUnlistedWorkspaceSigner,
  watchCuratorSnapshotForApprovedMember,
  withCallerJoinState,
} from '../src/internal/context-graph-authority/approved-member-metadata-pending.js';
import {
  isContextGraphAuthorityUnavailableMarker,
  isRetryableContextGraphAuthorityUnavailableReason,
} from '../src/internal/context-graph-authority/context-graph-authority.js';
import {
  resolveApprovedMemberAcceptanceDecision,
  unprovenApprovedMemberAcceptance,
  type ApprovedMemberAcceptance,
} from '../src/internal/context-graph-authority/approved-member-acceptance.js';
import type { ContextGraphSub } from '../src/dkg-agent-types.js';

const CURATOR_PEER = '12D3KooWPendingApprovalCurator';
const OTHER_CURATOR_PEER = '12D3KooWPendingApprovalOtherCurator';
const CURATOR_AGENT = '0x00000000000000000000000000000000000000c1';
const CONTEXT_GRAPH = 'approved-member-metadata-pending';
const REFUSAL = `Cannot gossip SWM write for agent-gated context graph "${CONTEXT_GRAPH}": no local allowed signing agent key`;

/** The parts of the agent these tests reach past its public surface for. */
interface MemberInternals {
  localAgents: Map<string, unknown>;
  localApprovedAgentByCG: Map<string, string>;
  subscribedContextGraphs: Map<string, ContextGraphSub>;
}

const internalsOf = (agent: DKGAgent) => agent as unknown as MemberInternals;
const generation = (digit: string) => `0x${digit.repeat(64)}`;

/** A root `_meta` snapshot with the given definition and allowlist. */
function snapshot(
  accessPolicy: 'public' | 'private',
  allowed: readonly string[],
  revoked: readonly string[] = [],
) {
  const subject = contextGraphDataGraphUri(CONTEXT_GRAPH);
  const graph = contextGraphMetaGraphUri(CONTEXT_GRAPH);
  const literal = (value: string) => JSON.stringify(value);
  return [
    { subject, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CONTEXT_GRAPH, graph },
    { subject, predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY, object: literal(accessPolicy), graph },
    { subject, predicate: DKG_ONTOLOGY.DKG_CREATOR, object: `did:dkg:agent:${CURATOR_AGENT}`, graph },
    { subject, predicate: DKG_ONTOLOGY.DKG_CURATOR, object: `did:dkg:agent:${CURATOR_AGENT}`, graph },
    ...allowed.map((agent) => ({ subject, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: literal(agent), graph })),
    ...revoked.map((agent) => ({ subject, predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT, object: literal(agent), graph })),
  ];
}

async function publicAcceptance(member: string): Promise<ApprovedMemberAcceptance> {
  return resolveApprovedMemberAcceptanceDecision(
    { approvedAgentAddress: member },
    async () => ({ kind: 'plaintext' }) as never,
  );
}

describe('a join approval whose member list is pending (#3421)', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await agent?.stop().catch(() => {});
    agent = undefined;
    vi.restoreAllMocks();
  });

  /**
   * A member node whose local agent holds its key, subscribed to the graph,
   * whose join `CURATOR_PEER` approved: the binding and the requester decision
   * the join-approved handler leaves behind.
   */
  async function approvedMember(options: { metadataConfirmed?: boolean; approve?: boolean } = {}) {
    agent = await DKGAgent.create({ name: 'PendingApprovalMember', chainAdapter: new MockChainAdapter() });
    const local = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'pending-approval-agent');
    internalsOf(agent).localAgents.set(local.agentAddress, local);
    const member = local.agentAddress.toLowerCase();
    internalsOf(agent).subscribedContextGraphs.set(CONTEXT_GRAPH, {
      subscribed: true,
      synced: false,
      sharedMemorySynced: false,
      metaSynced: false,
      pendingMeta: true,
      syncMode: 'always-on',
    });
    await agent.setRequesterJoinRequestPending(CONTEXT_GRAPH, member, generation('1'), CURATOR_PEER);
    if (options.approve !== false) {
      await agent.applyRequesterJoinDecision(CONTEXT_GRAPH, member, generation('1'), 'approved', CURATOR_PEER);
      internalsOf(agent).localApprovedAgentByCG.set(CONTEXT_GRAPH, member);
    }
    const acceptance = await publicAcceptance(member);
    return {
      member: agent,
      address: member,
      acceptance,
      resolveAcceptance: vi.spyOn(agent, 'resolveApprovedMemberAcceptance').mockResolvedValue(acceptance),
      confirmed: vi.spyOn(agent, 'hasConfirmedApprovedMemberMetaState')
        .mockResolvedValue(options.metadataConfirmed ?? false),
      recover: vi.spyOn(agent, 'recoverPendingJoinApprovalMetadata').mockResolvedValue(undefined),
    };
  }

  describe('a write by the approved member', () => {
    it('is refused as a retryable authority wait while its member list is pending', async () => {
      const { member, address } = await approvedMember();

      const refusal = await refuseUnlistedWorkspaceSigner(member, CONTEXT_GRAPH);

      expect(isContextGraphAuthorityUnavailableMarker(refusal)).toBe(true);
      if (!isContextGraphAuthorityUnavailableMarker(refusal)) return;
      expect(refusal.reason).toBe('approved-member-metadata-pending');
      expect(isRetryableContextGraphAuthorityUnavailableReason(refusal.reason)).toBe(true);
      expect(refusal.message).toContain(REFUSAL);
      expect(refusal.message).toContain(address);
    });

    it('reaches the write path: the signer resolution rejects with the retryable wait', async () => {
      const { member } = await approvedMember();
      // A public graph whose local allowlist does not name the member yet.
      vi.spyOn(member, 'resolveContextGraphAgentGateAuthority')
        .mockResolvedValue({ kind: 'available', agentAddresses: [ethers.getAddress(CURATOR_AGENT)] });

      const refusal = await member.resolveWorkspaceGossipSigningAgent(CONTEXT_GRAPH).catch((error: unknown) => error);

      expect(isContextGraphAuthorityUnavailableMarker(refusal)).toBe(true);
      expect((refusal as { reason?: string }).reason).toBe('approved-member-metadata-pending');
    });

    it.each([
      {
        case: 'the member list arrived',
        arrange: (m: Awaited<ReturnType<typeof approvedMember>>) => { m.confirmed.mockResolvedValue(true); },
      },
      {
        case: 'no approval binding is held',
        arrange: (m: Awaited<ReturnType<typeof approvedMember>>) => {
          internalsOf(m.member).localApprovedAgentByCG.clear();
        },
      },
      {
        case: 'the approved agent holds no key here',
        arrange: (m: Awaited<ReturnType<typeof approvedMember>>) => { internalsOf(m.member).localAgents.clear(); },
      },
      {
        case: 'the approval binding names another agent',
        arrange: (m: Awaited<ReturnType<typeof approvedMember>>) => {
          internalsOf(m.member).localApprovedAgentByCG.set(CONTEXT_GRAPH, CURATOR_AGENT);
        },
      },
      {
        case: 'the requester decision cannot be read',
        arrange: (m: Awaited<ReturnType<typeof approvedMember>>) => {
          vi.spyOn(m.member, 'readRequesterJoinRequestState').mockRejectedValue(new Error('store fault'));
        },
      },
    ])('keeps the plain refusal when $case', async ({ arrange }) => {
      const observed = await approvedMember();
      arrange(observed);

      const refusal = await refuseUnlistedWorkspaceSigner(observed.member, CONTEXT_GRAPH);

      expect(isContextGraphAuthorityUnavailableMarker(refusal)).toBe(false);
      expect(refusal.message).toBe(REFUSAL);
    });

    it('keeps the plain refusal while the request is pending, not approved', async () => {
      const { member, address } = await approvedMember({ approve: false });
      internalsOf(member).localApprovedAgentByCG.set(CONTEXT_GRAPH, address);

      expect(isContextGraphAuthorityUnavailableMarker(
        await refuseUnlistedWorkspaceSigner(member, CONTEXT_GRAPH),
      )).toBe(false);
    });
  });

  describe('the pending state', () => {
    it('names the approval, its generation and curator, for the approved agent only', async () => {
      const { member, address } = await approvedMember();

      await expect(readApprovedMemberMetadataPending(member, CONTEXT_GRAPH)).resolves.toEqual({
        agentAddress: address,
        requestGeneration: generation('1'),
        curatorPeerId: CURATOR_PEER,
      });
      await expect(readApprovedMemberMetadataPending(member, CONTEXT_GRAPH, address.toUpperCase().replace('0X', '0x')))
        .resolves.toMatchObject({ agentAddress: address });
      await expect(readApprovedMemberMetadataPending(member, CONTEXT_GRAPH, CURATOR_AGENT)).resolves.toBeUndefined();
    });

    it('counts as confirmed without an approval binding', async () => {
      const { member, resolveAcceptance, confirmed } = await approvedMember();
      resolveAcceptance.mockResolvedValue(undefined);

      await expect(isApprovedMemberMetadataConfirmed(member, CONTEXT_GRAPH)).resolves.toBe(true);
      expect(confirmed).not.toHaveBeenCalled();
    });
  });

  describe('a new join request of the approved agent', () => {
    it('is answered from the held approval and asks the metadata recovery for an attempt', async () => {
      const { member, address, recover } = await approvedMember();

      await expect(answerJoinFromHeldApproval(member, CONTEXT_GRAPH, address, CURATOR_PEER)).resolves.toEqual({
        delivered: 0,
        errors: [],
        alreadyMember: true,
        approvedMetadataPending: true,
      });
      expect(recover).toHaveBeenCalledWith(CONTEXT_GRAPH, CURATOR_PEER, undefined);
    });

    it.each([
      { case: 'it goes to another curator', curator: OTHER_CURATOR_PEER, arrange: () => {} },
      {
        case: 'the node does not subscribe to the graph',
        curator: CURATOR_PEER,
        arrange: (member: DKGAgent) => {
          internalsOf(member).subscribedContextGraphs.set(CONTEXT_GRAPH, {
            ...member.getSubscribedContextGraphs().get(CONTEXT_GRAPH)!,
            subscribed: false,
          });
        },
      },
      {
        case: 'the confirmation cannot be read',
        curator: CURATOR_PEER,
        arrange: (member: DKGAgent) => {
          vi.spyOn(member, 'hasConfirmedApprovedMemberMetaState').mockRejectedValue(new Error('store fault'));
        },
      },
    ])('goes to the curator when $case', async ({ curator, arrange }) => {
      const { member, address, recover } = await approvedMember();
      arrange(member);

      await expect(answerJoinFromHeldApproval(member, CONTEXT_GRAPH, address, curator)).resolves.toBeUndefined();
      expect(recover).not.toHaveBeenCalled();
    });

    it('keeps the approval and sends nothing unless a new request is asked for explicitly', async () => {
      const { member, address } = await approvedMember();
      const send = vi.spyOn(member, 'forwardJoinRequestOnce').mockResolvedValue({ delivered: 1, errors: [] });
      const delegation = { agentAddress: address } as never;

      await expect(member.forwardJoinRequest(CONTEXT_GRAPH, delegation, undefined, CURATOR_PEER))
        .resolves.toMatchObject({ delivered: 0, alreadyMember: true, approvedMetadataPending: true });
      expect(send).not.toHaveBeenCalled();
      await expect(member.readRequesterJoinRequestState(CONTEXT_GRAPH, address)).resolves.toMatchObject({
        status: 'approved',
        requestGeneration: generation('1'),
      });

      await expect(member.forwardJoinRequest(CONTEXT_GRAPH, delegation, undefined, CURATOR_PEER, { reRequest: true }))
        .resolves.toEqual({ delivered: 1, errors: [] });
      expect(send).toHaveBeenCalledWith(CONTEXT_GRAPH, delegation, undefined, CURATOR_PEER);
    });
  });

  describe('the listing row of the caller', () => {
    it('shows the pending approval on a row that does not involve the caller yet', async () => {
      const { member, address } = await approvedMember();
      const row = { id: CONTEXT_GRAPH, callerInvolved: false };

      await expect(withCallerJoinState(member, row, address))
        .resolves.toEqual({ ...row, joinState: 'approved-metadata-pending' });
      await expect(withCallerJoinState(member, row, CURATOR_AGENT)).resolves.toBe(row);
    });

    it('is what the context-graph listing shows the caller', async () => {
      const { member, address, confirmed } = await approvedMember();
      // The curator's public declaration, held before the join; its allowlist
      // does not name the member yet.
      await (member as unknown as { store: { insert(quads: unknown[]): Promise<void> } }).store
        .insert(snapshot('public', [CURATOR_AGENT]));

      const pendingRow = (await member.listContextGraphs({ callerAgentAddress: address }))
        .find((row) => row.id === CONTEXT_GRAPH);
      expect(pendingRow).toMatchObject({ callerInvolved: false, joinState: 'approved-metadata-pending' });

      confirmed.mockResolvedValue(true);
      (member as unknown as { invalidateListContextGraphsCache(): void }).invalidateListContextGraphsCache();
      const row = (await member.listContextGraphs({ callerAgentAddress: address }))
        .find((candidate) => candidate.id === CONTEXT_GRAPH);
      expect(row).toBeDefined();
      expect(row).not.toHaveProperty('joinState');
    });

    it('leaves a row alone that involves the caller, or whose state cannot be read', async () => {
      const { member, address, resolveAcceptance } = await approvedMember();
      const involved = { id: CONTEXT_GRAPH, callerInvolved: true };
      await expect(withCallerJoinState(member, involved, address)).resolves.toBe(involved);
      expect(resolveAcceptance).not.toHaveBeenCalled();

      resolveAcceptance.mockRejectedValue(new Error('chain fault'));
      const row = { id: CONTEXT_GRAPH, callerInvolved: false };
      await expect(withCallerJoinState(member, row, address)).resolves.toBe(row);
    });
  });

  describe('a complete snapshot from the curator', () => {
    const member = '0x00000000000000000000000000000000000000a1';

    it.each([
      { definition: 'public', allowed: [CURATOR_AGENT], revoked: [], omits: true },
      { definition: 'public', allowed: [CURATOR_AGENT, member], revoked: [], omits: false },
      { definition: 'public', allowed: [CURATOR_AGENT, member], revoked: [member], omits: true },
      { definition: 'private', allowed: [CURATOR_AGENT], revoked: [], omits: true },
      { definition: 'private', allowed: [member.toUpperCase().replace('0X', '0x')], revoked: [], omits: false },
    ] as const)('with a $definition definition, allowing $allowed and revoking $revoked: omits=$omits', async ({
      definition,
      allowed,
      revoked,
      omits,
    }) => {
      const acceptance = definition === 'public'
        ? await publicAcceptance(member)
        : unprovenApprovedMemberAcceptance({ approvedAgentAddress: member });
      expect(curatorSnapshotOmitsApprovedMember(CONTEXT_GRAPH, snapshot(definition, allowed, revoked), acceptance))
        .toBe(omits);
    });

    it('without the definition the acceptance admits says nothing about the member', async () => {
      expect(curatorSnapshotOmitsApprovedMember(
        CONTEXT_GRAPH,
        snapshot('private', [CURATOR_AGENT]),
        await publicAcceptance(member),
      )).toBe(false);
      expect(curatorSnapshotOmitsApprovedMember(
        CONTEXT_GRAPH,
        [],
        unprovenApprovedMemberAcceptance({ approvedAgentAddress: member }),
      )).toBe(false);
    });
  });

  describe('a watched snapshot fetch', () => {
    it('ends the approval a snapshot that leaves the member out answers', async () => {
      const { member, address, acceptance } = await approvedMember();
      const invalidate = vi.spyOn(member as unknown as { invalidateListContextGraphsCache(): void }, 'invalidateListContextGraphsCache');
      const settle = await watchCuratorSnapshotForApprovedMember(member, CONTEXT_GRAPH, CURATOR_PEER, acceptance);
      expect(settle).toBeTypeOf('function');

      // A snapshot that lists the member changes nothing.
      await settle!(snapshot('public', [CURATOR_AGENT, address]));
      expect(internalsOf(member).localApprovedAgentByCG.get(CONTEXT_GRAPH)).toBe(address);

      await settle!(snapshot('public', [CURATOR_AGENT]));
      await expect(member.readRequesterJoinRequestState(CONTEXT_GRAPH, address)).resolves.toMatchObject({
        status: 'pending',
        requestGeneration: generation('1'),
      });
      expect(internalsOf(member).localApprovedAgentByCG.has(CONTEXT_GRAPH)).toBe(false);
      expect(invalidate).toHaveBeenCalled();
      // A new join request now goes to the curator.
      await expect(answerJoinFromHeldApproval(member, CONTEXT_GRAPH, address, CURATOR_PEER)).resolves.toBeUndefined();
    });

    it('leaves a newer approval that arrived during the fetch in place', async () => {
      const { member, address, acceptance } = await approvedMember();
      const settle = await watchCuratorSnapshotForApprovedMember(member, CONTEXT_GRAPH, CURATOR_PEER, acceptance);
      // The member asked again and the curator approved the new request.
      await member.setRequesterJoinRequestPending(CONTEXT_GRAPH, address, generation('2'), CURATOR_PEER);
      await member.applyRequesterJoinDecision(CONTEXT_GRAPH, address, generation('2'), 'approved', CURATOR_PEER);

      await settle!(snapshot('public', [CURATOR_AGENT]));

      await expect(member.readRequesterJoinRequestState(CONTEXT_GRAPH, address)).resolves.toMatchObject({
        status: 'approved',
        requestGeneration: generation('2'),
      });
      expect(internalsOf(member).localApprovedAgentByCG.get(CONTEXT_GRAPH)).toBe(address);
    });

    it('logs a failure to end the approval instead of failing the refresh', async () => {
      const { member, address, acceptance } = await approvedMember();
      const settle = await watchCuratorSnapshotForApprovedMember(member, CONTEXT_GRAPH, CURATOR_PEER, acceptance);
      vi.spyOn(member, 'restoreRequesterJoinDecisionAfterFailedApply').mockRejectedValue(new Error('store fault'));
      const warn = vi.spyOn((member as unknown as { log: { warn(...args: unknown[]): void } }).log, 'warn');

      await expect(settle!(snapshot('public', [CURATOR_AGENT]))).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('store fault'));
      expect(internalsOf(member).localApprovedAgentByCG.get(CONTEXT_GRAPH)).toBe(address);
    });

    it.each([
      { case: 'the approval came from another curator', curator: OTHER_CURATOR_PEER, approve: true, fail: false },
      { case: 'the request is not approved', curator: CURATOR_PEER, approve: false, fail: false },
      { case: 'the request cannot be read', curator: CURATOR_PEER, approve: true, fail: true },
    ])('watches nothing when $case', async ({ curator, approve, fail }) => {
      const { member, acceptance } = await approvedMember({ approve });
      if (fail) vi.spyOn(member, 'readRequesterJoinRequestState').mockRejectedValue(new Error('store fault'));

      await expect(watchCuratorSnapshotForApprovedMember(member, CONTEXT_GRAPH, curator, acceptance))
        .resolves.toBeUndefined();
    });
  });
});
