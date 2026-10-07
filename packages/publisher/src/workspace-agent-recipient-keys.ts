import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  decodeWorkspaceEncryptionKey, encodeWorkspaceEncryptionKey,
  AGENT_DID_PREFIX, toAgentDid, workspaceAgentEncryptionKeyId, sparqlIri, sparqlString,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { WORKSPACE_RECIPIENT_DEPENDENCIES } from './workspace-recipient-dependencies.js';
import { WorkspaceAgentEncryptionKeyMissingError, type WorkspaceAgentRecipient } from './workspace-agent-recipients.js';
import { loadVerifiedRevokedKeyIds, verifyAgentEncryptionKeyProof, stringBinding, stripRdfLiteral } from './workspace-recipient-key-verification.js';
import { collectCompleteWorkspaceAgentKeys } from './workspace-recipient-key-collect.js';

const { keyRoute: KEY_ROUTE } = WORKSPACE_RECIPIENT_DEPENDENCIES;
const STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT = 64;
const RECIPIENT_KEY_HISTORY_PAGE_SIZE = 64;

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
  const complete = await collectCompleteWorkspaceAgentKeys(store, checksum, agentUri, agentUriValues, graphFilter, options.requiredPeerId);
  if (complete !== null) return complete;
  // The legacy flat RDF shape keeps every rotated key and proof on the agent
  // subject forever. Scan distinct keys before joining route metadata so an
  // authenticated retired history does not consume the live fanout cap. Each
  // page is fixed-size and keyset-paged (OFFSET would become quadratic and can
  // tear under concurrent appends). Only a wallet-verified revocation earns a
  // history exemption; a bare `revokedAt` marker remains an active/untrusted
  // candidate and therefore consumes the strict 64-key budget.
  const activeKeyCandidates = new Map<string, {
    encodedPublicKey: string;
    publicKeyBytes: Uint8Array;
    recipientKeyId: string;
  }>();
  let sawAnyKeyCandidate = false;
  let sawMalformedKey = false;
  let unretiredKeyCandidateCount = 0;
  const verifiedRetiredKeyIds = new Set<string>();
  let keyCursor: string | undefined;

  while (true) {
    const cursorFilter = keyCursor === undefined
      ? ''
      : `FILTER (?key > ${sparqlString(keyCursor)})`;
    const page = await store.query(
      `SELECT DISTINCT ?key WHERE {
        VALUES ?agentSubject { ${agentUriValues} }
        GRAPH ?g {
          ?agentSubject <${KEY_ROUTE.publicKey}> ?rawKey .
        }
        BIND (STR(?rawKey) AS ?key)
        ${graphFilter}
        ${cursorFilter}
      }
      ORDER BY ?key
      LIMIT ${RECIPIENT_KEY_HISTORY_PAGE_SIZE}`,
    );
    if (page.type !== 'bindings' || page.bindings.length === 0) break;
    sawAnyKeyCandidate = true;

    const decodedPage: Array<{
      encodedPublicKey: string;
      publicKeyBytes?: Uint8Array;
      recipientKeyId?: string;
    }> = [];
    const revocationCandidates = new Map<string, WorkspaceAgentRecipient>();
    for (const row of page.bindings) {
      const publicKey = stringBinding(row['key']);
      const encodedPublicKey = publicKey ? stripRdfLiteral(publicKey) : '';
      let publicKeyBytes: Uint8Array | undefined;
      let recipientKeyId: string | undefined;
      if (encodedPublicKey) {
        try {
          publicKeyBytes = decodeWorkspaceEncryptionKey(encodedPublicKey);
          if (encodeWorkspaceEncryptionKey(publicKeyBytes) !== encodedPublicKey) {
            throw new Error('Non-canonical workspace encryption key');
          }
          recipientKeyId = workspaceAgentEncryptionKeyId(checksum, publicKeyBytes);
          revocationCandidates.set(recipientKeyId, {
            purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
            recipientId: agentUri,
            recipientKeyId,
            encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
            publicKeyBytes,
            agentAddress: checksum,
          });
        } catch {
          // Malformed candidates cannot earn a retirement exemption because a
          // valid revocation proof commits to canonical 32-byte key material.
        }
      }
      decodedPage.push({ encodedPublicKey, publicKeyBytes, recipientKeyId });
    }

    const revokedKeyIds = await loadVerifiedRevokedKeyIds(
      store,
      checksum,
      [...revocationCandidates.values()],
      graphFilter,
    );
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

    const lastKey = stringBinding(page.bindings.at(-1)?.['key']);
    const nextCursor = lastKey ? stripRdfLiteral(lastKey) : undefined;
    if (!nextCursor || (keyCursor !== undefined && nextCursor <= keyCursor)) {
      throw new Error(`Non-monotonic public encryption-key history for DKG agent ${checksum}`);
    }
    keyCursor = nextCursor;
    if (page.bindings.length < RECIPIENT_KEY_HISTORY_PAGE_SIZE) break;
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
  let proofCursor: string | undefined;
  const proofCandidateLimit = verifiedRetiredKeyIds.size + STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT;
  while (true) {
    const cursorFilter = proofCursor === undefined
      ? ''
      : `FILTER (?proof > ${sparqlString(proofCursor)})`;
    const page = await store.query(
      `SELECT DISTINCT ?proof WHERE {
        VALUES ?agentSubject { ${agentUriValues} }
        GRAPH ?g {
          ?agentSubject <${KEY_ROUTE.proof}> ?rawProof .
        }
        BIND (STR(?rawProof) AS ?proof)
        ${graphFilter}
        ${cursorFilter}
      }
      ORDER BY ?proof
      LIMIT ${RECIPIENT_KEY_HISTORY_PAGE_SIZE}`,
    );
    if (page.type !== 'bindings' || page.bindings.length === 0) break;

    for (const row of page.bindings) {
      const proof = stringBinding(row['proof']);
      if (!proof) continue;
      proofCandidateCount += 1;
      if (proofCandidateCount > proofCandidateLimit) {
        throw new Error(
          `Too many public encryption-key proof candidates for DKG agent ${checksum}`,
        );
      }
      const cleanProof = stripRdfLiteral(proof);
      for (const candidate of activeKeyCandidates.values()) {
        if (verifiedProofKeyIds.has(candidate.recipientKeyId)) continue;
        if (verifyAgentEncryptionKeyProof(checksum, candidate.publicKeyBytes, cleanProof)) {
          verifiedProofKeyIds.add(candidate.recipientKeyId);
          break;
        }
      }
    }

    const lastProof = stringBinding(page.bindings.at(-1)?.['proof']);
    const nextCursor = lastProof ? stripRdfLiteral(lastProof) : undefined;
    if (!nextCursor || (proofCursor !== undefined && nextCursor <= proofCursor)) {
      throw new Error(`Non-monotonic public encryption-key proof history for DKG agent ${checksum}`);
    }
    proofCursor = nextCursor;
    if (page.bindings.length < RECIPIENT_KEY_HISTORY_PAGE_SIZE) break;
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
  const activeKeyValues = proofVerifiedKeys
    .map((candidate) => sparqlString(candidate.encodedPublicKey))
    .join(' ');
  const routeRowLimit = STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT + proofVerifiedKeys.length + 1;
  const result = await store.query(
    `SELECT DISTINCT ?key ?peerId WHERE {
      VALUES ?agentSubject { ${agentUriValues} }
      VALUES ?key { ${activeKeyValues} }
      GRAPH ?g {
        ?agentSubject <${KEY_ROUTE.publicKey}> ?rawKey ;
          <${KEY_ROUTE.algorithm}> ${sparqlString(WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519)} .
        OPTIONAL { ?agentSubject <${KEY_ROUTE.peerId}> ?peerId }
      }
      ${graphFilter}
      FILTER (STR(?rawKey) = ?key)
    }
    LIMIT ${routeRowLimit}`,
  );

  // One wallet-verified key can be replicated in several profile graphs. Keep
  // distinct peer bindings for that key so a later Context Graph allowlist can
  // select the reachable variant. A peer-bound copy supersedes a peerless copy:
  // retaining both would incorrectly make the transport projection incomplete.
  const verifiedKeys = new Map<
    string,
    Map<string | undefined, WorkspaceAgentRecipient>
  >();
  const activeKeyByEncodedValue = new Map(
    proofVerifiedKeys.map((candidate) => [candidate.encodedPublicKey, candidate]),
  );

  if (result.type === 'bindings') for (const row of result.bindings) {
    const publicKey = stringBinding(row['key']);
    const peerId = stringBinding(row['peerId']);
    if (!publicKey) continue;
    const candidate = activeKeyByEncodedValue.get(stripRdfLiteral(publicKey));
    if (!candidate) continue;

    const cleanPeerId = peerId ? stripRdfLiteral(peerId) : undefined;
    if (
      options.requiredPeerId !== undefined
      && cleanPeerId !== options.requiredPeerId
    ) {
      throw new Error(
        `Public encryption key for DKG agent ${checksum} is not bound to the required peer`,
      );
    }

    const { recipientKeyId, publicKeyBytes } = candidate;
    let variants = verifiedKeys.get(recipientKeyId);
    if (variants === undefined) {
      variants = new Map();
      verifiedKeys.set(recipientKeyId, variants);
    }
    const recipient = {
      purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
      recipientId: agentUri,
      recipientKeyId,
      encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
      publicKeyBytes,
      agentAddress: checksum,
      peerId: cleanPeerId,
    } satisfies WorkspaceAgentRecipient;
    if (cleanPeerId === undefined) {
      // Do not let query ordering replace a usable peer-bound copy with the
      // same key discovered in a graph that omitted peer provenance.
      if (variants.size === 0) variants.set(undefined, recipient);
      continue;
    }
    variants.delete(undefined);
    variants.set(cleanPeerId, recipient);
  }

  const routeCount = [...verifiedKeys.values()].reduce((count, variants) => count + variants.size, 0);
  if (
    routeCount > STRICT_RECIPIENT_KEY_CANDIDATE_LIMIT
    || (result.type === 'bindings' && result.bindings.length >= routeRowLimit)
  ) {
    throw new Error(
      `Too many public encryption-key candidates for DKG agent ${checksum}`,
    );
  }

  if (verifiedKeys.size === 0) {
    const wrongAlgorithm = await store.query(
      `ASK {
        VALUES ?agentSubject { ${agentUriValues} }
        VALUES ?key { ${activeKeyValues} }
        GRAPH ?g {
          ?agentSubject <${KEY_ROUTE.publicKey}> ?rawKey ;
            <${KEY_ROUTE.algorithm}> ?algorithm .
        }
        ${graphFilter}
        FILTER (
          STR(?rawKey) = ?key
          && STR(?algorithm) != ${sparqlString(WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519)}
        )
      }`,
    );
    if (wrongAlgorithm.type === 'boolean' && wrongAlgorithm.value) {
      throw new Error(`Unsupported public encryption key algorithm for DKG agent ${checksum}; expected X25519`);
    }
    throw new Error(`Untrusted RDF-only public encryption key for DKG agent ${checksum}`);
  }

  const verifiedRecipients = [...verifiedKeys.values()].flatMap((variants) => (
    [...variants.values()]
  ));
  const revokedKeyIds = await loadVerifiedRevokedKeyIds(
    store,
    checksum,
    verifiedRecipients,
    graphFilter,
  );
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

