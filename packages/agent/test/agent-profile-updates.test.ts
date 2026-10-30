// SPDX-License-Identifier: Apache-2.0

/**
 * An update of an agent's profile dates its peer, and sets what names no peer
 * only when its peer is the subject's one peer. No update removes another peer:
 * a peer leaves by age (`src/agent-profile-updates.ts`). The gossip and sync wiring is in
 * `gossip-publish-handler.test.ts` and `e2e-agent-profile-update.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DKG_ONTOLOGY, DKG_RDF_LITERAL_SAFE_MUTF8_BYTES } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { AGENT_LAST_SEEN_CLOCK_SKEW_MS, usableLastSeenMs } from '../src/agent-peer-discovery.js';
import {
  AGENT_LAST_SEEN_WRITE_INTERVAL_MS,
  AGENT_DATED_PEER_PREDICATE,
  AGENT_PEER_SILENT_AFTER_MS,
  gossipedAgentProfileQuads,
  parseAgentDatedPeer,
  planAgentProfileWrites,
  storeAgentProfileQuads,
} from '../src/agent-profile-updates.js';
import { AGENT_PROFILE_STALE_THRESHOLD_MS } from '../src/dkg-agent-constants.js';
import { AGENT_REGISTRY_GRAPH, buildAgentProfile } from '../src/profile.js';

const WALLET = '0x00000000000000000000000000000000000000ab';
const SUBJECT = `did:dkg:agent:${WALLET}`;
const DKG = 'https://dkg.network/ontology#';
const PEER_ID = `${DKG}peerId`;
const LAST_SEEN = `${DKG}lastSeen`;
const DATED_PEER = AGENT_DATED_PEER_PREDICATE;
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
    const apply = (quads: Quad[], nowMs = NOW) => storeAgentProfileQuads(store, quads, insert, { nowMs });
    const applyPage = (quads: Quad[], nowMs = NOW) => storeAgentProfileQuads(store, quads, insert, { nowMs, syncPage: true });
    const values = async (predicate: string, subject = SUBJECT): Promise<string[]> => {
      const result = await store.query(`SELECT ?o WHERE { GRAPH <${AGENT_REGISTRY_GRAPH}> { <${subject}> <${predicate}> ?o } } ORDER BY ?o`);
      return result.type === 'bindings' ? result.bindings.map((row) => row['o']!) : [];
    };
    const datesHeld = async (subject = SUBJECT): Promise<string[]> => (await values(DATED_PEER, subject)).map((term) => term.slice(1, -1));
    return { store, insert, apply, applyPage, values, datesHeld };
  }
  const date = (peer: string, minutes: number): string => `${peer} ${minutesAgo(minutes)}`;

  it('stores a first profile whole, with the date of its peer', async () => {
    const { apply, values, datesHeld, store } = fixture();
    const first = profile('peer-1', minutesAgo(5));
    await apply(first);
    expect(await values(PEER_ID)).toEqual([literal('peer-1')]);
    expect(await datesHeld()).toEqual([date('peer-1', 5)]);
    expect(await store.countQuads(AGENT_REGISTRY_GRAPH)).toBe(first.length + 1);
  });

  it('adds the peer of a newer profile with its own date, and never removes the other peer', async () => {
    const { apply, values, datesHeld } = fixture();
    await apply(profile('peer-old', minutesAgo(60)));
    await apply(profile('peer-new', minutesAgo(1), { nodeRole: 'core' }));
    expect(await values(PEER_ID)).toEqual([literal('peer-new'), literal('peer-old')]);
    expect(await datesHeld()).toEqual([date('peer-new', 1), date('peer-old', 60)]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(1))]);
  });

  it('adds to what names no peer beside a current peer, and removes none of it', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-old', minutesAgo(60)));
    await apply(profile('peer-new', minutesAgo(1), { nodeRole: 'core' }));
    expect(await values(RELAY)).toEqual([literal('/dns4/relay-of-peer-new/tcp/9090'), literal('/dns4/relay-of-peer-old/tcp/9090')]);
    expect(await values(PUBLIC_KEY)).toEqual([literal('key-of-peer-new'), literal('key-of-peer-old')]);
    expect(await values(NODE_ROLE)).toEqual([literal('core'), literal('edge')]);
    expect(await values(MULTIADDR)).toEqual([
      literal('/dns4/relay-of-peer-new/tcp/9090/p2p-circuit/p2p/peer-new'),
      literal('/dns4/relay-of-peer-old/tcp/9090/p2p-circuit/p2p/peer-old'),
    ]);
  });

  it('takes what names no peer from a newer profile of the subject\'s only peer, and lets go of what it no longer has', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-1', minutesAgo(60), { multiaddrs: ['/ip4/203.0.113.1/tcp/1/p2p/peer-1', '/ip4/203.0.113.1/tcp/1'] }));
    await apply(profile('peer-1', minutesAgo(1), {
      relayAddress: undefined,
      publicKey: 'key-2',
      nodeRole: 'core',
      multiaddrs: ['/ip4/203.0.113.9/tcp/9/p2p/peer-1', '/ip4/203.0.113.9/tcp/9'],
    }));
    expect(await values(RELAY)).toEqual([]);
    expect(await values(PUBLIC_KEY)).toEqual([literal('key-2')]);
    expect(await values(NODE_ROLE)).toEqual([literal('core')]);
    expect(await values(MULTIADDR)).toEqual([literal('/ip4/203.0.113.9/tcp/9'), literal('/ip4/203.0.113.9/tcp/9/p2p/peer-1')]);
  });

  it('replaces what a peer held with its own newer profile, and keeps an address that names no peer while two are current', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-1', minutesAgo(60), { multiaddrs: ['/ip4/203.0.113.1/tcp/1/p2p/peer-1', '/ip4/203.0.113.1/tcp/1'] }));
    await apply(profile('peer-2', minutesAgo(50), { multiaddrs: ['/ip4/203.0.113.2/tcp/2/p2p/peer-2', '/ip4/203.0.113.2/tcp/2'] }));
    await apply(profile('peer-1', minutesAgo(40), { multiaddrs: ['/ip4/203.0.113.9/tcp/9/p2p/peer-1'] }));
    expect(await values(MULTIADDR)).toEqual([
      literal('/ip4/203.0.113.1/tcp/1'),
      literal('/ip4/203.0.113.2/tcp/2'),
      literal('/ip4/203.0.113.2/tcp/2/p2p/peer-2'),
      literal('/ip4/203.0.113.9/tcp/9/p2p/peer-1'),
    ]);
  });

  it('takes an address for the peer it ends in, not for a relay on the way', async () => {
    const { apply, values } = fixture();
    const throughRelay = (relay: string, peer: string) => `/ip4/203.0.113.1/tcp/1/p2p/${relay}/p2p-circuit/p2p/${peer}`;
    await apply(profile('peer-1', minutesAgo(60), { multiaddrs: [throughRelay('peer-2', 'peer-1')] }));
    await apply(profile('peer-2', minutesAgo(50), { multiaddrs: [throughRelay('peer-1', 'peer-2')] }));
    await apply(profile('peer-2', minutesAgo(40), { multiaddrs: ['/ip4/203.0.113.9/tcp/9/p2p/peer-2'] }));
    expect(await values(MULTIADDR)).toEqual([literal('/ip4/203.0.113.1/tcp/1/p2p/peer-2/p2p-circuit/p2p/peer-1'), literal('/ip4/203.0.113.9/tcp/9/p2p/peer-2')]);
  });

  it('adds an older profile behind the newest, without moving the subject\'s date', async () => {
    const { apply, values, datesHeld } = fixture();
    await apply(profile('peer-new', minutesAgo(1)));
    await apply(profile('peer-old', minutesAgo(60)));
    expect(await datesHeld()).toEqual([date('peer-new', 1), date('peer-old', 60)]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(1))]);
    expect(await values(RELAY)).toEqual([literal('/dns4/relay-of-peer-new/tcp/9090'), literal('/dns4/relay-of-peer-old/tcp/9090')]);
  });

  it('does not bring back a peer past the staleness bound, beside a current one', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-new', minutesAgo(1)));
    const pastTheBound = new Date(NOW - AGENT_PROFILE_STALE_THRESHOLD_MS - 60_000).toISOString();
    await apply(profile('peer-dead', pastTheBound));
    await apply([quad(PEER_ID, literal('peer-dead')), quad(PEER_ID, literal('peer-dead-2')), quad(LAST_SEEN, literal(pastTheBound))]);
    expect(await values(PEER_ID)).toEqual([literal('peer-new')]);
    expect(await values(MULTIADDR)).toEqual([literal('/dns4/relay-of-peer-new/tcp/9090/p2p-circuit/p2p/peer-new')]);
  });

  it('lets a peer leave once it is past the bound, when another peer\'s update arrives', async () => {
    const { apply, values, datesHeld } = fixture();
    await apply(profile('peer-old', minutesAgo(60)));
    await apply(profile('peer-new', minutesAgo(30)));
    const later = NOW + AGENT_PROFILE_STALE_THRESHOLD_MS - 45 * 60_000;
    await apply(profile('peer-new', new Date(later).toISOString(), {}), later);
    expect(await values(PEER_ID)).toEqual([literal('peer-new')]);
    expect(await datesHeld()).toEqual([`peer-new ${new Date(later).toISOString()}`]);
    expect(await values(MULTIADDR)).toEqual([literal('/dns4/relay-of-peer-new/tcp/9090/p2p-circuit/p2p/peer-new')]);
    expect(await values(RELAY), 'what names no peer is the last peer\'s again').toEqual([literal('/dns4/relay-of-peer-new/tcp/9090')]);
    expect(await values(NODE_ROLE)).toEqual([literal('edge')]);
  });

  it('keeps a stale profile when it is all the subject has: readers leave it out by its date', async () => {
    const { apply, values } = fixture();
    const old = new Date(NOW - AGENT_PROFILE_STALE_THRESHOLD_MS - 60_000).toISOString();
    await apply(profile('peer-only', old));
    expect(await values(PEER_ID)).toEqual([literal('peer-only')]);
    await apply(profile('peer-older', new Date(NOW - AGENT_PROFILE_STALE_THRESHOLD_MS - 120_000).toISOString()));
    expect(await values(LAST_SEEN), 'the newer date stays').toEqual([literal(old)]);
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
    const { apply, store, values, datesHeld } = fixture();
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
    expect(await datesHeld()).toEqual([date('peer-1', minutes)]);

    await apply(heartbeat(minutes - 20, { relayAddress: '/dns4/another-relay/tcp/9090' }));
    expect(await values(RELAY), 'a real change does not wait').toEqual([literal('/dns4/another-relay/tcp/9090')]);
    expect(await values(LAST_SEEN), 'and brings its date').toEqual([literal(minutesAgo(minutes - 20))]);
  });

  it('writes a heartbeat at once when it overtakes a peer that stopped sending them, and leaves two that send them alone', async () => {
    const { apply, store, datesHeld } = fixture();
    const heartbeat = (peerId: string, minutes: number) => apply(gossipedAgentProfileQuads(profile(peerId, minutesAgo(minutes)), { knownAgent: true }));
    await apply(profile('peer-live', minutesAgo(200)));
    await apply(profile('peer-other', minutesAgo(190)));
    const inserted = vi.spyOn(store, 'insert');
    await heartbeat('peer-live', 180);
    await heartbeat('peer-other', 170);
    await heartbeat('peer-live', 160);
    expect(inserted, 'both still send them').toHaveBeenCalledTimes(0);
    expect(await datesHeld()).toEqual([date('peer-live', 200), date('peer-other', 190)]);

    const overtaking = 190 - AGENT_PEER_SILENT_AFTER_MS / 60_000;
    await heartbeat('peer-live', overtaking);
    expect(await datesHeld()).toEqual([date('peer-live', overtaking), date('peer-other', 190)]);
  });

  it('does not let a delayed older profile get ahead of a heartbeat it did not write', async () => {
    const { apply, datesHeld, values } = fixture();
    await apply(profile('peer-live', minutesAgo(120)));
    await apply(profile('peer-live', minutesAgo(10)));
    expect(await datesHeld(), 'the heartbeat was not written').toEqual([date('peer-live', 120)]);
    await apply(profile('peer-delayed', minutesAgo(60)));
    expect(await values(PEER_ID), 'it is listed, and removes nothing').toEqual([literal('peer-delayed'), literal('peer-live')]);
    await apply(profile('peer-live', minutesAgo(5)));
    expect(await datesHeld(), 'the next heartbeat puts the live peer first').toEqual([date('peer-delayed', 60), date('peer-live', 5)]);
  });

  it('adds the peers of a union that the subject lacks, dated by its newest lastSeen, and moves no date it holds', async () => {
    const { apply, values, datesHeld } = fixture();
    await apply(profile('peer-new', minutesAgo(5)));
    await apply([
      quad(PEER_ID, literal('peer-new')),
      quad(PEER_ID, literal('peer-moved')),
      quad(LAST_SEEN, literal(minutesAgo(20))),
      quad(LAST_SEEN, literal(minutesAgo(1))),
      quad(MULTIADDR, literal('/dns4/relay/tcp/1/p2p-circuit/p2p/peer-moved')),
    ]);
    expect(await datesHeld()).toEqual([date('peer-moved', 1), date('peer-new', 5)]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(1))]);
    expect(await values(MULTIADDR)).toEqual([
      literal('/dns4/relay-of-peer-new/tcp/9090/p2p-circuit/p2p/peer-new'),
      literal('/dns4/relay/tcp/1/p2p-circuit/p2p/peer-moved'),
    ]);
  });

  it('dates the peers of a first union by its newest lastSeen', async () => {
    const { apply, values, datesHeld } = fixture();
    await apply([
      quad(PEER_ID, literal('peer-a')),
      quad(PEER_ID, literal('peer-b')),
      quad(LAST_SEEN, literal(minutesAgo(20))),
      quad(LAST_SEEN, literal(minutesAgo(10))),
      quad(MULTIADDR, literal('/dns4/relay/tcp/1/p2p-circuit/p2p/peer-a')),
      quad(RELAY, literal('/dns4/relay/tcp/1')),
    ]);
    expect(await values(PEER_ID)).toEqual([literal('peer-a'), literal('peer-b')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(10))]);
    expect(await values(RELAY)).toEqual([literal('/dns4/relay/tcp/1')]);
    expect(await values(MULTIADDR)).toEqual([literal('/dns4/relay/tcp/1/p2p-circuit/p2p/peer-a')]);
    expect(await datesHeld()).toEqual([date('peer-a', 10), date('peer-b', 10)]);
  });

  it('seeds a subject whose peers are all past the bound from a newer union, which sets what it names', async () => {
    const { apply, values } = fixture();
    const pastTheBound = (hours: number) => new Date(NOW - AGENT_PROFILE_STALE_THRESHOLD_MS - hours * 3_600_000).toISOString();
    await apply(profile('peer-a', pastTheBound(4), { multiaddrs: ['/ip4/203.0.113.1/tcp/1/p2p/peer-a'] }));
    await apply([
      quad(PEER_ID, literal('peer-a')),
      quad(PEER_ID, literal('peer-b')),
      quad(LAST_SEEN, literal(pastTheBound(2))),
      quad(MULTIADDR, literal('/ip4/203.0.113.9/tcp/9/p2p/peer-a')),
      quad(RELAY, literal('/dns4/relay-of-the-union/tcp/1')),
    ]);
    expect(await values(PEER_ID)).toEqual([literal('peer-a'), literal('peer-b')]);
    expect(await values(LAST_SEEN)).toEqual([literal(pastTheBound(2))]);
    expect(await values(RELAY)).toEqual([literal('/dns4/relay-of-the-union/tcp/1')]);
    expect(await values(MULTIADDR)).toEqual([literal('/ip4/203.0.113.9/tcp/9/p2p/peer-a')]);
  });

  it('adds nothing that names no peer from an older profile of a peer it holds, or from a part', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-1', minutesAgo(30)));
    await apply(profile('peer-1', minutesAgo(60), { relayAddress: '/dns4/older/tcp/1', nodeRole: 'core' }));
    expect(await values(RELAY)).toEqual([literal('/dns4/relay-of-peer-1/tcp/9090')]);
    expect(await values(NODE_ROLE)).toEqual([literal('edge')]);
    await apply([quad(RELAY, literal('/dns4/part/tcp/1'))]);
    expect(await values(RELAY)).toEqual([literal('/dns4/relay-of-peer-1/tcp/9090')]);
  });

  it('dates the peers of a stored union by its newest lastSeen the first time it changes, so that they age out', async () => {
    const { store, apply, values, datesHeld } = fixture();
    await store.insert([
      quad(PEER_ID, literal('peer-a')),
      quad(PEER_ID, literal('peer-b')),
      quad(LAST_SEEN, literal(minutesAgo(20))),
      quad(LAST_SEEN, literal(minutesAgo(10))),
    ]);
    await apply([quad(PEER_ID, literal('peer-z')), quad(LAST_SEEN, literal(minutesAgo(1)))]);
    expect(await datesHeld()).toEqual([date('peer-a', 10), date('peer-b', 10), date('peer-z', 1)]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(1))]);
  });

  it('dates a stored union at the first heartbeat of one of its peers, so that the live one comes first', async () => {
    const { store, apply, datesHeld, values } = fixture();
    await store.insert([
      quad(PEER_ID, literal('peer-a')),
      quad(PEER_ID, literal('peer-b')),
      quad(LAST_SEEN, literal(minutesAgo(40))),
    ]);
    await apply([quad(PEER_ID, literal('peer-b')), quad(LAST_SEEN, literal(minutesAgo(20)))]);
    expect(await datesHeld()).toEqual([date('peer-a', 40), date('peer-b', 20)]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(20))]);
  });

  it('leaves the first date of a subject\'s one peer to the next write', async () => {
    const { store, apply, datesHeld } = fixture();
    await store.insert([quad(PEER_ID, literal('peer-a')), quad(LAST_SEEN, literal(minutesAgo(40)))]);
    await apply([quad(PEER_ID, literal('peer-a')), quad(LAST_SEEN, literal(minutesAgo(20)))]);
    expect(await datesHeld()).toEqual([]);
  });

  it('takes no date from a peer it does not name, and none from a lastSeen when it has dates of its own', async () => {
    const { apply, datesHeld, values } = fixture();
    await apply(profile('peer-a', minutesAgo(30)));
    await apply([quad(DATED_PEER, literal(date('peer-a', 1))), quad(LAST_SEEN, literal(minutesAgo(1)))]);
    expect(await datesHeld()).toEqual([date('peer-a', 30)]);
    await apply([quad(DATED_PEER, literal(date('peer-a', 20))), quad(LAST_SEEN, literal(minutesAgo(1))), quad(PEER_ID, literal('peer-a'))]);
    expect(await datesHeld()).toEqual([date('peer-a', 20)]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(20))]);
  });

  it('takes the dates a node that keeps them holds, per peer, the newest of each', async () => {
    const { apply, datesHeld, values } = fixture();
    await apply(profile('peer-a', minutesAgo(30)));
    await apply([
      quad(PEER_ID, literal('peer-a')),
      quad(PEER_ID, literal('peer-b')),
      quad(DATED_PEER, literal(date('peer-a', 40))),
      quad(DATED_PEER, literal(date('peer-b', 2))),
      quad(DATED_PEER, literal(date('peer-unlisted', 1))),
      quad(DATED_PEER, literal('not-a-date')),
      quad(LAST_SEEN, literal(minutesAgo(2))),
      quad(MULTIADDR, literal('/dns4/relay/tcp/1/p2p-circuit/p2p/peer-b')),
      quad(RELAY, literal('/dns4/relay-of-b/tcp/1')),
    ]);
    expect(await datesHeld()).toEqual([date('peer-a', 30), date('peer-b', 2)]);
    expect(await values(RELAY)).toEqual([literal('/dns4/relay-of-b/tcp/1'), literal('/dns4/relay-of-peer-a/tcp/9090')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(2))]);
  });

  it('moves a peer forward when such a node holds a newer date for it, with the addresses it brings', async () => {
    const { apply, datesHeld, values } = fixture();
    await apply(profile('peer-a', minutesAgo(30)));
    await apply([
      quad(PEER_ID, literal('peer-a')),
      quad(DATED_PEER, literal(date('peer-a', 3))),
      quad(MULTIADDR, literal('/dns4/moved/tcp/1/p2p-circuit/p2p/peer-a')),
      quad(RELAY, literal('/dns4/moved/tcp/1')),
    ]);
    expect(await datesHeld()).toEqual([date('peer-a', 3)]);
    expect(await values(MULTIADDR)).toEqual([literal('/dns4/moved/tcp/1/p2p-circuit/p2p/peer-a')]);
    expect(await values(RELAY)).toEqual([literal('/dns4/moved/tcp/1')]);
  });

  it('puts a profile together that a sync delivered in two pages, on a subject it did not know', async () => {
    const { applyPage, values, datesHeld } = fixture();
    await applyPage([quad(LAST_SEEN, literal(minutesAgo(1))), quad(MULTIADDR, literal('/dns4/a/tcp/1'))]);
    await applyPage([quad(PEER_ID, literal('peer-1')), quad(RELAY, literal('/dns4/a/tcp/1'))]);
    expect(await values(PEER_ID)).toEqual([literal('peer-1')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(1))]);
    expect(await datesHeld()).toEqual([date('peer-1', 1)]);
    expect(await values(RELAY)).toEqual([literal('/dns4/a/tcp/1')]);
  });

  it('puts a newer profile of a known agent together across two pages', async () => {
    const { apply, applyPage, values, datesHeld } = fixture();
    await apply(profile('peer-old', minutesAgo(30)));
    await applyPage([quad(LAST_SEEN, literal(minutesAgo(1)))]);
    expect(await values(PEER_ID), 'a page without a peer changes nothing the subject holds').toEqual([literal('peer-old')]);
    await applyPage([quad(PEER_ID, literal('peer-new')), quad(RELAY, literal('/dns4/new/tcp/1'))]);
    expect(await datesHeld()).toEqual([date('peer-new', 1), date('peer-old', 30)]);
    expect(await values(RELAY)).toEqual([literal('/dns4/new/tcp/1'), literal('/dns4/relay-of-peer-old/tcp/9090')]);
  });

  it('joins an address that came ahead of the rest of its profile', async () => {
    const { apply, applyPage, values } = fixture();
    await apply(profile('peer-old', minutesAgo(30)));
    await applyPage([quad(LAST_SEEN, literal(minutesAgo(1))), quad(MULTIADDR, literal('/dns4/new/tcp/1/p2p-circuit/p2p/peer-new'))]);
    await applyPage([quad(PEER_ID, literal('peer-new'))]);
    expect(await values(MULTIADDR)).toEqual([
      literal('/dns4/new/tcp/1/p2p-circuit/p2p/peer-new'),
      literal('/dns4/relay-of-peer-old/tcp/9090/p2p-circuit/p2p/peer-old'),
    ]);
  });

  it('adds the last rows of a page\'s profile to a peer that page already dated', async () => {
    const { apply, applyPage, values, datesHeld } = fixture();
    await apply(profile('peer-old', minutesAgo(30)));
    await applyPage([quad(LAST_SEEN, literal(minutesAgo(1))), quad(PEER_ID, literal('peer-new'))]);
    expect(await datesHeld()).toEqual([date('peer-new', 1), date('peer-old', 30)]);
    await applyPage([quad(PUBLIC_KEY, literal('key-of-peer-new')), quad(RELAY, literal('/dns4/new/tcp/1'))]);
    expect(await values(PUBLIC_KEY)).toEqual([literal('key-of-peer-new'), literal('key-of-peer-old')]);
    expect(await values(RELAY)).toEqual([literal('/dns4/new/tcp/1'), literal('/dns4/relay-of-peer-old/tcp/9090')]);
  });

  it('takes a page that starts behind where the last one ended for another delivery', async () => {
    const { applyPage, values } = fixture();
    await applyPage([quad(LAST_SEEN, literal(minutesAgo(2))), quad(MULTIADDR, literal('/ip4/203.0.113.1/tcp/1/p2p/peer-x')), quad(PEER_ID, literal('peer-x'))]);
    await applyPage([quad(LAST_SEEN, literal(minutesAgo(1))), quad(PEER_ID, literal('peer-x'))]);
    expect(await values(MULTIADDR), 'the newer profile has no address').toEqual([]);
  });

  it('joins a page only to the last subject of the page before it', async () => {
    const { applyPage, values, datesHeld } = fixture();
    const other = 'did:dkg:agent:0x00000000000000000000000000000000000000cd';
    await applyPage([quad(LAST_SEEN, literal(minutesAgo(1))), quad(LAST_SEEN, literal(minutesAgo(1)), other)]);
    await applyPage([quad(PEER_ID, literal('peer-a')), quad(PEER_ID, literal('peer-b'), other)]);
    expect(await values(PEER_ID)).toEqual([literal('peer-a')]);
    expect(await datesHeld(), 'that subject ended with the page before').toEqual([]);
    expect(await datesHeld(other)).toEqual([date('peer-b', 1)]);
  });

  it('leaves what a subject past the bound holds to a page that names no peer', async () => {
    const { apply, applyPage, values } = fixture();
    await apply(profile('peer-z', new Date(NOW - AGENT_PROFILE_STALE_THRESHOLD_MS - 60_000).toISOString()));
    await applyPage([quad(LAST_SEEN, literal(minutesAgo(1)))]);
    expect(await values(RELAY)).toEqual([literal('/dns4/relay-of-peer-z/tcp/9090')]);
    expect(await values(PUBLIC_KEY)).toEqual([literal('key-of-peer-z')]);
  });

  it('does not join a gossiped profile, which is whole, to the page of a sync', async () => {
    const { apply, applyPage, values } = fixture();
    await apply(profile('peer-old', minutesAgo(30)));
    await applyPage([quad(LAST_SEEN, literal(minutesAgo(1)))]);
    await apply([quad(PEER_ID, literal('peer-new'))]);
    expect(await values(PEER_ID)).toEqual([literal('peer-old')]);
  });

  it('forgets the rows of a page that the next one did not follow in time', async () => {
    const { apply, applyPage, values } = fixture();
    await apply(profile('peer-old', minutesAgo(30)));
    await applyPage([quad(LAST_SEEN, literal(minutesAgo(1)))]);
    await applyPage([quad(PEER_ID, literal('peer-new'))], NOW + 10 * 60_000);
    expect(await values(PEER_ID)).toEqual([literal('peer-old')]);
  });

  it('ends the same whichever row a page of a sync ends on', async () => {
    const stale = AGENT_PROFILE_STALE_THRESHOLD_MS / 60_000 + 60;
    // A subject as a node that dates its peers serves it, in predicate order.
    const served = (minutesOfA: number): Quad[] => [
      quad(DATED_PEER, literal(`peer-a ${minutesAgo(minutesOfA)}`)),
      quad(DATED_PEER, literal(`peer-b ${minutesAgo(1)}`)),
      quad(LAST_SEEN, literal(minutesAgo(1))),
      quad(MULTIADDR, literal('/ip4/203.0.113.1/tcp/1/p2p/peer-a')),
      quad(MULTIADDR, literal('/ip4/203.0.113.2/tcp/2/p2p/peer-b')),
      quad(MULTIADDR, literal('/ip4/203.0.113.3/tcp/3')),
      quad(NODE_ROLE, literal('core')),
      quad(PEER_ID, literal('peer-a')),
      quad(PEER_ID, literal('peer-b')),
      quad(PUBLIC_KEY, literal('key-served')),
      quad(RELAY, literal('/dns4/relay-served/tcp/1')),
    ];
    const holdings: Record<string, Quad[][]> = {
      nothing: [],
      'another current peer': [profile('peer-c', minutesAgo(30))],
      'an older profile of the newest peer': [profile('peer-b', minutesAgo(30))],
      'an older profile of the other peer': [profile('peer-a', minutesAgo(30))],
      'older profiles of both': [profile('peer-a', minutesAgo(40)), profile('peer-b', minutesAgo(30))],
      'a peer past the bound': [profile('peer-z', minutesAgo(stale))],
    };
    const endState = async (held: Quad[][], pages: Quad[][]): Promise<string[]> => {
      const { apply, applyPage, store } = fixture();
      for (const update of held) await apply(update);
      for (const page of pages) await applyPage(page);
      const fields = [PEER_ID, LAST_SEEN, DATED_PEER, MULTIADDR, NODE_ROLE, PUBLIC_KEY, RELAY].map((field) => `<${field}>`).join(', ');
      const result = await store.query(`SELECT ?p ?o WHERE { GRAPH <${AGENT_REGISTRY_GRAPH}> { <${SUBJECT}> ?p ?o } FILTER(?p IN (${fields})) } ORDER BY ?p ?o`);
      return result.type === 'bindings' ? result.bindings.map((row) => `${row['p']} ${row['o']}`) : [];
    };
    for (const [holding, held] of Object.entries(holdings)) {
      for (const minutesOfA of [20, stale]) {
        const rows = served(minutesOfA);
        const whole = await endState(held, [rows]);
        for (let cut = 1; cut < rows.length; cut += 1) {
          expect(await endState(held, [rows.slice(0, cut), rows.slice(cut)]), `holding ${holding}, peer-a ${minutesOfA} minutes old, cut after row ${cut}`)
            .toEqual(whole);
        }
      }
    }
  });

  it('fills what the subject lacks from part of a profile', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-1', minutesAgo(30), { relayAddress: undefined }));
    await apply([quad(RELAY, literal('/dns4/b/tcp/2'))]);
    expect(await values(RELAY)).toEqual([literal('/dns4/b/tcp/2')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(30))]);
  });

  it('keeps a lastSeen when a part comes in and the subject has no peer yet', async () => {
    const { apply, values } = fixture();
    await apply([quad(LAST_SEEN, literal(minutesAgo(1)))]);
    await apply([quad(RELAY, literal('/dns4/a/tcp/1'))]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(1))]);
    expect(await values(RELAY)).toEqual([literal('/dns4/a/tcp/1')]);
  });

  it('gives a subject a peer from a whole profile when it held only a lastSeen', async () => {
    const { store, apply, values } = fixture();
    await store.insert([quad(LAST_SEEN, literal(minutesAgo(1)))]);
    await apply([quad(PEER_ID, literal('peer-1')), quad(LAST_SEEN, literal(minutesAgo(1)))]);
    expect(await values(PEER_ID)).toEqual([literal('peer-1')]);
  });

  it('does not let a lastSeen beyond the clock allowance add a peer beside a current one, or keep it', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-new', minutesAgo(1)));
    const farAhead = new Date(NOW + AGENT_LAST_SEEN_CLOCK_SKEW_MS + 1).toISOString();
    await apply([quad(PEER_ID, literal('peer-forged')), quad(LAST_SEEN, literal(farAhead))]);
    expect(await values(PEER_ID)).toEqual([literal('peer-new')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(1))]);
  });

  it('dates a peer with a stored lastSeen beyond the allowance from the first dated profile, so that it ages out', async () => {
    const { store, apply, values, datesHeld } = fixture();
    const farAhead = new Date(NOW + AGENT_LAST_SEEN_CLOCK_SKEW_MS + 1).toISOString();
    await store.insert([quad(PEER_ID, literal('peer-pinned')), quad(LAST_SEEN, literal(farAhead))]);
    await apply([quad(PEER_ID, literal('peer-new')), quad(LAST_SEEN, literal(minutesAgo(1)))]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(1))]);
    expect(await datesHeld()).toEqual([date('peer-new', 1), date('peer-pinned', 1)]);
  });

  it('stores no unusable lastSeen on a first profile: the peer stays without a date', async () => {
    const { apply, values, datesHeld } = fixture();
    await apply([quad(PEER_ID, literal('peer-1')), quad(LAST_SEEN, literal('not a date'))]);
    expect(await values(PEER_ID)).toEqual([literal('peer-1')]);
    expect(await values(LAST_SEEN)).toEqual([]);
    expect(await datesHeld()).toEqual([]);
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
  });

  it('adds a key of an older profile too: only a wallet-signed revocation retires one', async () => {
    const { apply, values } = fixture();
    await apply(profile('peer-new', minutesAgo(1)));
    await apply([
      ...profile('peer-old', minutesAgo(60)),
      quad(DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY, literal('encryption-old')),
    ]);
    expect(await values(DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY)).toEqual([literal('encryption-old')]);
  });

  it('leaves a value too large for the store to the insert, which must not count it as an update', async () => {
    const { store, values, datesHeld } = fixture();
    const apply = (quads: Quad[]) => storeAgentProfileQuads(store, quads, async (writes) => {
      const kept = writes.filter((write) => write.object.length <= DKG_RDF_LITERAL_SAFE_MUTF8_BYTES);
      await store.insert(kept);
      return kept;
    }, { nowMs: NOW });
    await apply(profile('peer-old', minutesAgo(30)));
    const huge = `peer-${'x'.repeat(DKG_RDF_LITERAL_SAFE_MUTF8_BYTES)}`;
    await apply([quad(PEER_ID, literal(huge)), quad(LAST_SEEN, literal(minutesAgo(1)))]);
    expect(await values(PEER_ID)).toEqual([literal('peer-old')]);
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(30))]);
    expect(await datesHeld()).toEqual([date('peer-old', 30)]);
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
    await apply(profile('peer-1', minutesAgo(600)));
    const order: string[] = [];
    const deleted = vi.spyOn(store, 'delete');
    await storeAgentProfileQuads(store, profile('peer-1', minutesAgo(5)), async (quads) => {
      order.push(`insert:${deleted.mock.calls.length}`);
      await store.insert(quads);
      return quads;
    }, { nowMs: NOW });
    expect(order).toEqual(['insert:0']);
    expect(deleted).toHaveBeenCalledTimes(1);

    deleted.mockClear();
    await expect(storeAgentProfileQuads(store, profile('peer-2', minutesAgo(0)), async () => {
      throw new Error('store is busy');
    }, { nowMs: NOW })).rejects.toThrow('store is busy');
    expect(deleted).not.toHaveBeenCalled();
    expect(await values(PEER_ID)).toEqual([literal('peer-1')]);
  });

  it('keeps working after an update failed, and updates that race end on the newest', async () => {
    const { store, insert, apply, values, datesHeld } = fixture();
    await expect(storeAgentProfileQuads(store, profile('peer-0', minutesAgo(90)), async () => {
      throw new Error('store is busy');
    }, { nowMs: NOW })).rejects.toThrow('store is busy');
    const updates = Array.from({ length: 12 }, (_, index) => profile(`peer-${String(index).padStart(2, '0')}`, minutesAgo(30 - index)));
    await Promise.all(updates.map((update, index) => (
      index % 2 === 0 ? apply(update) : storeAgentProfileQuads(store, update, insert, { nowMs: NOW })
    )));
    expect(await values(LAST_SEEN)).toEqual([literal(minutesAgo(19))]);
    expect(await datesHeld()).toHaveLength(12);
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
      expect(await values(PEER_ID, subjectOf(index))).toEqual([literal(`new-${index}`), literal(`old-${index}`)]);
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
      .resolves.toHaveLength(profile('peer-1', minutesAgo(1)).length + 1);
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
    expect(writes.insert.map((write) => write.object)).toEqual(expect.arrayContaining([
      literal('peer-new'), literal(`peer-new ${minutesAgo(1)}`), literal(`peer-old ${minutesAgo(60)}`), literal(minutesAgo(1)),
    ]));
    expect(writes.remove).toEqual([held[1]]);
  });

  it('are nothing for nothing', () => {
    expect(planAgentProfileWrites([], [], NOW)).toEqual({ insert: [], remove: [] });
  });

  it('accept a lastSeen ahead of the clock within the allowance, and refuse one beyond it', () => {
    expect(usableLastSeenMs(new Date(NOW + AGENT_LAST_SEEN_CLOCK_SKEW_MS).toISOString(), NOW)).toBe(NOW + AGENT_LAST_SEEN_CLOCK_SKEW_MS);
    expect(usableLastSeenMs(new Date(NOW + AGENT_LAST_SEEN_CLOCK_SKEW_MS + 1).toISOString(), NOW)).toBeUndefined();
    expect(usableLastSeenMs('', NOW)).toBeUndefined();
  });

  it('read a peer and its date from one literal, and nothing from one without a usable date', () => {
    expect(parseAgentDatedPeer(literal(`peer-1 ${minutesAgo(1)}`), NOW)).toEqual({ peerId: 'peer-1', seen: { iso: minutesAgo(1), ms: NOW - 60_000 } });
    expect(parseAgentDatedPeer(literal('peer-1'), NOW)).toBeUndefined();
    expect(parseAgentDatedPeer(literal('peer-1 soon'), NOW)).toBeUndefined();
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

  it('leaves out any date for a peer: that is this node\'s to set', () => {
    const date = quad(DATED_PEER, literal(`peer-other ${minutesAgo(1)}`));
    expect(gossipedAgentProfileQuads([...update, date], { fromPeerId: FROM, knownAgent: false })).toEqual(update);
    expect(gossipedAgentProfileQuads([date], { fromPeerId: FROM, knownAgent: true })).toEqual([]);
  });

  it('is nothing of a profile that names another peer than its sender, skolem children included', () => {
    expect(gossipedAgentProfileQuads(update, { fromPeerId: 'peer-other', knownAgent: false })).toEqual([]);
  });

  it('is nothing of an agent\'s quads when they name no peer, or another one as well', () => {
    const noPeer = [quad(LAST_SEEN, literal(minutesAgo(1))), quad(RELAY, literal('/dns4/a/tcp/1'))];
    expect(gossipedAgentProfileQuads(noPeer, { fromPeerId: FROM, knownAgent: true })).toEqual([]);
    expect(gossipedAgentProfileQuads(noPeer, { fromPeerId: FROM, knownAgent: false })).toEqual([]);
    const both = [...update, quad(PEER_ID, literal('peer-other'))];
    expect(gossipedAgentProfileQuads(both, { fromPeerId: FROM, knownAgent: true })).toEqual([]);
  });

  it('is nothing of a key\'s quads when the profile they come with names another peer', () => {
    const revocation = quad(DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_REVOCATION_PROOF, literal('proof'), `${SUBJECT}#x25519-old`);
    expect(gossipedAgentProfileQuads([...update, revocation], { fromPeerId: 'peer-other', knownAgent: true })).toEqual([]);
    expect(gossipedAgentProfileQuads([revocation], { fromPeerId: FROM, knownAgent: true })).toEqual([]);
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
