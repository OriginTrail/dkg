// SPDX-License-Identifier: Apache-2.0

/**
 * What a complete sub-graph registration is, and the one operation that makes
 * one for a sub-graph a node learns of from replicated data.
 *
 * A node registers a sub-graph in its context graph's `_meta` when content of
 * that sub-graph reaches it: a live shared-memory write (`workspace-handler.ts`),
 * a gossip publish and a shared-memory sync (both in the agent package). They
 * share this check and this operation, so a change to what makes a
 * registration complete is made here once. The callers keep what is theirs:
 * when to register, who is named as the creator, and whom they tell.
 */

import { assertSafeIri, contextGraphSubGraphUri } from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { generateSubGraphRegistration, type SubGraphRegistration } from './metadata.js';

export interface SubGraphRegistrationReadOptions {
  /** Store diagnostics label for the registration check. */
  readonly source?: string;
}

/** What {@link ensureSubGraphRegistration} did. */
export interface SubGraphRegistrationOutcome {
  /** True when this call inserted the registration; false when a complete one was there. */
  readonly registered: boolean;
  /** The quads this call inserted, for the caller's metadata notifications; empty when it inserted none. */
  readonly quads: readonly Quad[];
}

/** True when `_meta` holds a complete registration of the sub-graph: its type, its name and its creator. */
export async function hasSubGraphRegistration(
  store: TripleStore,
  contextGraphId: string,
  subGraphName: string,
  options: SubGraphRegistrationReadOptions = {},
): Promise<boolean> {
  const sparql = `ASK { GRAPH <did:dkg:context-graph:${assertSafeIri(contextGraphId)}/_meta> {
    <${assertSafeIri(contextGraphSubGraphUri(contextGraphId, subGraphName))}> a <http://dkg.io/ontology/SubGraph> ;
      <http://schema.org/name> ${JSON.stringify(subGraphName)} ;
      <http://dkg.io/ontology/createdBy> ?createdBy .
  } }`;
  const result = options.source === undefined
    ? await store.query(sparql)
    : await store.query(sparql, { source: options.source });
  return result.type === 'boolean' && result.value;
}

/**
 * Register the sub-graph unless a complete registration is there. An existing
 * registration is left exactly as it is, whoever made it, so repeating the
 * call changes nothing.
 */
export async function ensureSubGraphRegistration(
  store: TripleStore,
  registration: SubGraphRegistration,
  options: SubGraphRegistrationReadOptions = {},
): Promise<SubGraphRegistrationOutcome> {
  if (await hasSubGraphRegistration(store, registration.contextGraphId, registration.subGraphName, options)) {
    return { registered: false, quads: [] };
  }
  const quads = generateSubGraphRegistration(registration);
  await store.insert(quads);
  return { registered: true, quads };
}
