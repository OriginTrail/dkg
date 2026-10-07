import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  AGENT_DID_PREFIX, toAgentDid, sparqlIri,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import type { WorkspaceAgentRecipient } from './workspace-agent-recipients.js';
import { WorkspaceAgentEncryptionKeyMissingError } from './workspace-recipient-key-errors.js';
import { createWorkspaceAgentKeySource } from './workspace-recipient-key-collect.js';

import { decodePublicKeyCandidate, candidateHasProof, projectPublicKeyRoutes,
  RECIPIENT_KEY_CANDIDATE_LIMIT as STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT,
  type PublicKeyCandidate } from './workspace-recipient-key-candidates.js';

/**
 * Resolve every valid (non-revoked) workspace encryption key registered for a DKG
 * agent.
 *
 * Each agent MAY hold multiple X25519 public encryption keys at once (e.g. mid-
 * rotation, after a custodial daemon re-mint on a node that had never run before,
 * or while different daemons converge on a freshly published key). Each key is
 * authenticated by an EIP-191 signature from the agent's wallet against
 * `computeWorkspaceAgentEncryptionKeyProofPayload`; we MUST encrypt the SWM
 * payload to every authenticated key, otherwise some legitimate recipient daemon
 * will hold a private half that doesn't match any wrapped slot and decryption
 * will fail there.
 *
 * Keys can be explicitly retired by emitting wallet-signed revocation triples on
 * the key URI (`dkg:revokedAt`, `dkg:revokedBy`, `dkg:encryptionKeyRevocationProof`
 * over `computeWorkspaceAgentEncryptionKeyRevocationPayload`). A revocation is
 * honoured only when the proof ecrecovers to the agent's wallet; bogus revocation
 * triples are ignored so they can't be used to brick an honest peer's key.
 */
