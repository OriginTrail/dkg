// SPDX-License-Identifier: Apache-2.0
/**
 * The participant-agent roster of a context graph registration. A curator that
 * is not the registration's chain signer (the calling agent under EOA
 * auto-promotion, or an author key of the node's external signer on a
 * PCA-backed graph) is recorded as a participant agent of the graph, so the
 * shared-memory agent gate accepts its writes, and the on-chain registration
 * lists it too.
 */
import { ethers } from 'ethers';
import { DKG_ONTOLOGY, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS } from './dkg-agent-constants.js';

/** What adding a participant agent needs from the node. */
export interface RegistrationRoster {
  /** Persists context graph metadata quads. */
  insert(quads: Quad[]): Promise<void>;
  /** Invalidates the metadata projection of a context graph. */
  markDirty(contextGraphId: string): void;
  /** The participant agents a context graph lists now. */
  participantAgents(contextGraphId: string): Promise<string[]>;
}

/**
 * Add `agent` as a participant agent of the context graph and return the
 * participant agents to register on-chain. The roster with `agent` added
 * (checksummed, without duplicates) is validated first: one that would exceed
 * what a registration may carry is refused, with `adding` describing the
 * addition, and nothing is stored. Storing it is idempotent (RDF triples
 * deduplicate), so an agent the roster already lists keeps its size.
 */
export async function addRegistrationParticipantAgent(
  roster: RegistrationRoster,
  contextGraphId: string,
  agent: string,
  adding: string,
): Promise<string[]> {
  const participant = ethers.getAddress(agent);
  const current = await roster.participantAgents(contextGraphId);
  const listed = current.some((address) => address.toLowerCase() === participant.toLowerCase());
  if (current.length + (listed ? 0 : 1) > MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS) {
    throw new Error(
      `Context graph "${contextGraphId}" cannot be registered on-chain: participantAgents cannot exceed ` +
      `${MAX_CONTEXT_GRAPH_PARTICIPANT_AGENTS} addresses after ${adding} as a participant.`,
    );
  }
  await roster.insert([{
    subject: `did:dkg:context-graph:${contextGraphId}`,
    predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT,
    object: `"${participant}"`,
    graph: contextGraphMetaUri(contextGraphId),
  }]);
  roster.markDirty(contextGraphId);
  return roster.participantAgents(contextGraphId);
}
