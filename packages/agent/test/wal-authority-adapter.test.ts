import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import type {
  DkgEpochSnapshotValidation,
  DkgMembershipValidation,
  DkgOpenAuthorValidation,
  DkgPrivateDisclosureValidation,
} from '@origintrail-official/dkg-wal/authority';
import { signAgentDelegation } from '../src/auth/agent-delegation.js';
import { createCurrentDkgWalAuthorityAdapter } from '../src/wal/authority-adapter.js';

const encoder = new TextEncoder();

function fixed(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

describe('current DKG to WAL authority adapter', () => {
  it('forwards membership, chain, snapshot, and object admission to existing DKG checks', async () => {
    const validateMembership = vi.fn(() => true);
    const validateOpenAuthor = vi.fn(() => true);
    const validateEpochSnapshot = vi.fn(() => false);
    const isWalObjectAdmitted = vi.fn(() => true);
    const adapter = createCurrentDkgWalAuthorityAdapter({
      validateMembership,
      validateOpenAuthor,
      validateEpochSnapshot,
      isWalObjectAdmitted,
      privateDisclosureScope: () => 'sync:cg',
      transportPeerIdFromBytes: value => new TextDecoder().decode(value),
      authorizeCurrentPrivateMember: () => true,
    });
    const membership = { membershipCheckpointId: fixed(32, 1) } as DkgMembershipValidation;
    const author = { writerId: fixed(20, 2) } as DkgOpenAuthorValidation;
    const snapshot = { baselineSnapshotObjectId: fixed(32, 3) } as DkgEpochSnapshotValidation;
    const policyId = fixed(32, 4);
    expect(await adapter.validateMembership(membership)).toBe(true);
    expect(await adapter.validateOpenAuthor(author)).toBe(true);
    expect(await adapter.validateEpochSnapshot(snapshot)).toBe(false);
    expect(await adapter.isWalObjectAdmitted(policyId)).toBe(true);
    expect(validateMembership).toHaveBeenCalledWith(membership);
    expect(validateOpenAuthor).toHaveBeenCalledWith(author);
    expect(validateEpochSnapshot).toHaveBeenCalledWith(snapshot);
    expect(isWalObjectAdmitted).toHaveBeenCalledWith(policyId);
  });

  it('uses the existing signed-agent delegation primitive and a fresh membership decision', async () => {
    const wallet = ethers.Wallet.createRandom();
    const peerId = '12D3KooWWalAuthorityAdapter';
    const scope = 'sync:cg-private';
    const nowMs = 1_700_000_000_000;
    const delegation = await signAgentDelegation({
      agentAddress: wallet.address,
      scope,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + 60_000,
      delegateePeerId: peerId,
      agentPrivateKey: wallet.privateKey,
    });
    let currentMember = true;
    const adapter = createCurrentDkgWalAuthorityAdapter({
      validateMembership: () => true,
      validateOpenAuthor: () => true,
      validateEpochSnapshot: () => true,
      isWalObjectAdmitted: () => true,
      privateDisclosureScope: () => scope,
      transportPeerIdFromBytes: value => new TextDecoder().decode(value),
      authorizeCurrentPrivateMember: () => currentMember,
    });
    const input: DkgPrivateDisclosureValidation = {
      collectionId: fixed(32, 1),
      namespaceId: fixed(32, 2),
      membershipCheckpointId: fixed(32, 3),
      memberAgentAddress: ethers.getBytes(wallet.address),
      transportPeerId: encoder.encode(peerId),
      delegation,
      nowMs,
    };
    expect(await adapter.authorizePrivateDisclosure(input)).toBe(true);
    expect(await adapter.authorizePrivateDisclosure({
      ...input, transportPeerId: encoder.encode('12D3KooWWrongPeer'),
    })).toBe(false);
    expect(await adapter.authorizePrivateDisclosure({
      ...input, memberAgentAddress: fixed(20, 9),
    })).toBe(false);
    expect(await adapter.authorizePrivateDisclosure({
      ...input, delegation: { ...delegation, scope: 'sync:other' },
    })).toBe(false);
    expect(await adapter.authorizePrivateDisclosure({ ...input, delegation: null })).toBe(false);
    currentMember = false;
    expect(await adapter.authorizePrivateDisclosure(input)).toBe(false);
  });

  it('fails closed for expired, op-key-only, malformed, and callback-error delegations', async () => {
    const wallet = ethers.Wallet.createRandom();
    const nowMs = 1_700_000_000_000;
    const opKeyOnly = await signAgentDelegation({
      agentAddress: wallet.address,
      scope: 'sync:cg-private',
      issuedAtMs: nowMs,
      delegateeOpKey: ethers.Wallet.createRandom().address,
      agentPrivateKey: wallet.privateKey,
    });
    const adapter = createCurrentDkgWalAuthorityAdapter({
      validateMembership: () => true,
      validateOpenAuthor: () => true,
      validateEpochSnapshot: () => true,
      isWalObjectAdmitted: () => true,
      privateDisclosureScope: () => 'sync:cg-private',
      transportPeerIdFromBytes: () => 'peer',
      authorizeCurrentPrivateMember: () => { throw new Error('fresh membership read failed'); },
    });
    const input: DkgPrivateDisclosureValidation = {
      collectionId: fixed(32, 1), namespaceId: fixed(32, 2), membershipCheckpointId: fixed(32, 3),
      memberAgentAddress: ethers.getBytes(wallet.address), transportPeerId: encoder.encode('peer'),
      delegation: opKeyOnly, nowMs,
    };
    expect(await adapter.authorizePrivateDisclosure(input)).toBe(false);
    expect(await adapter.authorizePrivateDisclosure({ ...input, delegation: {} })).toBe(false);
    const expired = await signAgentDelegation({
      agentAddress: wallet.address,
      scope: 'sync:cg-private',
      issuedAtMs: nowMs - 10_000,
      expiresAtMs: nowMs - 1,
      delegateePeerId: 'peer',
      agentPrivateKey: wallet.privateKey,
    });
    expect(await adapter.authorizePrivateDisclosure({ ...input, delegation: expired })).toBe(false);
    const valid = await signAgentDelegation({
      agentAddress: wallet.address,
      scope: 'sync:cg-private',
      issuedAtMs: nowMs,
      delegateePeerId: 'peer',
      agentPrivateKey: wallet.privateKey,
    });
    expect(await adapter.authorizePrivateDisclosure({ ...input, delegation: valid })).toBe(false);
  });
});
