// SPDX-License-Identifier: Apache-2.0

/**
 * An update of an agent's profile replaces the fields that describe its node,
 * newest `dkg:lastSeen` first, instead of adding to them
 * (`src/agent-profile-updates.ts`). The gossip and sync wiring is in
 * `gossip-publish-handler.test.ts` and `e2e-agent-profile-update.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { AGENT_LAST_SEEN_CLOCK_SKEW_MS, usableLastSeenMs } from '../src/agent-peer-discovery.js';
import {
  AGENT_LAST_SEEN_WRITE_INTERVAL_MS,
  gossipedAgentProfileQuads,
  planAgentProfileWrites,
  storeAgentProfileQuads,
} from '../src/agent-profile-updates.js';
import { AGENT_REGISTRY_GRAPH, buildAgentProfile } from '../src/profile.js';

const WALLET = '0x00000000000000000000000000000000000000ab';
const SUBJECT = `did:dkg:agent:${WALLET}`;
const DKG = 'https://dkg.network/ontology#';
const PEER_ID = `${DKG}peerId`;
const LAST_SEEN = `${DKG}lastSeen`;
const RELAY = `${DKG}relayAddress`;
const MULTIADDR = `${DKG}multiaddr`;
const NODE_ROLE = `${DKG}nodeRole`;
const PUBLIC_KEY = `${DKG}publicKey`;
const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const minutesAgo = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

function profile(peerId: string, lastSeen: string, extra: Partial<Parameters<typeof buildAgentProfile>[0]> = {}): Quad[] {
  return buildAgentProfile({
    peerId,
    name: 'Agent',
    skills: [],
    agentAddress: WALLET,
    lastSeen,
    relayAddress: `/dns4/relay-of-${peerId}/tcp/9090`,
    multiaddrs: [`/dns4/relay-of-${peerId}/tcp/9090/p2p-circuit/p2p/${peerId}`],
    publicKey: `key-of-${peerId}`,
    nodeRole: 'edge',
    ...extra,
  }).quads;
}

function quad(predicate: string, object: string, subject = SUBJECT): Quad {
  return { subject, predicate, object, graph: AGENT_REGISTRY_GRAPH };
}

const literal = (value: string): string => `"${value}"`;

describe('applying agent profile updates to the store', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

  function fixture() {
    const store = new OxigraphStore();
    stores.push(store);
    const insert = async (quads: Quad[]) => { await store.insert(quads); return quads; };
    const apply = (quads: Quad[]) => storeAgentProfileQuads(store, quads, insert, { nowMs: NOW });
    const values = async (predicate: string, subject = SUBJECT): Promise<string[]> => {
      const result = await store.query(`SELECT ?o WHERE { GRAPH <${AGENT_REGISTRY_GRAPH}> { <${subject}> <${predicate}> ?o } } ORDER BY ?o`);
      return result.type === 'bindings' ? result.bindings.map((row) => row['o']!) : [];
    };
    return { store, insert, apply, values };
  }

  it('stores a first profile whole', async () => {
    const { apply, values, store } = fixture();
    const first = profile('peer-1', minutesAgo(5));
    await apply(first);
    expect(await values(PEER_ID)).toEqual([literal('peer-1')]);
    expect(await store.countQuads(AGENT_REGISTRY_GRAPH)).toBe(first.length);
  });

  it('replaces the peer and every other node field with those of a newer profile', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-old', minutesAgo(60)));
    await apply(profile('peer-new', minutesAgo(1), { nodeRole: 'core' }));
    expect(await values(PEER_ID)).toEqual([literal('peer-new')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(1))]);
    expect(await values(RELAY)).toEqual([literal('/dns4/relay-of-peer-new/tcp/9090')]);
    expect(await values(MULTIADDR)).toEqual([literal('/dns4/relay-of-peer-new/tcp/9090/p2p-circuit/p2p/peer-new')]);
    expect(await values(PUBLIC_KEY)).toEqual([literal('key-of-peer-new')]);
    expect(await values(NODE_ROLE)).toEqual([literal('core')]);
  });

  it('removes a node field the newer profile no longer has', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-1', minutesAgo(60)));
    await apply(profile('peer-1', minutesAgo(1), { relayAddress: undefined, multiaddrs: [] }));
    expect(await values(RELAY)).toEqual([]);
    expect(await values(MULTIADDR)).toEqual([]);
    expect(await values(PEER_ID)).toEqual([literal('peer-1')]);
  });

  it('does not let an older profile, delivered late, bring back a peer of an earlier run', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-new', minutesAgo(1)));
    await apply(profile('peer-old', minutesAgo(60)));
    expect(await values(PEER_ID)).toEqual([literal('peer-new')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(1))]);
  });

  it('changes nothing when the same profile is delivered again', async () => {
    const { apply, store, values } = fixture();
    const same = profile('peer-1', minutesAgo(1));
    await apply(same);
    const before = await store.countQuads(AGENT_REGISTRY_GRAPH);
    const deleted = vi.spyOn(store, 'delete');
    await apply(same);
    expect(await store.countQuads(AGENT_REGISTRY_GRAPH)).toBe(before);
    expect(deleted).not.toHaveBeenCalled();
    expect(await values(PEER_ID)).toEqual([literal('peer-1')]);
  });

  it('writes a heartbeat that changes only the date once per interval, and any other change at once', async () => {
    const { apply, store, values } = fixture();
    const minutes = AGENT_LAST_SEEN_WRITE_INTERVAL_MS / 60_000;
    // As gossip hands it over for a known agent: its node fields, keys and revocations.
    const heartbeat = (minutesBack: number, extra = {}) => gossipedAgentProfileQuads(
      profile('peer-1', minutesAgo(minutesBack), extra),
      { knownAgent: true },
    );
    await apply(heartbeat(2 * minutes));
    const inserted = vi.spyOn(store, 'insert');
    const deleted = vi.spyOn(store, 'delete');

    await apply(heartbeat(2 * minutes - 20));
    await apply(heartbeat(minutes + 1));
    expect(await values(LAST_SEEN), 'the date is still within the interval').toEqual([literal(minutesAgo(2 * minutes))]);
    expect(inserted, 'a profile with nothing new costs the store no write').toHaveBeenCalledTimes(0);
    expect(deleted).toHaveBeenCalledTimes(0);

    await apply(heartbeat(minutes));
    expect(await values(LAST_SEEN), 'a whole interval has passed').toEqual([literal(minutesAgo(minutes))]);

    await apply(heartbeat(minutes - 20, { relayAddress: '/dns4/another-relay/tcp/9090' }));
    expect(await values(RELAY), 'a real change does not wait').toEqual([literal('/dns4/another-relay/tcp/9090')]);
    expect(await values(LAST_SEEN), 'and brings its date').toEqual([literal(minutesAgo(minutes - 20))]);
  });

  it('keeps every peer of a union that is the newest, with its newest lastSeen only', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-held', minutesAgo(30)));
    await apply([
      quad(PEER_ID, literal('peer-a')),
      quad(PEER_ID, literal('peer-b')),
      quad(LAST_SEEN, literal(minutesAgo(20))),
      quad(LAST_SEEN, literal(minutesAgo(10))),
    ]);
    expect(await values(PEER_ID)).toEqual([literal('peer-a'), literal('peer-b')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(10))]);
  });

  it('adds no peer from a union older than what it holds', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-new', minutesAgo(5)));
    await apply([
      quad(PEER_ID, literal('peer-a')),
      quad(PEER_ID, literal('peer-b')),
      quad(LAST_SEEN, literal(minutesAgo(20))),
      quad(LAST_SEEN, literal(minutesAgo(10))),
    ]);
    expect(await values(PEER_ID)).toEqual([literal('peer-new')]);
  });

  it('settles a stored union when a profile with the same lastSeen names one of its peers', async () => {
    const { store, apply, values } = fixture();
    await store.insert([
      quad(PEER_ID, literal('peer-a')),
      quad(PEER_ID, literal('peer-b')),
      quad(LAST_SEEN, literal(minutesAgo(20))),
      quad(LAST_SEEN, literal(minutesAgo(10))),
    ]);
    await apply([quad(PEER_ID, literal('peer-b')), quad(LAST_SEEN, literal(minutesAgo(10)))]);
    expect(await values(PEER_ID)).toEqual([literal('peer-b')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(10))]);
  });

  it('thins out the lastSeen values of a stored union that a redelivery does not replace', async () => {
    const { store, apply, values } = fixture();
    const union = [
      quad(PEER_ID, literal('peer-a')),
      quad(PEER_ID, literal('peer-b')),
      quad(LAST_SEEN, literal(minutesAgo(20))),
      quad(LAST_SEEN, literal(minutesAgo(10))),
    ];
    await store.insert(union);
    await apply(union);
    expect(await values(PEER_ID)).toEqual([literal('peer-a'), literal('peer-b')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(10))]);
  });

  it('puts a profile together that a fetch delivered in two parts, on a subject it did not know', async () => {
    const { apply, values } = fixture();
    await apply([quad(LAST_SEEN, literal(minutesAgo(1))), quad(MULTIADDR, literal('/dns4/a/tcp/1'))]);
    await apply([quad(PEER_ID, literal('peer-1')), quad(RELAY, literal('/dns4/a/tcp/1'))]);
    expect(await values(PEER_ID)).toEqual([literal('peer-1')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(1))]);
    expect(await values(RELAY)).toEqual([literal('/dns4/a/tcp/1')]);
  });

  it('leaves a stored profile alone when a fetch delivers part of another, and fills only what it lacks', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-1', minutesAgo(30), { relayAddress: undefined }));
    await apply([quad(LAST_SEEN, literal(minutesAgo(1)))]);
    await apply([quad(PEER_ID, literal('peer-2')), quad(RELAY, literal('/dns4/b/tcp/2'))]);
    expect(await values(PEER_ID)).toEqual([literal('peer-1')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(30))]);
    expect(await values(RELAY)).toEqual([literal('/dns4/b/tcp/2')]);
  });

  it('gives a subject a peer from a whole profile when it held only a lastSeen', async () => {
    const { store, apply, values } = fixture();
    await store.insert([quad(LAST_SEEN, literal(minutesAgo(1)))]);
    await apply([quad(PEER_ID, literal('peer-1')), quad(LAST_SEEN, literal(minutesAgo(1)))]);
    expect(await values(PEER_ID)).toEqual([literal('peer-1')]);
  });

  it('does not let a lastSeen beyond the clock allowance displace a current profile, or keep it', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-new', minutesAgo(1)));
    const farAhead = new Date(NOW + AGENT_LAST_SEEN_CLOCK_SKEW_MS + 1).toISOString();
    await apply([quad(PEER_ID, literal('peer-forged')), quad(LAST_SEEN, literal(farAhead))]);
    expect(await values(PEER_ID)).toEqual([literal('peer-new')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(1))]);
  });

  it('replaces a stored lastSeen beyond the clock allowance with any dated profile', async () => {
    const { store, apply, values } = fixture();
    const farAhead = new Date(NOW + AGENT_LAST_SEEN_CLOCK_SKEW_MS + 1).toISOString();
    await store.insert([quad(PEER_ID, literal('peer-pinned')), quad(LAST_SEEN, literal(farAhead))]);
    await apply([quad(PEER_ID, literal('peer-new')), quad(LAST_SEEN, literal(minutesAgo(1)))]);
    expect(await values(PEER_ID)).toEqual([literal('peer-new')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(1))]);
  });

  it('stores no unusable lastSeen on a first profile: the peer stays without a date', async () => {
    const { apply, values } = fixture();
    await apply([quad(PEER_ID, literal('peer-1')), quad(LAST_SEEN, literal('not a date'))]);
    expect(await values(PEER_ID)).toEqual([literal('peer-1')]);
    expect(await values(LAST_SEEN)).toEqual([]);
  });

  it('keeps every encryption key and proof of the wallet, and takes a revocation', async () => {
    const { apply, values } = fixture();
    const keyOf = (name: string) => [
      quad(DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY, literal(`encryption-${name}`)),
      quad(DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_ALGORITHM, literal('X25519')),
      quad(DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_PROOF, literal(`proof-${name}`)),
    ];
    const keyUri = `${SUBJECT}#x25519-old`;
    await apply([...profile('peer-old', minutesAgo(60)), ...keyOf('old')]);
    await apply([
      ...profile('peer-new', minutesAgo(1)),
      ...keyOf('new'),
      quad(DKG_ONTOLOGY.DKG_REVOKED_AT, literal(minutesAgo(1)), keyUri),
    ]);
    expect(await values(DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY)).toEqual([literal('encryption-new'), literal('encryption-old')]);
    expect(await values(DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_PROOF)).toEqual([literal('proof-new'), literal('proof-old')]);
    expect(await values(DKG_ONTOLOGY.DKG_REVOKED_AT, keyUri)).toEqual([literal(minutesAgo(1))]);
    expect(await values(PEER_ID)).toEqual([literal('peer-new')]);
  });

  it('adds a key of an older profile too: only a wallet-signed revocation retires one', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-new', minutesAgo(1)));
    await apply([
      ...profile('peer-old', minutesAgo(60)),
      quad(DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY, literal('encryption-old')),
    ]);
    expect(await values(DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY)).toEqual([literal('encryption-old')]);
    expect(await values(PEER_ID)).toEqual([literal('peer-new')]);
  });

  it('passes quads of other graphs and subjects to the insert unchanged, without reading the store', async () => {
    const { store } = fixture();
    const query = vi.spyOn(store, 'query');
    const insert = vi.fn(async (quads: Quad[]) => quads);
    const others: Quad[] = [
      { subject: SUBJECT, predicate: PEER_ID, object: literal('peer-1'), graph: 'did:dkg:context-graph:other' },
      quad(PEER_ID, literal('peer-1'), 'did:dkg:context-graph:not-an-agent'),
      quad(`${DKG}agentAddress`, literal(WALLET)),
    ];
    await expect(storeAgentProfileQuads(store, others, insert)).resolves.toEqual(others);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });

  it('does nothing for an empty batch', async () => {
    const { store } = fixture();
    const insert = vi.fn(async (quads: Quad[]) => quads);
    await expect(storeAgentProfileQuads(store, [], insert)).resolves.toEqual([]);
    expect(insert).not.toHaveBeenCalled();
  });

  it('leaves an unsafe subject to the store, as any other quad', async () => {
    const { store } = fixture();
    const query = vi.spyOn(store, 'query');
    const unsafe = quad(PEER_ID, literal('peer-1'), 'did:dkg:agent:0xab> <injected');
    const insert = vi.fn(async (quads: Quad[]) => quads);
    await storeAgentProfileQuads(store, [unsafe], insert);
    expect(insert).toHaveBeenCalledWith([unsafe]);
    expect(query).not.toHaveBeenCalled();
  });

  it('writes the new values before the old ones go, and removes nothing when the write fails', async () => {
    const { store, apply, values } = fixture();
    await apply(profile('peer-old', minutesAgo(60)));
    const order: string[] = [];
    const deleted = vi.spyOn(store, 'delete');
    await storeAgentProfileQuads(store, profile('peer-new', minutesAgo(1)), async (quads) => {
      order.push(`insert:${deleted.mock.calls.length}`);
      await store.insert(quads);
      return quads;
    }, { nowMs: NOW });
    expect(order).toEqual(['insert:0']);
    expect(deleted).toHaveBeenCalledTimes(1);

    deleted.mockClear();
    await expect(storeAgentProfileQuads(store, profile('peer-newest', minutesAgo(0)), async () => {
      throw new Error('store is busy');
    }, { nowMs: NOW })).rejects.toThrow('store is busy');
    expect(deleted).not.toHaveBeenCalled();
    expect(await values(PEER_ID)).toEqual([literal('peer-new')]);
  });

  it('keeps working after an update failed, and two updates that race end on the newest', async () => {
    const { store, insert, apply, values } = fixture();
    await expect(storeAgentProfileQuads(store, profile('peer-0', minutesAgo(90)), async () => {
      throw new Error('store is busy');
    }, { nowMs: NOW })).rejects.toThrow('store is busy');
    const updates = Array.from({ length: 12 }, (_, index) => profile(`peer-${index}`, minutesAgo(30 - index)));
    await Promise.all(updates.map((update, index) => (
      index % 2 === 0 ? apply(update) : storeAgentProfileQuads(store, update, insert, { nowMs: NOW })
    )));
    expect(await values(PEER_ID)).toEqual([literal('peer-11')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(19))]);
  });

  it('reads stored fields in bounded rounds, whatever the size of the batch', async () => {
    const { store, apply, values } = fixture();
    const subjectOf = (index: number) => `did:dkg:agent:0x${String(index).padStart(40, '0')}`;
    const update = (index: number, peer: string, lastSeen: string): Quad[] => [
      quad(PEER_ID, literal(peer), subjectOf(index)),
      quad(LAST_SEEN, literal(lastSeen), subjectOf(index)),
    ];
    await apply(Array.from({ length: 300 }, (_, index) => update(index, `old-${index}`, minutesAgo(10))).flat());
    const query = vi.spyOn(store, 'query');
    await apply(Array.from({ length: 300 }, (_, index) => update(index, `new-${index}`, minutesAgo(1))).flat());
    expect(query.mock.calls.length).toBe(3);
    query.mockRestore();
    for (const index of [0, 127, 128, 299]) {
      expect(await values(PEER_ID, subjectOf(index))).toEqual([literal(`new-${index}`)]);
    }
  });

  it('refuses a store that does not answer a read with rows', async () => {
    const { store, insert } = fixture();
    vi.spyOn(store, 'query').mockResolvedValue({ type: 'boolean', value: true });
    await expect(storeAgentProfileQuads(store, profile('peer-1', minutesAgo(1)), insert, { nowMs: NOW }))
      .rejects.toThrow('returned no bindings');
  });

  it('skips a row with an unbound term', async () => {
    const { store, insert } = fixture();
    vi.spyOn(store, 'query').mockResolvedValue({ type: 'bindings', bindings: [{ s: SUBJECT, p: LAST_SEEN }] });
    await expect(storeAgentProfileQuads(store, profile('peer-1', minutesAgo(1)), insert, { nowMs: NOW }))
      .resolves.toHaveLength(profile('peer-1', minutesAgo(1)).length);
  });

  it('dates updates with the clock when no time is given', async () => {
    const { store, insert, values } = fixture();
    const current = new Date().toISOString();
    await storeAgentProfileQuads(store, profile('peer-1', current), insert);
    expect(await values(LAST_SEEN)).toEqual([literal(current)]);
  });
});

describe('the writes of one profile update', () => {
  it('count a lastSeen in a typed literal as well', () => {
    const typed = `"${minutesAgo(1)}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`;
    const held = [quad(PEER_ID, literal('peer-old')), quad(LAST_SEEN, literal(minutesAgo(60)))];
    const writes = planAgentProfileWrites([quad(PEER_ID, literal('peer-new')), quad(LAST_SEEN, typed)], held, NOW);
    expect(writes.insert.map((write) => write.object)).toEqual([literal('peer-new'), typed]);
    expect(writes.remove).toEqual(held);
  });

  it('accept a lastSeen ahead of the clock within the allowance, and refuse one beyond it', () => {
    expect(usableLastSeenMs(new Date(NOW + AGENT_LAST_SEEN_CLOCK_SKEW_MS).toISOString(), NOW)).toBe(NOW + AGENT_LAST_SEEN_CLOCK_SKEW_MS);
    expect(usableLastSeenMs(new Date(NOW + AGENT_LAST_SEEN_CLOCK_SKEW_MS + 1).toISOString(), NOW)).toBeUndefined();
    expect(usableLastSeenMs('', NOW)).toBeUndefined();
  });
});

describe('the part of a gossiped profile a node stores', () => {
  const FROM = 'peer-sender';
  const update = [
    quad(PEER_ID, literal(FROM)),
    quad(LAST_SEEN, literal(minutesAgo(1))),
    quad(DKG_ONTOLOGY.SCHEMA_NAME, literal('Agent')),
    quad(DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY, literal('encryption')),
    quad('http://www.w3.org/ns/prov#atTime', literal(minutesAgo(1)), `${SUBJECT}/.well-known/genid/registration`),
  ];

  it('is all of it when the agent is new, and its sender is the peer it names', () => {
    expect(gossipedAgentProfileQuads(update, { fromPeerId: FROM, knownAgent: false })).toEqual(update);
  });

  it('is nothing of a profile that names another peer than its sender, skolem children included', () => {
    expect(gossipedAgentProfileQuads(update, { fromPeerId: 'peer-other', knownAgent: false })).toEqual([]);
  });

  it('keeps other subjects of the same message', () => {
    const other = quad(PEER_ID, literal(FROM), 'did:dkg:agent:0x00000000000000000000000000000000000000cd');
    expect(gossipedAgentProfileQuads([...update, other], { fromPeerId: 'peer-other', knownAgent: false })).toEqual([]);
    expect(gossipedAgentProfileQuads([...update, other], { fromPeerId: FROM, knownAgent: false })).toHaveLength(update.length + 1);
  });

  it('is the node fields, keys and revocations of an update of a known agent', () => {
    const revocation = quad(DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_REVOCATION_PROOF, literal('proof'), `${SUBJECT}#x25519-old`);
    expect(gossipedAgentProfileQuads([...update, revocation], { fromPeerId: FROM, knownAgent: true })).toEqual([
      update[0], update[1], update[3], revocation,
    ]);
  });

  it('is nothing of a subject that is no agent, in a message about a known one', () => {
    const other = quad(DKG_ONTOLOGY.DKG_REVOKED_AT, literal(minutesAgo(1)), 'did:dkg:context-graph:other');
    expect(gossipedAgentProfileQuads([other], { knownAgent: true })).toEqual([]);
    expect(gossipedAgentProfileQuads([other], { knownAgent: false }), 'a new subject is stored whole, as before').toEqual([other]);
  });

  it('takes the sender on trust when none is given', () => {
    expect(gossipedAgentProfileQuads(update, { knownAgent: false })).toEqual(update);
  });
});
