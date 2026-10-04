// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import type { ContextGraphIdV1, EvmAddressV1, NetworkIdV1 } from '@origintrail-official/dkg-core';
import { resolveRfc64CatalogLifecycleAuthoritySourceV1, type Rfc64ApprovedPrivateLifecycleSourceResolutionV1 } from '../src/rfc64/catalog-lifecycle-authority-source-v1.js';
import type { AcceptedRfc64CatalogAccessSnapshotV1 } from '../src/rfc64/catalog-access-policy-v1.js';
import { composeRfc64UnregisteredCatalogAuthorityV1, parseRfc64AuthoritySnapshotV1 } from '../src/rfc64/release-native-catalog-authority-v1.js';

const owner = '0x1111111111111111111111111111111111111111';
const snapshot = composeRfc64UnregisteredCatalogAuthorityV1({
  networkId: 'otp:31337' as NetworkIdV1, contextGraphId: 'source-proof' as ContextGraphIdV1,
  ownerAddress: owner as EvmAddressV1, accessPolicy: 1, publishPolicy: 0,
  publishAuthorityAccountId: '0', memberAddresses: [owner as EvmAddressV1], rosterVersion: '1',
});
const registeredEvidence = { expectedOnChainId: 7n, expectedNameHash: `0x${'a'.repeat(64)}`,
  snapshot: parseRfc64AuthoritySnapshotV1({ chainId: '31337', contextGraphId: '7',
    governanceContract: owner, owner, active: true, accessPolicy: 0,
    publishPolicy: 1, publishAuthority: null, publishAuthorityAccountId: '0',
    participantAgents: [], nameHash: `0x${'a'.repeat(64)}`, ownershipEra: '1',
    policyVersion: '1', rosterVersion: '1', sourceBlockNumber: '17',
    sourceBlockHash: `0x${'b'.repeat(64)}` }, 7n) };
const approved = { kind: 'available' as const, metadataRevision: 'metadata-1', requesterRevision: 3,
  authority: { approvedAgentAddress: owner, ownerAddress: owner, requestGeneration: 'generation',
    curatorPeerId: 'peer', memberAddresses: [owner] } };
function ports() {
  return { bound: false, finalizedAbsence: true, isLocalFirst: vi.fn(async () => false),
    readCompatibility: vi.fn((): AcceptedRfc64CatalogAccessSnapshotV1 | null => null),
    resolveApprovedPrivate: vi.fn(async (): Promise<Rfc64ApprovedPrivateLifecycleSourceResolutionV1> => ({ kind: 'absent' })),
    readRegistered: vi.fn(async (): Promise<typeof registeredEvidence | null> => registeredEvidence),
    loadReplicaSeed: vi.fn(async (): Promise<typeof snapshot | null> => snapshot) };
}

