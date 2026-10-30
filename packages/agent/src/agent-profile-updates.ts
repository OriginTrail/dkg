// SPDX-License-Identifier: Apache-2.0

/**
 * How an update of an agent's profile enters this node's `agents` graph.
 *
 * Every run of an agent wallet writes its profile to the same subject, and
 * nothing in a profile's triples ties one `dkg:peerId` to one `dkg:lastSeen`.
 * Added to what the subject holds, an update leaves a union no reader can take
 * apart: the wallet maps to every peer it ever ran on, and nothing says which
 * of them is current. So the fields that describe a node are replaced in the
 * store, and a subject holds the node fields of one profile:
 *
 * - A whole profile (a peer id and a usable `dkg:lastSeen`) newer than what the
 *   subject holds replaces its node fields. An older one, or one delivered
 *   again, adds none of them.
 * - Part of a profile, as when a fetch stops inside one, cannot be ordered. It
 *   only fills fields the subject does not hold at all.
 * - A profile that lists several peers, from a node that still keeps the union,
 *   is taken as a whole when it is the newest: its newest `dkg:lastSeen` stays,
 *   and its peers stay unordered. A single-peer profile with the same
 *   `dkg:lastSeen` settles which of them is current.
 * - A `dkg:lastSeen` ahead of this node's clock by more than the allowance says
 *   nothing about the profile's age, and is not stored.
 * - A heartbeat that changes nothing but the date is written once per
 *   {@link AGENT_LAST_SEEN_WRITE_INTERVAL_MS}. Every agent sends one each 20
 *   minutes, and each store write ends what this node's caches hold.
 *
 * Encryption keys are not node fields, and stay on the subject. A sender must
 * encrypt to every key the wallet has proved (`resolveWorkspaceAgentRecipientKeys`),
 * since another of the wallet's nodes may hold the private half, and only a
 * wallet-signed revocation retires one. A newer `dkg:lastSeen` proves nothing
 * of the kind.
 *
 * New values are written before old ones go, so a reader always finds a peer,
 * and a crash in between leaves a union that the next update replaces.
 */

