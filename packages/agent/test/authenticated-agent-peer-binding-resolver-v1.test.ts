import {
  AGENT_PEER_BINDING_KIND_V1,
  AGENT_PEER_BINDING_SCHEMA_VERSION_V1,
  canonicalizeAgentPeerBindingSigningBytesV1,
  parseCanonicalLibp2pPeerIdV1,
  type AgentPeerBindingPayloadV1,
  type SignedAgentPeerBindingV1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import {
  AuthenticatedAgentPeerBindingResolverV1,
  type AgentPeerBindingCandidateSetV1,
} from '../src/authenticated-agent-peer-binding-resolver-v1.js';

const PEER_ID = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const OTHER_PEER_ID = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const NOW = 10_000;

async function binding(
  wallet: ethers.Wallet,
  bindingVersion: string,
  overrides: Partial<AgentPeerBindingPayloadV1> = {},
): Promise<SignedAgentPeerBindingV1> {
  const payload: AgentPeerBindingPayloadV1 = {
    kind: AGENT_PEER_BINDING_KIND_V1,
    schemaVersion: AGENT_PEER_BINDING_SCHEMA_VERSION_V1,
    bindingVersion: bindingVersion as never,
    agentAddress: wallet.address.toLowerCase() as EvmAddressV1,
    peerId: parseCanonicalLibp2pPeerIdV1(PEER_ID),
    validFromMs: '9000' as never,
    expiresAtMs: '11000' as never,
    state: 'active',
    ...overrides,
  };
  return {
    ...payload,
    signature: await wallet.signMessage(canonicalizeAgentPeerBindingSigningBytesV1(payload)),
  };
}

function resolver(candidateSet: AgentPeerBindingCandidateSetV1) {
  const loadPeerBindingCandidates = vi.fn(async () => candidateSet);
  return {
    instance: new AuthenticatedAgentPeerBindingResolverV1({ loadPeerBindingCandidates }),
    loadPeerBindingCandidates,
  };
}

describe('authenticated agent peer binding resolver v1', () => {
  it('returns one current wallet-signed binding for the authenticated carrier peer', async () => {
    const wallet = ethers.Wallet.createRandom();
    const candidate = await binding(wallet, '3');
    const { instance, loadPeerBindingCandidates } = resolver({
      complete: true,
      candidates: [candidate],
    });

    await expect(instance.resolve({
      peerId: PEER_ID,
      carrierPeerId: PEER_ID,
      nowMs: NOW,
    })).resolves.toEqual({
      peerId: PEER_ID,
      agentAddress: wallet.address.toLowerCase(),
      bindingVersion: '3',
      validFromMs: '9000',
      expiresAtMs: '11000',
    });
    expect(loadPeerBindingCandidates).toHaveBeenCalledWith(
      parseCanonicalLibp2pPeerIdV1(PEER_ID),
    );
  });

  it('never falls back below a revoked, expired, or future high-water version', async () => {
    const wallet = ethers.Wallet.createRandom();
    const active = await binding(wallet, '1');
    for (const highWater of [
      await binding(wallet, '2', { state: 'revoked' }),
      await binding(wallet, '2', { validFromMs: '7000' as never, expiresAtMs: '10000' as never }),
      await binding(wallet, '2', { validFromMs: '10001' as never, expiresAtMs: '12000' as never }),
    ]) {
      const { instance } = resolver({ complete: true, candidates: [active, highWater] });
      await expect(instance.resolve({
        peerId: PEER_ID,
        carrierPeerId: PEER_ID,
        nowMs: NOW,
      })).resolves.toBeNull();
    }
  });

  it('returns null for conflicting high-water artifacts or multiple current wallets', async () => {
    const first = ethers.Wallet.createRandom();
    const second = ethers.Wallet.createRandom();
    const conflictA = await binding(first, '4', { expiresAtMs: '11000' as never });
    const conflictB = await binding(first, '4', { expiresAtMs: '12000' as never });
    const otherWallet = await binding(second, '1');

    await expect(resolver({
      complete: true,
      candidates: [conflictA, conflictB],
    }).instance.resolve({ peerId: PEER_ID, carrierPeerId: PEER_ID, nowMs: NOW }))
      .resolves.toBeNull();
    await expect(resolver({
      complete: true,
      candidates: [conflictA, otherWallet],
    }).instance.resolve({ peerId: PEER_ID, carrierPeerId: PEER_ID, nowMs: NOW }))
      .resolves.toBeNull();
  });

  it('returns null for missing, incomplete, invalid, and carrier-mismatched views', async () => {
    const wallet = ethers.Wallet.createRandom();
    const valid = await binding(wallet, '1');
    const invalid = { ...valid, signature: `0x${'00'.repeat(65)}` };
    const cases: Array<{
      set: AgentPeerBindingCandidateSetV1;
      carrierPeerId: string;
    }> = [
      { set: { complete: true, candidates: [] }, carrierPeerId: PEER_ID },
      { set: { complete: false, candidates: [valid] }, carrierPeerId: PEER_ID },
      { set: { complete: true, candidates: [invalid] }, carrierPeerId: PEER_ID },
      { set: { complete: true, candidates: [valid] }, carrierPeerId: OTHER_PEER_ID },
    ];

    for (const { set, carrierPeerId } of cases) {
      await expect(resolver(set).instance.resolve({
        peerId: PEER_ID,
        carrierPeerId,
        nowMs: NOW,
      })).resolves.toBeNull();
    }
  });

  it('rejects a valid wallet signature when the signed peer differs from the carrier query', async () => {
    const wallet = ethers.Wallet.createRandom();
    const otherPeerBinding = await binding(wallet, '1', {
      peerId: parseCanonicalLibp2pPeerIdV1(OTHER_PEER_ID),
    });
    const { instance } = resolver({ complete: true, candidates: [otherPeerBinding] });

    await expect(instance.resolve({
      peerId: PEER_ID,
      carrierPeerId: PEER_ID,
      nowMs: NOW,
    })).resolves.toBeNull();
  });
});
