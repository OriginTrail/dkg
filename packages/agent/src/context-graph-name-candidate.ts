// SPDX-License-Identifier: Apache-2.0

/**
 * Trustless verification of a Context Graph cleartext id learned from outside
 * this node.
 *
 * ContextGraphStorage commits only `nameHash = keccak256(utf8(cleartextId))`;
 * the cleartext is never on-chain. A node that learned a graph from the
 * `ContextGraphCreated` event therefore knows only the hash, while every peer
 * that holds the graph keys its data by the cleartext id. Any source may
 * propose a candidate (a peer, a gossiped profile, a synced ontology row), but
 * a candidate is accepted only when it is a syntactically valid Context Graph
 * id whose commitment equals the on-chain hash. That check needs no trust in
 * whoever proposed it.
 */

import { ethers } from 'ethers';
import {
  CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE,
  DKG_ONTOLOGY,
  validateContextGraphId,
} from '@origintrail-official/dkg-core';

/** `validateContextGraphId` bounds ids at 256 characters; never hash more. */
export const CONTEXT_GRAPH_NAME_CANDIDATE_MAX_LENGTH = 256;

const NAME_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
/**
 * The ontology-graph vocabulary a Context Graph definition is written in.
 * The in-memory scan below and the local-store SPARQL in
 * dkg-agent-cg-name-resolution.ts must agree on it. The binding predicate is
 * core's, shared with every other reader of the binding.
 */
export const CONTEXT_GRAPH_SUBJECT_PREFIX = 'did:dkg:context-graph:';
export { CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE };

/** Canonical lowercase form of a 32-byte name hash, or null when malformed. */
export function normalizeContextGraphNameHash(value: unknown): string | null {
  if (typeof value !== 'string' || !NAME_HASH_PATTERN.test(value)) return null;
  return value.toLowerCase();
}

/** keccak256(utf8(id)) in lowercase hex: the on-chain name commitment. */
export function contextGraphNameCommitmentOf(contextGraphId: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(contextGraphId)).toLowerCase();
}

/**
 * Return `candidate` when it is the cleartext id behind `nameHash`, else null.
 * The length and syntax checks run before hashing, so a huge or garbage value
 * costs nothing. Never throws.
 */
export function verifyContextGraphNameCandidate(
  candidate: unknown,
  nameHash: string,
): string | null {
  const expected = normalizeContextGraphNameHash(nameHash);
  if (expected === null || typeof candidate !== 'string') return null;
  if (candidate.length === 0 || candidate.length > CONTEXT_GRAPH_NAME_CANDIDATE_MAX_LENGTH) {
    return null;
  }
  if (!validateContextGraphId(candidate).valid) return null;
  return contextGraphNameCommitmentOf(candidate) === expected ? candidate : null;
}

/** First verified candidate of an iterable, or null. */
export function findVerifiedContextGraphName(
  candidates: Iterable<unknown>,
  nameHash: string,
): string | null {
  for (const candidate of candidates) {
    const verified = verifyContextGraphNameCandidate(candidate, nameHash);
    if (verified !== null) return verified;
  }
  return null;
}

/**
 * Scan ontology-graph quads for the definition of the graph behind
 * `nameHash`. Only Context Graph definition subjects (`rdf:type
 * dkg:ContextGraph`) and registration subjects (`dkg:ContextGraphOnChainId`)
 * are considered. The id is the full remainder after the subject prefix: ids
 * may themselves contain `/`. Non-matching subjects are dropped here and
 * never returned, logged or retained; the same graph also carries rows for
 * curated graphs.
 */
export function findContextGraphNameInOntologyQuads(
  quads: Iterable<{ subject: string; predicate: string; object: string }>,
  nameHash: string,
): string | null {
  for (const quad of quads) {
    if (!quad.subject.startsWith(CONTEXT_GRAPH_SUBJECT_PREFIX)) continue;
    const definition = quad.predicate === DKG_ONTOLOGY.RDF_TYPE
      && quad.object === DKG_ONTOLOGY.DKG_CONTEXT_GRAPH;
    if (!definition && quad.predicate !== CONTEXT_GRAPH_ON_CHAIN_ID_PREDICATE) continue;
    const verified = verifyContextGraphNameCandidate(
      quad.subject.slice(CONTEXT_GRAPH_SUBJECT_PREFIX.length),
      nameHash,
    );
    if (verified !== null) return verified;
  }
  return null;
}