describe('catalog lifecycle authority source', () => {
  it.each(['metadata', 'requester'] as const)('stops seed fallback when the %s generation moved during approved proof', async () => {
    const p = ports(); p.resolveApprovedPrivate.mockResolvedValue({ kind: 'facts-moved' });
    expect(await resolveRfc64CatalogLifecycleAuthoritySourceV1(p)).toEqual({ kind: 'facts-moved' });
    expect(p.loadReplicaSeed).not.toHaveBeenCalled();
  });

  it('keeps an available approval and its exact revisions ahead of a signed replica seed', async () => {
    const p = ports(); p.resolveApprovedPrivate.mockResolvedValue(approved);
    expect(await resolveRfc64CatalogLifecycleAuthoritySourceV1(p)).toEqual({ kind: 'available', source: {
      kind: 'approved-private', authority: approved.authority, metadataRevision: 'metadata-1', requesterRevision: 3,
    } });
    expect(p.loadReplicaSeed).not.toHaveBeenCalled();
    expect(p.readRegistered).not.toHaveBeenCalled();
  });

  it('distinguishes genuinely absent authority from an authenticated signed seed', async () => {
    const p = ports();
    expect(await resolveRfc64CatalogLifecycleAuthoritySourceV1(p)).toEqual({ kind: 'available', source: { kind: 'replica-seed', snapshot } });
    p.loadReplicaSeed.mockResolvedValue(null);
    expect(await resolveRfc64CatalogLifecycleAuthoritySourceV1(p)).toEqual({ kind: 'absent' });
  });

  it('retains direct authenticated private compatibility ahead of replica proofs', async () => {
    const p = ports();
    const accepted: AcceptedRfc64CatalogAccessSnapshotV1 = { ...snapshot, provenance: 'authenticated' };
    p.readCompatibility.mockReturnValue(accepted);
    expect(await resolveRfc64CatalogLifecycleAuthoritySourceV1(p)).toEqual({ kind: 'available', source: { kind: 'compatibility', snapshot: accepted } });
    expect(p.resolveApprovedPrivate).not.toHaveBeenCalled(); expect(p.loadReplicaSeed).not.toHaveBeenCalled();
    expect(p.readRegistered).not.toHaveBeenCalled();
  });

  it('propagates discovery failure without treating it as authenticated absence', async () => {
    const p = { ...ports(), finalizedAbsence: false };
    const error = new Error('finalized discovery unavailable');
    p.readRegistered.mockRejectedValue(error);
    await expect(resolveRfc64CatalogLifecycleAuthoritySourceV1(p)).rejects.toBe(error);
    expect(p.resolveApprovedPrivate).not.toHaveBeenCalled();
    expect(p.loadReplicaSeed).not.toHaveBeenCalled();
  });

  it('does not substitute an approved replica when the bound registered authority is absent', async () => {
    const p = { ...ports(), bound: true };
    p.readRegistered.mockResolvedValue(null);
    p.resolveApprovedPrivate.mockResolvedValue(approved);
    expect(await resolveRfc64CatalogLifecycleAuthoritySourceV1(p)).toEqual({ kind: 'absent' });
    expect(p.readRegistered).toHaveBeenCalledOnce();
    expect(p.isLocalFirst).not.toHaveBeenCalled();
    expect(p.resolveApprovedPrivate).not.toHaveBeenCalled();
    expect(p.loadReplicaSeed).not.toHaveBeenCalled();
  });

  it('authenticates a legacy absent private join without consuming a signed seed', async () => {
    const p = { ...ports(), finalizedAbsence: false }; p.readRegistered.mockResolvedValue(null);
    p.resolveApprovedPrivate.mockResolvedValue(approved);
    expect(await resolveRfc64CatalogLifecycleAuthoritySourceV1(p)).toMatchObject({ kind: 'available', source: { kind: 'approved-private' } });
    p.resolveApprovedPrivate.mockResolvedValue({ kind: 'absent' });
    expect(await resolveRfc64CatalogLifecycleAuthoritySourceV1(p)).toEqual({ kind: 'absent' });
    expect(p.loadReplicaSeed).not.toHaveBeenCalled();
    expect(p.readRegistered).toHaveBeenCalledTimes(2);
  });

  it.each(['bound', 'local-first', 'unfinalized'] as const)('preserves %s source precedence without reading replica proof', async (source) => {
    const p = ports(); p.bound = source === 'bound'; p.finalizedAbsence = source !== 'unfinalized';
    p.isLocalFirst.mockResolvedValue(source === 'local-first');
    expect(await resolveRfc64CatalogLifecycleAuthoritySourceV1(p)).toEqual({ kind: 'available', source: source === 'local-first' ? { kind: 'local-first' } : { kind: 'registered', evidence: registeredEvidence } });
    expect(p.resolveApprovedPrivate).not.toHaveBeenCalled(); expect(p.loadReplicaSeed).not.toHaveBeenCalled();
    if (source === 'local-first') expect(p.readRegistered).not.toHaveBeenCalled();
    else expect(p.readRegistered).toHaveBeenCalledOnce();
  });
});
