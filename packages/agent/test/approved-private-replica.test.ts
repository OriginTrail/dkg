// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter, type ContextGraphAuthoritySnapshot } from '@origintrail-official/dkg-chain';
import { DKG_ONTOLOGY as D, contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { resolveApprovedPrivateReplicaOwner } from '../src/approved-private-replica.js';
import { createRfc64RolloutAgentHarness, RFC64_ROLLOUT_DEPLOYMENT } from './_helpers/rfc64-rollout-agent-harness.js';

const OWNER = new ethers.Wallet(`0x${'71'.repeat(32)}`).address.toLowerCase();
const CG = `${OWNER}/private-programs`;
const CURATOR_PEER = '12D3KooWPrivateProgramCurator';
const h = createRfc64RolloutAgentHarness();
afterEach(async () => { await h.cleanup(); vi.restoreAllMocks(); });

async function fixture() {
  const current = vi.fn(async (): Promise<bigint | null> => { throw new Error('insufficient covering RPC quorum; rate limited'); });
  const finalized = vi.fn(async (): Promise<Map<string, ContextGraphAuthoritySnapshot>> => new Map());
  const chain = Object.assign(new NoChainAdapter(), {
    resolveContextGraphIdByNameHash: current,
    contextGraphAuthorityIndexRevisionReader: {
      resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: finalized,
      whenIdle: async () => undefined,
      readContextGraphAuthorityIndexRevisions: async () => new Map(),
    },
  });
  const receiver = await h.startAgent({ name: 'approved-private-replica', config: {
    chainAdapter: chain, rfc64CatalogDeploymentProfile: RFC64_ROLLOUT_DEPLOYMENT,
  } });
  const member = await receiver.registerAgent('private-replica-member');
  const address = member.agentAddress.toLowerCase();
  const approvals = Reflect.get(receiver, 'localApprovedAgentByCG') as Map<string, string>;
  approvals.set(CG, address);
  const state = { status: 'approved' as const, requestGeneration: `0x${'12'.repeat(32)}`,
    curatorPeerId: CURATOR_PEER, curatorAgentAddress: OWNER, curatorAuthorityEra: '0' };
  await receiver.writeRequesterJoinRequestState(CG, address, state);
  const graph = contextGraphMetaGraphUri(CG), subject = contextGraphDataGraphUri(CG);
  const root = (predicate: string, object: string) => ({ graph, subject, predicate, object });
  await receiver.store.insert([
    root(D.RDF_TYPE, D.DKG_CONTEXT_GRAPH), root(D.DKG_ACCESS_POLICY, '"private"'),
    root(D.DKG_CREATOR, `did:dkg:agent:${CURATOR_PEER}`), root(D.DKG_CURATOR, `did:dkg:agent:${OWNER}`),
    root(D.DKG_REGISTRATION_STATUS, '"unregistered"'),
    ...[OWNER, address].map(a => root(D.DKG_ALLOWED_AGENT, JSON.stringify(a))),
    ...[
      [D.DKG_DELEGATION_AGENT, JSON.stringify(address)],
      [D.DKG_DELEGATION_ISSUED_AT, JSON.stringify(String(Date.now() - 1000))],
      [D.DKG_ALLOWED_DELEGATEE_PEER, JSON.stringify(receiver.peerId)],
    ].map(([predicate, object]) => ({ graph, subject: `did:dkg:agent-delegation:${CG}:${address}`, predicate, object })),
  ]);
  // Reproduce the durable approved-but-not-yet-readable subscription after
  // metadata bootstrap. No accepted policy or local-create proof is seeded.
  Reflect.get(receiver, 'subscribedContextGraphs').set(CG, {
    subscribed: true, pendingMeta: true, metaSynced: true, synced: false, syncMode: 'always-on',
  });
  return { receiver, address, approvals, state, current, finalized, root, chain };
}

describe('approved private replica authorization', () => {
  it('uses finalized discovery and admits the authenticated lifecycle roster', async () => {
    const f = await fixture();
    await expect(f.receiver.resolveContextGraphRegistrationBinding(CG)).resolves.toEqual({ kind: 'unregistered' });
    expect(f.finalized).toHaveBeenCalled();
    expect(f.current).not.toHaveBeenCalled();
    await expect(f.receiver.reconcileRfc64CatalogAccessAuthorityV1(CG, undefined, { kind: 'finalized-absence' }))
      .resolves.toMatchObject({ policy: { accessPolicy: 1 }, roster: { members: expect.arrayContaining([
        expect.objectContaining({ agentAddress: OWNER }), expect.objectContaining({ agentAddress: f.address }),
      ]) } });
    await expect(f.receiver.getContextGraphAgentGateAddresses(CG, { requireAvailable: true }))
      .resolves.toEqual(expect.arrayContaining([ethers.getAddress(OWNER), ethers.getAddress(f.address)]));
    await expect(f.receiver.canReadContextGraph(CG, { callerAgentAddress: f.address })).resolves.toBe(true);
    await expect(f.receiver.canReadContextGraph(CG, { callerAgentAddress: new ethers.Wallet(`0x${'73'.repeat(32)}`).address })).resolves.toBe(false);
  });

  it.each(['no-approval', 'rejected', 'foreign-owner', 'revoked-member', 'expired-delegation', 'metadata-only'] as const)
  ('rejects %s evidence rather than trusting the participant list', async (mode) => {
    const f = await fixture();
    if (mode === 'no-approval') f.approvals.clear();
    if (mode === 'rejected') await f.receiver.writeRequesterJoinRequestState(CG, f.address, { ...f.state, status: 'rejected' });
    if (mode === 'foreign-owner') await f.receiver.writeRequesterJoinRequestState(CG, f.address, { ...f.state, curatorAgentAddress: new ethers.Wallet(`0x${'73'.repeat(32)}`).address.toLowerCase() });
    if (mode === 'revoked-member') await f.receiver.store.insert([f.root(D.DKG_REVOKED_AGENT, JSON.stringify(f.address))]);
    if (mode === 'expired-delegation') await f.receiver.store.insert([{
      graph: contextGraphMetaGraphUri(CG), subject: `did:dkg:agent-delegation:${CG}:${f.address}`,
      predicate: D.DKG_DELEGATION_EXPIRES_AT, object: '"1"',
    }]);
    if (mode === 'metadata-only') {
      f.approvals.clear();
      Reflect.get(f.receiver, 'subscribedContextGraphs').get(CG).participantAgents = [OWNER, f.address];
    }
    await expect(resolveApprovedPrivateReplicaOwner(f.receiver, CG, f.approvals.get(CG))).resolves.toBeNull();
    await expect(f.receiver.reconcileRfc64CatalogAccessAuthorityV1(CG, undefined, { kind: 'finalized-absence' }))
      .rejects.toMatchObject({ code: 'unregistered-owner-unresolved' });
  });

  it('retains unavailable authority and never falls back to metadata after an index failure', async () => {
    const f = await fixture();
    f.finalized.mockRejectedValue(new Error('finalized authority RPC unavailable'));
    await expect(f.receiver.getContextGraphAgentGateAddresses(CG, { requireAvailable: true }))
      .rejects.toMatchObject({ code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE', reason: 'local-chain-binding-unavailable', detail: 'finalized authority RPC unavailable' });
    expect(f.current).not.toHaveBeenCalled();
    await expect(f.receiver.canReadContextGraph(CG, { callerAgentAddress: f.address })).resolves.toBe(false);
  });

  it('does not let an absence read race a new authoritative chain binding', async () => {
    const f = await fixture();
    f.finalized.mockImplementationOnce(async () => {
      Reflect.get(f.receiver, 'subscribedContextGraphs').get(CG).onChainId = '9';
      return new Map();
    });
    await expect(f.receiver.resolveContextGraphRegistrationBinding(CG)).resolves.toMatchObject({
      kind: 'unavailable', detail: 'Context Graph binding changed during private replica registration discovery',
    });
    expect(f.current).not.toHaveBeenCalled();
  });

  it('honors a newly registered graph and its current chain exclusion', async () => {
    const f = await fixture();
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(CG));
    // Only registration fields are consumed here; the CURRENT policy/roster
    // below remain independent of finalized snapshot participant metadata.
    f.finalized.mockResolvedValue(new Map([[nameHash, {
      contextGraphId: '9', nameHash, active: true,
    } as ContextGraphAuthoritySnapshot]]));
    vi.spyOn(f.receiver, 'resolveLiveOnChainAccessPolicyState').mockResolvedValue({
      kind: 'available', accessPolicy: 1,
    });
    Reflect.set(f.chain, 'getContextGraphParticipantAgents', async () => [OWNER]);
    await expect(f.receiver.resolveContextGraphRegistrationBinding(CG)).resolves.toMatchObject({
      kind: 'registered', onChainId: 9n,
    });
    await expect(f.receiver.canReadContextGraph(CG, { callerAgentAddress: f.address })).resolves.toBe(false);
    expect(f.current).not.toHaveBeenCalled();
  });

  it('removes a revoked sender from the validated roster', async () => {
    const f = await fixture();
    const authority = () => f.receiver.reconcileRfc64CatalogAccessAuthorityV1(CG, undefined, { kind: 'finalized-absence' });
    await authority();
    await f.receiver.store.insert([f.root(D.DKG_REVOKED_AGENT, JSON.stringify(OWNER))]);
    await f.receiver.advanceRfc64PrivateRosterVersionV1(CG);
    await authority();
    const roster = await f.receiver.getContextGraphAgentGateAddresses(CG, { requireAvailable: true });
    expect(roster).not.toContain(ethers.getAddress(OWNER));
    expect(roster).toContain(ethers.getAddress(f.address));
  });

  it.each(['inactive', 'wrong-name'] as const)('rejects %s finalized registration evidence', async (fault) => {
    const f = await fixture();
    const nameHash = ethers.keccak256(ethers.toUtf8Bytes(CG));
    f.finalized.mockResolvedValue(new Map([[nameHash, {
      contextGraphId: '9', active: fault !== 'inactive',
      nameHash: fault === 'wrong-name' ? ethers.ZeroHash : nameHash,
    } as ContextGraphAuthoritySnapshot]]));
    await expect(f.receiver.getContextGraphAgentGateAddresses(CG, { requireAvailable: true }))
      .rejects.toMatchObject({ code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
        detail: 'Finalized private replica registration evidence is invalid' });
    expect(f.current).not.toHaveBeenCalled();
  });
});
