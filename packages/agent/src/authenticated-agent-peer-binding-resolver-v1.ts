// SPDX-License-Identifier: Apache-2.0

/**
 * Fail-closed resolver for wallet-authorized libp2p peer bindings.
 *
 * The source contract is explicit about completeness because uniqueness and
 * revocation cannot be derived safely from a truncated `LIMIT 1` view.
 */

import {
  parseCanonicalLibp2pPeerIdV1,
  verifySignedAgentPeerBindingV1,
  type CanonicalLibp2pPeerIdV1,
  type EvmAddressV1,
  type SignedAgentPeerBindingV1,
  type VerifiedAgentPeerBindingV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

export const MAX_AGENT_PEER_BINDING_CANDIDATES_V1 = 64;

/**
 * An authoritative complete view for one exact canonical peer ID.
 *
 * `complete=true` is a security assertion owned by the source adapter: it MUST
 * mean that no higher wallet version or conflicting wallet claim can be
 * omitted. A plain eventually-consistent RDF query cannot make that assertion
 * by itself; such an adapter must return `complete=false` until backed by an
 * authoritative checkpoint/current-finalized registry or equivalent source.
 */
export interface AgentPeerBindingCandidateSetV1 {
  /** False when the storage query was truncated, interrupted, or otherwise incomplete. */
  readonly complete: boolean;
  readonly candidates: readonly unknown[];
}

export interface AgentPeerBindingCandidateSourceV1 {
  loadPeerBindingCandidates(
    peerId: CanonicalLibp2pPeerIdV1,
  ): Promise<AgentPeerBindingCandidateSetV1>;
}

export interface ResolveAuthenticatedAgentPeerBindingInputV1 {
  /** Peer being resolved. Must use the exact canonical libp2p representation. */
  readonly peerId: string;
  /** Authenticated carrier peer from the live libp2p connection. */
  readonly carrierPeerId: string;
  /** Override for deterministic tests. Defaults to Date.now(). */
  readonly nowMs?: number;
}

export interface AuthenticatedAgentPeerBindingV1 {
  readonly peerId: CanonicalLibp2pPeerIdV1;
  readonly agentAddress: EvmAddressV1;
  readonly bindingVersion: SignedAgentPeerBindingV1['bindingVersion'];
  readonly validFromMs: SignedAgentPeerBindingV1['validFromMs'];
  readonly expiresAtMs: SignedAgentPeerBindingV1['expiresAtMs'];
}

export class AuthenticatedAgentPeerBindingResolverV1 {
  constructor(private readonly source: AgentPeerBindingCandidateSourceV1) {
    if (typeof source?.loadPeerBindingCandidates !== 'function') {
      throw new TypeError('agent peer binding candidate source is incomplete');
    }
  }

  /** Resolve exactly one current wallet binding, or null on every fail-closed outcome. */
  async resolve(
    input: ResolveAuthenticatedAgentPeerBindingInputV1,
  ): Promise<Readonly<AuthenticatedAgentPeerBindingV1> | null> {
    let peerId: CanonicalLibp2pPeerIdV1;
    let carrierPeerId: CanonicalLibp2pPeerIdV1;
    try {
      peerId = parseCanonicalLibp2pPeerIdV1(input.peerId);
      carrierPeerId = parseCanonicalLibp2pPeerIdV1(input.carrierPeerId);
    } catch {
      return null;
    }
    if (carrierPeerId !== peerId) return null;

    let nowMs: number;
    try {
      nowMs = input.nowMs ?? Date.now();
    } catch {
      return null;
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) return null;

    let candidateSet: AgentPeerBindingCandidateSetV1;
    try {
      candidateSet = await this.source.loadPeerBindingCandidates(peerId);
    } catch {
      return null;
    }
    let candidates: readonly unknown[];
    try {
      if (
        candidateSet?.complete !== true
        || !Array.isArray(candidateSet.candidates)
        || candidateSet.candidates.length < 1
        || candidateSet.candidates.length > MAX_AGENT_PEER_BINDING_CANDIDATES_V1
      ) {
        return null;
      }
      candidates = Object.freeze(Array.from(candidateSet.candidates));
    } catch {
      return null;
    }

    const verified: Readonly<VerifiedAgentPeerBindingV1>[] = [];
    for (const candidate of candidates) {
      let binding: Readonly<VerifiedAgentPeerBindingV1>;
      try {
        binding = await verifySignedAgentPeerBindingV1(
          candidate,
          verifyCanonicalEip191WalletSignature,
        );
      } catch {
        // The source promises every row is a candidate for this peer. An invalid
        // row therefore makes the supposedly complete current view ambiguous.
        return null;
      }
      if (binding.peerId !== peerId) return null;
      verified.push(binding);
    }

    const byAgent = new Map<EvmAddressV1, Readonly<VerifiedAgentPeerBindingV1>[]>();
    for (const binding of verified) {
      const existing = byAgent.get(binding.agentAddress);
      if (existing === undefined) byAgent.set(binding.agentAddress, [binding]);
      else existing.push(binding);
    }

    const active: Readonly<VerifiedAgentPeerBindingV1>[] = [];
    for (const candidates of byAgent.values()) {
      let highWater = -1n;
      for (const candidate of candidates) {
        const version = BigInt(candidate.bindingVersion);
        if (version > highWater) highWater = version;
      }
      const current = candidates.filter(
        (candidate) => BigInt(candidate.bindingVersion) === highWater,
      );
      const uniquePayloads = new Map<string, Readonly<VerifiedAgentPeerBindingV1>>();
      for (const candidate of current) {
        uniquePayloads.set(bindingSemanticKey(candidate), candidate);
      }
      if (uniquePayloads.size !== 1) return null;

      const selected = uniquePayloads.values().next().value;
      if (selected === undefined) return null;
      // Never fall back below the high-water artifact. Revoked, future, and
      // expired versions all terminate this wallet's current claim.
      if (
        selected.state === 'revoked'
        || BigInt(selected.validFromMs) > BigInt(nowMs)
        || BigInt(selected.expiresAtMs) <= BigInt(nowMs)
      ) {
        continue;
      }
      active.push(selected);
    }

    if (active.length !== 1) return null;
    const binding = active[0];
    return Object.freeze({
      peerId: binding.peerId,
      agentAddress: binding.agentAddress,
      bindingVersion: binding.bindingVersion,
      validFromMs: binding.validFromMs,
      expiresAtMs: binding.expiresAtMs,
    });
  }
}

/** Strict canonical low-s EIP-191 verification over the core signing bytes. */
export function verifyCanonicalEip191WalletSignature(
  message: Uint8Array,
  signatureHex: string,
  expectedAgentAddress: EvmAddressV1,
): boolean {
  try {
    const signature = ethers.Signature.from(signatureHex);
    if (signature.serialized !== signatureHex) return false;
    return ethers.verifyMessage(message, signature).toLowerCase() === expectedAgentAddress;
  } catch {
    return false;
  }
}

function bindingSemanticKey(binding: VerifiedAgentPeerBindingV1): string {
  return [
    binding.kind,
    binding.schemaVersion,
    binding.bindingVersion,
    binding.agentAddress,
    binding.peerId,
    binding.validFromMs,
    binding.expiresAtMs,
    binding.state,
  ].join('\n');
}