export async function resolveWorkspaceAgentRecipientKeys(
  store: TripleStore,
  agentAddress: string,
  options: Readonly<{
    excludeGraphUris?: readonly string[];
    requiredPeerId?: string;
  }> = {},
): Promise<WorkspaceAgentRecipient[]> {
  const checksum = ethers.getAddress(agentAddress);
  // Read the historical checksum-cased subject alongside the canonical shared-core form.
  const agentUri = `${AGENT_DID_PREFIX}${checksum}`;
  const lowerAgentUri = toAgentDid(checksum);
  const agentUriValues = agentUri === lowerAgentUri ? `<${agentUri}>` : `<${agentUri}> <${lowerAgentUri}>`;
  const excludedGraphs = [...new Set(options.excludeGraphUris ?? [])].map(sparqlIri);
  const graphFilter = excludedGraphs.length === 0
    ? ''
    : `FILTER (?g NOT IN (${excludedGraphs.join(', ')}))`;
  const source = await createWorkspaceAgentKeySource(store, checksum, agentUriValues, graphFilter);
  // The legacy flat RDF shape keeps every rotated key and proof on the agent
  // subject forever. Scan distinct keys before joining route metadata so an
  // authenticated retired history does not consume the live fanout cap. Each
  // page is fixed-size and keyset-paged (OFFSET would become quadratic and can
  // tear under concurrent appends). Only a wallet-verified revocation earns a
  // history exemption; a bare `revokedAt` marker remains an active/untrusted
  // candidate and therefore consumes the strict 64-key budget.
  const activeKeyCandidates = new Map<string, PublicKeyCandidate>();
  let sawAnyKeyCandidate = false;
  let sawMalformedKey = false;
  let unretiredKeyCandidateCount = 0;
  const verifiedRetiredKeyIds = new Set<string>();

  for await (const keys of source.keyPages()) {
    sawAnyKeyCandidate = true;

    const decodedPage: Array<{
      encodedPublicKey: string;
      publicKeyBytes?: Uint8Array;
      recipientKeyId?: string;
    }> = [];
    const revocationCandidates = new Map<string, PublicKeyCandidate>();
    for (const encodedPublicKey of keys) {
      let publicKeyBytes: Uint8Array | undefined;
      let recipientKeyId: string | undefined;
      const candidate = decodePublicKeyCandidate(checksum, encodedPublicKey);
      if (candidate) {
        ({ publicKeyBytes, recipientKeyId } = candidate);
        revocationCandidates.set(recipientKeyId, candidate);
      }
      decodedPage.push({ encodedPublicKey, publicKeyBytes, recipientKeyId });
    }

    const revokedKeyIds = await source.readRetirements([...revocationCandidates.values()]);
    for (const candidate of decodedPage) {
      if (candidate.recipientKeyId && revokedKeyIds.has(candidate.recipientKeyId)) {
        // Count unique cryptographic key ids rather than lexical RDF aliases:
        // one authenticated retirement grants exactly one proof-history credit.
        verifiedRetiredKeyIds.add(candidate.recipientKeyId);
        continue;
      }

      unretiredKeyCandidateCount += 1;
      if (unretiredKeyCandidateCount > STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT) {
        throw new Error(
          `Too many public encryption-key candidates for DKG agent ${checksum}`,
        );
      }
      if (!candidate.publicKeyBytes || !candidate.recipientKeyId) {
        sawMalformedKey = true;
        continue;
      }
      activeKeyCandidates.set(candidate.recipientKeyId, {
        encodedPublicKey: candidate.encodedPublicKey,
        publicKeyBytes: candidate.publicKeyBytes,
        recipientKeyId: candidate.recipientKeyId,
      });
    }

  }

  if (!sawAnyKeyCandidate) {
    throw new WorkspaceAgentEncryptionKeyMissingError([checksum]);
  }
  if (activeKeyCandidates.size === 0) {
    if (unretiredKeyCandidateCount === 0 && verifiedRetiredKeyIds.size > 0) {
      throw new Error(`All registered public encryption keys for DKG agent ${checksum} have been revoked`);
    }
    if (sawMalformedKey) {
      throw new Error(`Unverifiable public encryption key for DKG agent ${checksum}`);
    }
    throw new Error(`Missing public encryption key for DKG agent ${checksum}`);
  }

  // Proofs use the same legacy flat shape and therefore have no RDF-level
  // key association. Scan them in bounded keyset pages. Each independently
  // authenticated retired key grants one historical-proof slot; everything
  // else shares the original 64-row active/junk budget. This lets arbitrary
  // valid retire-old history pass while the 65th surplus proof still fails.
  const verifiedProofKeyIds = new Set<string>();
  let proofCandidateCount = 0;
  const proofCandidateLimit = verifiedRetiredKeyIds.size + STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT;
  for await (const proofs of source.proofPages()) {
    for (const proof of proofs) {
      proofCandidateCount += 1;
      if (proofCandidateCount > proofCandidateLimit) {
        throw new Error(
          `Too many public encryption-key proof candidates for DKG agent ${checksum}`,
        );
      }
      for (const candidate of activeKeyCandidates.values()) {
        if (verifiedProofKeyIds.has(candidate.recipientKeyId)) continue;
        if (candidateHasProof(candidate, checksum, proof)) {
          verifiedProofKeyIds.add(candidate.recipientKeyId);
          break;
        }
      }
    }

  }

  let sawUntrustedOnly = false;
  let sawInvalidProof = false;
  for (const candidate of activeKeyCandidates.values()) {
    if (verifiedProofKeyIds.has(candidate.recipientKeyId)) continue;
    if (proofCandidateCount === 0) sawUntrustedOnly = true;
    else sawInvalidProof = true;
  }

  const proofVerifiedKeys = [...activeKeyCandidates.values()].filter((candidate) => (
    verifiedProofKeyIds.has(candidate.recipientKeyId)
  ));
  if (proofVerifiedKeys.length === 0) {
    if (sawUntrustedOnly) {
      throw new Error(`Untrusted RDF-only public encryption key for DKG agent ${checksum}`);
    }
    if (sawInvalidProof) {
      throw new Error(`Spoofed or unverifiable public encryption key for DKG agent ${checksum}`);
    }
    throw new Error(`Missing public encryption key for DKG agent ${checksum}`);
  }

  // Only proof-verified, unrevoked keys participate in the route join. A key
  // can have one peerless row in addition to its peer-bound rows, so admit that
  // bounded suppression overhead before enforcing the global 64-route fanout.
  const routes = await source.routes(proofVerifiedKeys);
  const verifiedKeys = projectPublicKeyRoutes(checksum, agentUri, proofVerifiedKeys, routes, options.requiredPeerId);
  if (verifiedKeys.size === 0) {
    if (await source.hasUnsupportedAlgorithm(proofVerifiedKeys)) {
      throw new Error(`Unsupported public encryption key algorithm for DKG agent ${checksum}; expected X25519`);
    }
    throw new Error(`Untrusted RDF-only public encryption key for DKG agent ${checksum}`);
  }

  const revokedKeyIds = await source.finalRevocations(proofVerifiedKeys);
  for (const id of revokedKeyIds) {
    // Revocation is keyed by recipientKeyId, not by transport provenance, so
    // retiring a key removes every peer-bound variant at once.
    verifiedKeys.delete(id);
  }

  if (verifiedKeys.size === 0) {
    throw new Error(`All registered public encryption keys for DKG agent ${checksum} have been revoked`);
  }

  return [...verifiedKeys.values()].flatMap((variants) => [...variants.values()]);
}

