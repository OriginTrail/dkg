// SPDX-License-Identifier: Apache-2.0

/**
 * What a complete sub-graph registration is, the one operation that makes one
 * for a sub-graph a node learns of from replicated data, and the refusal of a
 * write into a sub-graph the node does not know.
 *
 * A node registers a sub-graph in its context graph's `_meta` when content of
 * that sub-graph reaches it: a live shared-memory write (`workspace-handler.ts`),
 * a gossip publish and a shared-memory sync (both in the agent package). They
 * share this check and this operation, so a change to what makes a
 * registration complete is made here once. The callers keep what is theirs:
 * when to register, who is named as the creator, and whom they tell.
 *
 * A write into a sub-graph this node has not registered is refused with
 * {@link SubGraphNotFoundError}, after the publisher's resolver, when it has
 * one, could not register it either: the agent's resolver asks the graph's
 * peers, so a member can write into a sub-graph the owner registered before
 * any of its content has reached the member (#3293).
 */

import { assertSafeIri, contextGraphSubGraphUri } from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { generateSubGraphRegistration, type SubGraphRegistration } from './metadata.js';

export interface SubGraphRegistrationReadOptions {
  /** Store diagnostics label for the registration check. */
  readonly source?: string;
}

/** Code of {@link SubGraphNotFoundError}; the daemon answers it with HTTP 400. */
export const SUB_GRAPH_NOT_FOUND_CODE = 'SUB_GRAPH_NOT_FOUND';

/** A write names a sub-graph that is not registered on this node and that its resolver did not find. */
export class SubGraphNotFoundError extends Error {
  readonly code = SUB_GRAPH_NOT_FOUND_CODE;

  constructor(
    readonly contextGraphId: string,
    readonly subGraphName: string,
    /** What the resolver found out, for the message. */
    readonly detail?: string,
  ) {
    super(
      `Sub-graph "${subGraphName}" has not been registered in context graph "${contextGraphId}"`
      + (detail ? ` (${detail})` : '')
      + '. Create it first: createSubGraph(), or POST /api/sub-graph/create.',
    );
    this.name = 'SubGraphNotFoundError';
  }
}

/** What a resolver found for a sub-graph this node had not registered. */
export interface UnregisteredSubGraphResolution {
  /** True when the sub-graph is registered on this node now. */
  readonly registered: boolean;
  /** Why it is not, when it is not; it ends up in the refusal's message. */
  readonly detail?: string;
}

/** Looks up a sub-graph a write names that this node has not registered, and registers it when found. */
export type UnregisteredSubGraphResolver = (
  contextGraphId: string,
  subGraphName: string,
) => Promise<UnregisteredSubGraphResolution>;

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

/**
 * Admit a write into `subGraphName`: return when the sub-graph is registered
 * on this node, or when `resolve` registers it; otherwise throw
 * {@link SubGraphNotFoundError}.
 */
export async function requireSubGraphRegistration(
  store: TripleStore,
  contextGraphId: string,
  subGraphName: string,
  resolve?: UnregisteredSubGraphResolver,
): Promise<void> {
  if (await hasSubGraphRegistration(store, contextGraphId, subGraphName)) return;
  const resolution = resolve === undefined ? undefined : await resolve(contextGraphId, subGraphName);
  if (resolution?.registered === true && await hasSubGraphRegistration(store, contextGraphId, subGraphName)) return;
  throw new SubGraphNotFoundError(contextGraphId, subGraphName, resolution?.detail);
}
