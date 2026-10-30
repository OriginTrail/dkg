// SPDX-License-Identifier: Apache-2.0

/**
 * How an update of an agent's profile enters this node's `agents` graph.
 *
 * Every run of an agent wallet writes its profile to the same subject, and
 * nothing in a profile's triples ties one `dkg:peerId` to one `dkg:lastSeen`.
 * Added to what the subject holds, an update leaves a union no reader can take
 * apart: the wallet maps to every peer it ever ran on, and nothing says which
 * of them is current. So the subject also holds one date per peer, in
 * `dkg:peerLastSeen` ("<peer id> <lastSeen>"), and readers take the newest:
 *
 * - A profile of one peer sets that peer's date, and is ignored when it is no
 *   newer than the date held. `dkg:lastSeen` is the newest date the subject keeps.
 * - A peer leaves the subject by age only, once its date passes the staleness
 *   bound while another peer of the subject is current. An update never removes
 *   another peer, or what another peer may have written.
 * - The relay address, the public key and the role name no peer. An update sets
 *   them when its peer is the only one the subject keeps. Beside another current
 *   peer it only adds its values, and those of the others go once one peer is left.
 * - A profile that lists several peers, from a node that still keeps the union,
 *   has no date for any of them. It only seeds a subject without a current peer.
 *   The peers of a stored union are dated by its newest `dkg:lastSeen` the first
 *   time the subject changes, and age out from there.
 * - Part of a profile, as when a fetch stops inside one, is kept until the next
 *   batch brings the rest. Until then it only fills fields the subject lacks.
 * - A `dkg:lastSeen` ahead of this node's clock by more than the allowance says
 *   nothing about the profile's age, and is not stored.
 * - A heartbeat that changes nothing but its peer's date is written once per
 *   {@link AGENT_LAST_SEEN_WRITE_INTERVAL_MS}, or as soon as it overtakes a peer
 *   that has stopped sending them. Every agent sends one each 20 minutes, and
 *   each store write ends what this node's caches hold.
 *
 * Encryption keys are not node fields, and stay on the subject. A sender must
 * encrypt to every key the wallet has proved (`resolveWorkspaceAgentRecipientKeys`),
 * since another of the wallet's nodes may hold the private half, and only a
 * wallet-signed revocation retires one.
 *
 * New values are written before old ones go, so a reader always finds a peer.
 */