import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  isSafeIri,
  sparqlIri,
} from '@origintrail-official/dkg-core';
import { rdfLiteralBody } from '@origintrail-official/dkg-rdf-utils';
import type { Quad, QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import { usableLastSeenMs } from './agent-peer-discovery.js';

const DKG = 'https://dkg.network/ontology#';
const AGENT_SUBJECT_PREFIX = 'did:dkg:agent:';
const SKOLEM_SEGMENT = '/.well-known/genid/';
const AGENTS_DATA_GRAPH = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
const PEER_ID = DKG_ONTOLOGY.DKG_PEER_ID;
const LAST_SEEN = `${DKG}lastSeen`;
/** The fields of a profile that describe the node it came from. */
const NODE_FIELDS: ReadonlySet<string> = new Set([
  PEER_ID,
  LAST_SEEN,
  `${DKG}multiaddr`,
  DKG_ONTOLOGY.DKG_RELAY_ADDRESS,
  DKG_ONTOLOGY.DKG_PUBLIC_KEY,
  DKG_ONTOLOGY.DKG_NODE_ROLE,
]);
/** What an update of a known agent carries over gossip: its node fields, and its keys and their revocations. */
const UPDATE_FIELDS: ReadonlySet<string> = new Set([
  ...NODE_FIELDS,
  DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY,
  DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_ALGORITHM,
  DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_PROOF,
  DKG_ONTOLOGY.DKG_REVOKED_AT,
  DKG_ONTOLOGY.DKG_REVOKED_BY,
  DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_REVOCATION_PROOF,
]);
/** Subjects one read of stored node fields asks for. */
const STORED_FIELDS_SUBJECTS_PER_READ = 128;
/** How far a profile's date must have moved to be written on its own: a quarter of the staleness bound. */
export const AGENT_LAST_SEEN_WRITE_INTERVAL_MS = 6 * 60 * 60_000;

export interface AgentProfileWrites {
  readonly insert: readonly Quad[];
  readonly remove: readonly Quad[];
}

function literalBody(term: string): string {
  return rdfLiteralBody(term, { plainQuoted: true }) ?? term;
}

function newestUsableLastSeen(quads: readonly Quad[], nowMs: number): { readonly object: string; readonly ms: number } | undefined {
  let newest: { readonly object: string; readonly ms: number } | undefined;
  for (const quad of quads) {
    if (quad.predicate !== LAST_SEEN) continue;
    const ms = usableLastSeenMs(literalBody(quad.object), nowMs);
    if (ms !== undefined && (newest === undefined || ms > newest.ms)) newest = { object: quad.object, ms };
  }
  return newest;
}

function absentFrom(quads: readonly Quad[], others: readonly Quad[]): Quad[] {
  const present = new Set(others.map((quad) => `${quad.predicate}\0${quad.object}`));
  return quads.filter((quad) => !present.has(`${quad.predicate}\0${quad.object}`));
}

/**
 * The writes that bring an update of one subject's node fields into what the
 * subject holds. `update` and `held` are that subject's node fields.
 */
export function planAgentProfileWrites(
  update: readonly Quad[],
  held: readonly Quad[],
  nowMs: number,
): AgentProfileWrites {
  const newest = newestUsableLastSeen(update, nowMs);
  const newestHeld = newestUsableLastSeen(held, nowMs);
  const peers = update.filter((quad) => quad.predicate === PEER_ID);
  const heldPeers = held.filter((quad) => quad.predicate === PEER_ID);
  const usable = update.filter((quad) => quad.predicate !== LAST_SEEN || quad.object === newest?.object);
  const wholeProfile = newest !== undefined && peers.length > 0;
  const replaces = wholeProfile && (
    newestHeld === undefined
    || heldPeers.length === 0
    || newest.ms > newestHeld.ms
    || (newest.ms === newestHeld.ms && peers.length < heldPeers.length)
  );
  if (replaces) {
    const insert = absentFrom(usable, held);
    const remove = absentFrom(held, usable);
    const dateMoved = newestHeld === undefined ? Number.POSITIVE_INFINITY : newest.ms - newestHeld.ms;
    if (dateMoved >= AGENT_LAST_SEEN_WRITE_INTERVAL_MS
      || [...insert, ...remove].some((quad) => quad.predicate !== LAST_SEEN)) return { insert, remove };
  }
  const heldFields = new Set(held.map((quad) => quad.predicate));
  return {
    insert: wholeProfile ? [] : usable.filter((quad) => !heldFields.has(quad.predicate)),
    remove: held.filter((quad) => quad.predicate === LAST_SEEN && quad.object !== newestHeld?.object),
  };
}

async function readHeldNodeFields(
  store: TripleStore,
  subjects: readonly string[],
  options: QueryOptions,
): Promise<Map<string, Quad[]>> {
  const held = new Map<string, Quad[]>();
  const fields = [...NODE_FIELDS].map(sparqlIri).join(', ');
  for (let start = 0; start < subjects.length; start += STORED_FIELDS_SUBJECTS_PER_READ) {
    const values = subjects.slice(start, start + STORED_FIELDS_SUBJECTS_PER_READ).map(sparqlIri).join(' ');
    // Bound by subject and filtered by predicate: a second VALUES for the predicate reads far more slowly.
    const result = await store.query(`
      SELECT ?s ?p ?o WHERE {
        VALUES ?s { ${values} }
        GRAPH ${sparqlIri(AGENTS_DATA_GRAPH)} { ?s ?p ?o }
        FILTER(?p IN (${fields}))
      }
    `, { ...options, source: 'agent.agentProfile.readNodeFields' });
    if (result.type !== 'bindings') throw new Error('Agent profile read returned no bindings');
    for (const row of result.bindings) {
      const subject = row['s'];
      const predicate = row['p'];
      const object = row['o'];
      if (subject === undefined || predicate === undefined || object === undefined) continue;
      const quads = held.get(subject);
      const quad = { subject, predicate, object, graph: AGENTS_DATA_GRAPH };
      if (quads === undefined) held.set(subject, [quad]);
      else quads.push(quad);
    }
  }
  return held;
}

const writeTails = new WeakMap<object, Promise<unknown>>();

/** One read-compare-write of the store's profiles at a time, so that two updates never pass each other. */
function oneAtATime<T>(store: object, work: () => Promise<T>): Promise<T> {
  const previous = writeTails.get(store) ?? Promise.resolve();
  const run = previous.then(work, work);
  writeTails.set(store, run.catch(() => undefined));
  return run;
}

/**
 * Store `quads` through `insert`, with the node fields of agent profiles among
 * them applied as this module describes. Quads of any other kind go to `insert`
 * unchanged. Resolves with what `insert` stored.
 */
export async function storeAgentProfileQuads(
  store: TripleStore,
  quads: readonly Quad[],
  insert: (quads: Quad[]) => Promise<Quad[]>,
  options: QueryOptions & { readonly nowMs?: number } = {},
): Promise<Quad[]> {
  if (quads.length === 0) return [];
  const { nowMs, ...storeOptions } = options;
  const updates = new Map<string, Quad[]>();
  const others: Quad[] = [];
  for (const quad of quads) {
    if (quad.graph !== AGENTS_DATA_GRAPH || !NODE_FIELDS.has(quad.predicate)
      || !quad.subject.startsWith(AGENT_SUBJECT_PREFIX) || !isSafeIri(quad.subject)) {
      others.push(quad);
      continue;
    }
    const update = updates.get(quad.subject);
    if (update === undefined) updates.set(quad.subject, [quad]);
    else update.push(quad);
  }
  if (updates.size === 0) return insert([...quads]);
  return oneAtATime(store, async () => {
    const held = await readHeldNodeFields(store, [...updates.keys()], storeOptions);
    const at = nowMs ?? Date.now();
    const removes: Quad[] = [];
    for (const [subject, update] of updates) {
      const writes = planAgentProfileWrites(update, held.get(subject) ?? [], at);
      others.push(...writes.insert);
      removes.push(...writes.remove);
    }
    const stored = others.length > 0 ? await insert(others) : [];
    if (removes.length > 0) await store.delete(removes, storeOptions);
    return stored;
  });
}

/**
 * The part of a gossiped profile message this node stores. A node publishes its
 * own profile, so a profile naming another peer than the message's sender is
 * left out. Of an agent this node knows already, only the update's node fields,
 * keys and revocations count: the rest arrives with a sync, and taking it from
 * every heartbeat would grow the subject's triples without bound.
 */
export function gossipedAgentProfileQuads(
  quads: readonly Quad[],
  input: { readonly fromPeerId?: string; readonly knownAgent: boolean },
): Quad[] {
  const { fromPeerId, knownAgent } = input;
  const namesAnother = new Set<string>();
  if (fromPeerId !== undefined) {
    for (const quad of quads) {
      if (quad.predicate === PEER_ID && literalBody(quad.object) !== fromPeerId) namesAnother.add(quad.subject);
    }
  }
  return quads.filter((quad) => (
    !namesAnother.has(quad.subject.split(SKOLEM_SEGMENT, 1)[0]!)
    && (!knownAgent || (UPDATE_FIELDS.has(quad.predicate) && quad.subject.startsWith(AGENT_SUBJECT_PREFIX)))
  ));
}
