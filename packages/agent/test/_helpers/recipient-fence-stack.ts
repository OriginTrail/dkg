// SPDX-License-Identifier: Apache-2.0

// The real store, projection and production hooks shared by the key/route fence tests (GH#3067).
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';

import { ContextGraphMetaProjection } from '../../src/context-graph-meta-projection.js';
import { createListContextGraphsCacheInvalidatingStore } from '../../src/dkg-agent-base.js';
import { createProjectionMutationObserver } from '../../src/internal/projection-mutation-observer.js';

export const AGENT = 'did:dkg:agent:0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
export const KEY_IRI = `${AGENT.toLowerCase()}#x25519-0123456789abcdef0123456789abcdef`;
export const CG_DID = 'did:dkg:context-graph:0xabc/proj';
export const PROFILE_GRAPH = 'did:dkg:context-graph:agents';
export const JOIN_CACHE = 'urn:dkg:local:join-encryption-key-cache';
export const META_GRAPH = `${CG_DID}/_meta`;
export const SWM_META_GRAPH = `${CG_DID}/_shared_memory_meta`;
export const CONTROL_GRAPH = 'urn:dkg:promote-queue:control-plane';
export const KA_GRAPH = `${CG_DID}/assertion/0xdef/notes`;
export const KA_UAL = 'did:dkg:base:84532/0x1234567890123456789012345678901234567890/7';
export const NAME = 'http://schema.org/name';
export const MEMORY_LAYER = 'http://dkg.io/ontology/memoryLayer';

export const quad = (subject: string, predicate: string, graph: string): Quad => ({ subject, predicate, object: '"v"', graph });
export const keyFact = (graph = PROFILE_GRAPH, predicate = DKG_ONTOLOGY.DKG_PEER_ID): Quad => quad(AGENT, predicate, graph);

export async function stack(options: { inner?: (store: OxigraphStore) => TripleStore } = {}) {
  const store = new OxigraphStore();
  const projection = new ContextGraphMetaProjection(store);
  const wrapper = createListContextGraphsCacheInvalidatingStore(
    options.inner ? options.inner(store) : store,
    () => {},
    createProjectionMutationObserver(() => projection),
  );
  await store.insert([
    keyFact(PROFILE_GRAPH, DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY),
    keyFact(PROFILE_GRAPH, DKG_ONTOLOGY.DKG_PEER_ID),
    quad(KEY_IRI, DKG_ONTOLOGY.DKG_REVOKED_AT, PROFILE_GRAPH),
    quad(CG_DID, DKG_ONTOLOGY.DKG_ACCESS_POLICY, META_GRAPH),
    quad(KA_UAL, NAME, META_GRAPH),
    quad('urn:dkg:share:s1', NAME, SWM_META_GRAPH),
    quad('urn:x:doc', NAME, KA_GRAPH),
  ]);
  await projection.recipientKeyRouteFence.ensureReady();
  const fence = projection.recipientKeyRouteFence;
  return { store, projection, wrapper, fence };
}