import {
  DKG_ONTOLOGY,
  DKG_RDF_LITERAL_SAFE_MUTF8_BYTES,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  isSafeIri,
  rdfLiteralTermMutf8ByteLength,
  sparqlIri,
} from '@origintrail-official/dkg-core';
import { rdfLiteralBody } from '@origintrail-official/dkg-rdf-utils';
import type { Quad, QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import { usableLastSeenMs } from './agent-peer-discovery.js';
import { rememberBounded } from './bounded-map.js';
import { AGENT_PROFILE_STALE_THRESHOLD_MS } from './dkg-agent-constants.js';

const DKG = 'https://dkg.network/ontology#';
const AGENT_SUBJECT_PREFIX = 'did:dkg:agent:';
const SKOLEM_SEGMENT = '/.well-known/genid/';
const AGENTS_DATA_GRAPH = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
const PEER_ID = DKG_ONTOLOGY.DKG_PEER_ID;
const LAST_SEEN = `${DKG}lastSeen`;
const MULTIADDR = `${DKG}multiaddr`;
/** One date per peer: "<peer id> <lastSeen>". */
export const AGENT_PEER_LAST_SEEN_PREDICATE = `${DKG}peerLastSeen`;
/** They name no peer, so an update sets them only when its peer is the subject's one peer. */
const UNATTRIBUTED_FIELDS: ReadonlySet<string> = new Set([
  DKG_ONTOLOGY.DKG_RELAY_ADDRESS,
  DKG_ONTOLOGY.DKG_PUBLIC_KEY,
  DKG_ONTOLOGY.DKG_NODE_ROLE,
]);
/** The fields of a profile that describe the nodes it came from. */
const NODE_FIELDS: ReadonlySet<string> = new Set([
  ...UNATTRIBUTED_FIELDS,
  PEER_ID,
  LAST_SEEN,
  AGENT_PEER_LAST_SEEN_PREDICATE,
  MULTIADDR,
]);
/** What an update of a known agent carries over gossip: what its node writes about itself, and its keys and their revocations. */
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
/** How far a heartbeat's date must have moved to be written on its own: a quarter of the staleness bound. */
export const AGENT_LAST_SEEN_WRITE_INTERVAL_MS = 6 * 60 * 60_000;
/** How far a peer's date must be behind a heartbeat for that peer to have stopped sending them: two heartbeats. */
export const AGENT_PEER_SILENT_AFTER_MS = 40 * 60_000;
/** How long part of a profile waits for the rest, how many wait, and how large one may be. */
const PROFILE_PART_TTL_MS = 10 * 60_000;
const PROFILE_PARTS_MAX = 64;
const PROFILE_PART_MAX_QUADS = 256;

export interface AgentProfileWrites {
  readonly insert: readonly Quad[];
  readonly remove: readonly Quad[];
}

interface Seen { readonly iso: string; readonly ms: number }

function literalBody(term: string): string {
  return rdfLiteralBody(term, { plainQuoted: true }) ?? term;
}

function newestLastSeen(quads: readonly Quad[], nowMs: number): Seen | undefined {
  let newest: Seen | undefined;
  for (const quad of quads) {
    if (quad.predicate !== LAST_SEEN) continue;
    const iso = literalBody(quad.object);
    const ms = usableLastSeenMs(iso, nowMs);
    if (ms !== undefined && (newest === undefined || ms > newest.ms)) newest = { iso, ms };
  }
  return newest;
}

/** The peer and date of a `dkg:peerLastSeen` literal; undefined when it holds no usable date. */
export function parseAgentPeerLastSeen(term: string, nowMs: number): { readonly peerId: string; readonly seen: Seen } | undefined {
  const body = literalBody(term);
  const space = body.lastIndexOf(' ');
  if (space <= 0) return undefined;
  const iso = body.slice(space + 1);
  const ms = usableLastSeenMs(iso, nowMs);
  return ms === undefined ? undefined : { peerId: body.slice(0, space), seen: { iso, ms } };
}

function peerDates(quads: readonly Quad[], nowMs: number): Map<string, Seen> {
  const dates = new Map<string, Seen>();
  for (const quad of quads) {
    if (quad.predicate !== AGENT_PEER_LAST_SEEN_PREDICATE) continue;
    const parsed = parseAgentPeerLastSeen(quad.object, nowMs);
    const known = parsed === undefined ? undefined : dates.get(parsed.peerId);
    if (parsed !== undefined && (known === undefined || parsed.seen.ms > known.ms)) dates.set(parsed.peerId, parsed.seen);
  }
  return dates;
}

function peerTerms(quads: readonly Quad[]): Map<string, string> {
  const peers = new Map<string, string>();
  for (const quad of quads) {
    if (quad.predicate === PEER_ID && !peers.has(literalBody(quad.object))) peers.set(literalBody(quad.object), quad.object);
  }
  return peers;
}

/** The peer a multiaddr reaches: its last `/p2p/` component. */
function addressPeer(term: string): string | undefined {
  const body = literalBody(term);
  const at = body.lastIndexOf('/p2p/');
  return at < 0 ? undefined : body.slice(at + '/p2p/'.length).split('/', 1)[0];
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
  staleAfterMs: number = AGENT_PROFILE_STALE_THRESHOLD_MS,
): AgentProfileWrites {
  const first = update[0] ?? held[0];
  if (first === undefined) return { insert: [], remove: [] };
  const fieldQuad = (predicate: string, object: string): Quad => ({ subject: first.subject, predicate, object, graph: first.graph });
  const heldOf = (predicate: string): Quad[] => held.filter((quad) => quad.predicate === predicate);
  const updateOf = (predicate: string): Quad[] => update.filter((quad) => quad.predicate === predicate);
  const heldPeers = peerTerms(held);
  const updatePeers = peerTerms(update);
  const heldNewest = newestLastSeen(held, nowMs);
  const updateNewest = newestLastSeen(update, nowMs);

  // The dates held. A peer the subject holds no date for is dated by its lastSeen.
  const storedDates = peerDates(held, nowMs);
  const heldDates = new Map(storedDates);
  for (const peerId of heldPeers.keys()) {
    if (!heldDates.has(peerId) && heldNewest !== undefined) heldDates.set(peerId, heldNewest);
  }
  const dates = new Map(heldDates);
  // The dates the update brings: its own for a profile of one peer, and those a node that dates its peers holds.
  const profilePeer = updatePeers.size === 1 && updateNewest !== undefined ? [...updatePeers.keys()][0] : undefined;
  const brought = new Map(profilePeer !== undefined && updateNewest !== undefined ? [[profilePeer, updateNewest]] : []);
  for (const [peerId, seen] of peerDates(update, nowMs)) {
    const known = brought.get(peerId);
    if (known === undefined || seen.ms > known.ms) brought.set(peerId, seen);
  }
  const advanced = new Set<string>();
  for (const [peerId, seen] of brought) {
    const known = dates.get(peerId);
    if (known === undefined || seen.ms > known.ms) {
      dates.set(peerId, seen);
      advanced.add(peerId);
    }
  }

  // The peers the subject keeps.
  const isCurrent = (peerId: string): boolean => {
    const seen = dates.get(peerId);
    return seen !== undefined && nowMs - seen.ms <= staleAfterMs;
  };
  const anyCurrent = [...heldPeers.keys(), ...updatePeers.keys()].some(isCurrent);
  const peers = new Map(heldPeers);
  for (const [peerId, term] of updatePeers) {
    if (!anyCurrent || isCurrent(peerId)) peers.set(peerId, term);
  }
  if (anyCurrent) {
    for (const peerId of peers.keys()) {
      if (dates.has(peerId) && !isCurrent(peerId)) peers.delete(peerId);
    }
  }

  const keptDates = [...peers.keys()].flatMap((peerId) => dates.get(peerId) ?? []);
  const newestKept = keptDates.reduce<Seen | undefined>((best, seen) => (best === undefined || seen.ms > best.ms ? seen : best), undefined);
  const seedsSubject = !anyCurrent && updateNewest !== undefined && (heldNewest === undefined || updateNewest.ms > heldNewest.ms);
  // What names no peer: whether the update sets it, or adds to it.
  const onlyPeer = peers.size === 1 ? [...peers.keys()][0] : undefined;
  const updateSets = seedsSubject || (onlyPeer !== undefined && advanced.has(onlyPeer));
  const updateAdds = [...advanced].some((peerId) => peers.has(peerId));

  const desired: Quad[] = [...peers.values()].map((term) => fieldQuad(PEER_ID, term));
  for (const peerId of peers.keys()) {
    // Nothing dates this peer, not even a usable lastSeen, beside a current one: it starts to age with it.
    const seen = dates.get(peerId) ?? (anyCurrent ? newestKept : undefined);
    if (seen !== undefined) desired.push(fieldQuad(AGENT_PEER_LAST_SEEN_PREDICATE, `"${peerId} ${seen.iso}"`));
  }
  const lastSeen = seedsSubject ? updateNewest : newestKept ?? heldNewest;
  if (lastSeen !== undefined) desired.push(fieldQuad(LAST_SEEN, `"${lastSeen.iso}"`));
  for (const predicate of UNATTRIBUTED_FIELDS) {
    const heldValues = heldOf(predicate);
    if (!updateSets) desired.push(...heldValues);
    if (updateSets || updateAdds || heldValues.length === 0) desired.push(...updateOf(predicate));
  }
  // An address goes with its peer: the update's replace what its peer held. One
  // that names no peer goes with the fields above.
  const replacesAddresses = (peerId: string | undefined): boolean => (
    peerId === undefined ? updateSets : advanced.has(peerId) || (seedsSubject && updatePeers.has(peerId))
  );
  const heldAddresses = heldOf(MULTIADDR);
  const addsAddress = (peerId: string | undefined): boolean => replacesAddresses(peerId) || (peerId === undefined && updateAdds)
    || !heldAddresses.some((quad) => addressPeer(quad.object) === peerId);
  for (const quad of updateOf(MULTIADDR)) {
    const peerId = addressPeer(quad.object);
    if ((peerId === undefined || peers.has(peerId)) && addsAddress(peerId)) desired.push(quad);
  }
  for (const quad of heldAddresses) {
    const peerId = addressPeer(quad.object);
    if ((peerId === undefined || peers.has(peerId)) && !replacesAddresses(peerId)) desired.push(quad);
  }

  const insert = absentFrom(desired, held);
  const remove = absentFrom(held, desired);
  // A heartbeat that moves nothing but its peer's date waits for its turn to be written.
  const isDate = (quad: Quad): boolean => quad.predicate === LAST_SEEN || quad.predicate === AGENT_PEER_LAST_SEEN_PREDICATE;
  const heldProfileDate = profilePeer === undefined ? undefined : heldDates.get(profilePeer);
  const profileDate = profilePeer === undefined ? undefined : dates.get(profilePeer);
  if (profilePeer !== undefined && advanced.has(profilePeer) && heldProfileDate !== undefined && profileDate !== undefined
    && [...insert, ...remove].every(isDate)
    // Peers that only share a lastSeen cannot be told apart until one has a date of its own.
    && (heldPeers.size === 1 || storedDates.has(profilePeer))
    && profileDate.ms - heldProfileDate.ms < AGENT_LAST_SEEN_WRITE_INTERVAL_MS
    && ![...heldDates.values()].some((seen) => seen.ms > heldProfileDate.ms && profileDate.ms - seen.ms >= AGENT_PEER_SILENT_AFTER_MS)) {
    return { insert: [], remove: [] };
  }
  return { insert, remove };
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

interface StoreProfileState {
  tail: Promise<unknown>;
  readonly parts: Map<string, { readonly at: number; readonly quads: readonly Quad[] }>;
}

const stateByStore = new WeakMap<object, StoreProfileState>();

function stateOf(store: object): StoreProfileState {
  let state = stateByStore.get(store);
  if (state === undefined) {
    state = { tail: Promise.resolve(), parts: new Map() };
    stateByStore.set(store, state);
  }
  return state;
}

/** One read-compare-write of the store's profiles at a time, so that two updates never pass each other. */
function oneAtATime<T>(state: StoreProfileState, work: () => Promise<T>): Promise<T> {
  const run = state.tail.then(work, work);
  state.tail = run.catch(() => undefined);
  return run;
}

function isProfilePart(quads: readonly Quad[], nowMs: number): boolean {
  return peerTerms(quads).size === 0 || (newestLastSeen(quads, nowMs) === undefined && peerDates(quads, nowMs).size === 0);
}

/**
 * The update, joined to the part of a profile an earlier batch ended on, unless
 * both name peers: that would make a union of them. A part that stays one waits
 * for the next batch.
 */
function joinProfileParts(state: StoreProfileState, subject: string, update: readonly Quad[], nowMs: number): readonly Quad[] {
  const earlier = state.parts.get(subject);
  state.parts.delete(subject);
  const joined = earlier !== undefined && nowMs - earlier.at < PROFILE_PART_TTL_MS
    && (peerTerms(earlier.quads).size === 0 || peerTerms(update).size === 0)
    ? [...earlier.quads, ...update]
    : update;
  if (isProfilePart(joined, nowMs) && joined.length <= PROFILE_PART_MAX_QUADS) {
    rememberBounded(state.parts, subject, { at: nowMs, quads: joined }, PROFILE_PARTS_MAX);
  }
  return joined;
}

function isUpdateQuad(quad: Quad): boolean {
  return quad.graph === AGENTS_DATA_GRAPH && NODE_FIELDS.has(quad.predicate)
    && quad.subject.startsWith(AGENT_SUBJECT_PREFIX) && isSafeIri(quad.subject)
    // Left to `insert`, whose guard keeps a value too large for the store from counting as an update.
    && (rdfLiteralTermMutf8ByteLength(quad.object) ?? 0) <= DKG_RDF_LITERAL_SAFE_MUTF8_BYTES;
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
    if (!isUpdateQuad(quad)) {
      others.push(quad);
      continue;
    }
    const update = updates.get(quad.subject);
    if (update === undefined) updates.set(quad.subject, [quad]);
    else update.push(quad);
  }
  if (updates.size === 0) return insert(others);
  const state = stateOf(store);
  return oneAtATime(state, async () => {
    const held = await readHeldNodeFields(store, [...updates.keys()], storeOptions);
    const at = nowMs ?? Date.now();
    const removes: Quad[] = [];
    for (const [subject, update] of updates) {
      const writes = planAgentProfileWrites(joinProfileParts(state, subject, update, at), held.get(subject) ?? [], at);
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
 * own profile, whole, so an agent's quads count only when they name the message's
 * sender as their one peer, and the date of a peer is this node's to set. Of an
 * agent this node knows already, only the update's node fields, keys and
 * revocations count: the rest arrives with a sync, and taking it from every
 * heartbeat would grow the subject's triples without bound.
 */
export function gossipedAgentProfileQuads(
  quads: readonly Quad[],
  input: { readonly fromPeerId?: string; readonly knownAgent: boolean },
): Quad[] {
  const { fromPeerId, knownAgent } = input;
  const rootOf = (subject: string): string => subject.split(SKOLEM_SEGMENT, 1)[0]!.split('#', 1)[0]!;
  const namesSender = new Set<string>();
  const namesAnother = new Set<string>();
  for (const quad of quads) {
    if (quad.predicate === PEER_ID) (literalBody(quad.object) === fromPeerId ? namesSender : namesAnother).add(rootOf(quad.subject));
  }
  const fromItsPeer = (root: string): boolean => fromPeerId === undefined
    || (!namesAnother.has(root) && (namesSender.has(root) || !root.startsWith(AGENT_SUBJECT_PREFIX)));
  return quads.filter((quad) => (
    quad.predicate !== AGENT_PEER_LAST_SEEN_PREDICATE
    && fromItsPeer(rootOf(quad.subject))
    && (!knownAgent || (UPDATE_FIELDS.has(quad.predicate) && quad.subject.startsWith(AGENT_SUBJECT_PREFIX)))
  ));
}
