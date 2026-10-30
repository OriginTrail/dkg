// SPDX-License-Identifier: Apache-2.0

/**
 * The peers to try for a wallet: newest `dkg:lastSeen` first, without stale
 * ones (`DiscoveryClient.findCurrentAgentPeerIds`), against the real store and
 * query engine.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { AGENT_LAST_SEEN_CLOCK_SKEW_MS } from '../src/agent-peer-discovery.js';
import { storeAgentProfileQuads } from '../src/agent-profile-updates.js';
import { AGENT_PROFILE_STALE_THRESHOLD_MS } from '../src/dkg-agent-constants.js';
import { DiscoveryClient } from '../src/discovery.js';
import { AGENT_REGISTRY_GRAPH, buildAgentProfile } from '../src/profile.js';

const WALLET = '0x00000000000000000000000000000000000000ab';
const DKG = 'https://dkg.network/ontology#';
const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const HOUR = 60 * 60_000;

/**
 * A wallet's profile under a subject of its own, so that its peer and its
 * `dkg:lastSeen` stay paired, as the rows of a legacy subject do beside the
 * canonical one.
 */
function peerProfile(peerId: string, lastSeen: string | undefined): Quad[] {
  const { quads, rootEntity } = buildAgentProfile({ peerId, name: peerId, skills: [], lastSeen: lastSeen ?? ago(0) });
  return [
    ...quads.filter((quad) => lastSeen !== undefined || quad.predicate !== `${DKG}lastSeen`),
    { subject: rootEntity, predicate: `${DKG}agentAddress`, object: `"${WALLET}"`, graph: AGENT_REGISTRY_GRAPH },
  ];
}

describe('the peers to try for a wallet', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

  async function fixture(quads: Quad[]) {
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert(quads);
    const discovery = new DiscoveryClient(new DKGQueryEngine(store));
    return { store, discovery };
  }

  it('resolve a wallet with both stale and live peers to the live one first', async () => {
    const { discovery } = await fixture([
      ...peerProfile('peer-a-stale', ago(AGENT_PROFILE_STALE_THRESHOLD_MS + HOUR)),
      ...peerProfile('peer-b-older', ago(6 * HOUR)),
      ...peerProfile('peer-z-live', ago(60_000)),
    ]);
    await expect(discovery.findCurrentAgentPeerIds(WALLET, { limit: 8, nowMs: NOW }))
      .resolves.toEqual(['peer-z-live', 'peer-b-older']);
  });

  it('do not resolve a wallet with only stale peers', async () => {
    const { discovery } = await fixture([
      ...peerProfile('peer-a', ago(AGENT_PROFILE_STALE_THRESHOLD_MS + 1)),
      ...peerProfile('peer-b', ago(3 * AGENT_PROFILE_STALE_THRESHOLD_MS)),
    ]);
    await expect(discovery.findCurrentAgentPeerIds(WALLET, { limit: 8, nowMs: NOW })).resolves.toEqual([]);
  });

  it('count a peer at the bound as current, and take a bound from the caller', async () => {
    const { discovery } = await fixture(peerProfile('peer-a', ago(AGENT_PROFILE_STALE_THRESHOLD_MS)));
    await expect(discovery.findCurrentAgentPeerIds(WALLET, { limit: 8, nowMs: NOW })).resolves.toEqual(['peer-a']);
    await expect(discovery.findCurrentAgentPeerIds(WALLET, { limit: 8, nowMs: NOW, staleAfterMs: HOUR })).resolves.toEqual([]);
  });

  it('are not ordered by peer id: the newest comes first wherever its id sorts', async () => {
    const { discovery } = await fixture([
      ...peerProfile('peer-1', ago(3 * HOUR)),
      ...peerProfile('peer-2', ago(2 * HOUR)),
      ...peerProfile('peer-3', ago(4 * HOUR)),
      ...peerProfile('peer-9', ago(HOUR)),
    ]);
    await expect(discovery.findCurrentAgentPeerIds(WALLET, { limit: 2, nowMs: NOW })).resolves.toEqual(['peer-9', 'peer-2']);
  });

  it('keep a stale peer the caller knows to be alive, in its place by date', async () => {
    const { discovery } = await fixture([
      ...peerProfile('peer-a-stale-alive', ago(AGENT_PROFILE_STALE_THRESHOLD_MS + HOUR)),
      ...peerProfile('peer-b-stale', ago(AGENT_PROFILE_STALE_THRESHOLD_MS + 2 * HOUR)),
      ...peerProfile('peer-c-live', ago(HOUR)),
    ]);
    await expect(discovery.findCurrentAgentPeerIds(WALLET, {
      limit: 8, nowMs: NOW, isLive: (peerId) => peerId === 'peer-a-stale-alive',
    })).resolves.toEqual(['peer-c-live', 'peer-a-stale-alive']);
  });

  it('keep an undated profile, after the dated ones: it says nothing about its age', async () => {
    const { discovery } = await fixture([
      ...peerProfile('peer-a-undated', undefined),
      ...peerProfile('peer-b-dated', ago(HOUR)),
      ...peerProfile('peer-c-undated', undefined),
    ]);
    await expect(discovery.findCurrentAgentPeerIds(WALLET, { limit: 8, nowMs: NOW }))
      .resolves.toEqual(['peer-b-dated', 'peer-a-undated', 'peer-c-undated']);
  });

  it('treat a lastSeen beyond the clock allowance as no date, behind any dated peer', async () => {
    const farAhead = new Date(NOW + AGENT_LAST_SEEN_CLOCK_SKEW_MS + 1).toISOString();
    const { discovery } = await fixture([
      ...peerProfile('peer-a-ahead', farAhead),
      ...peerProfile('peer-b-dated', ago(HOUR)),
    ]);
    await expect(discovery.findCurrentAgentPeerIds(WALLET, { limit: 8, nowMs: NOW }))
      .resolves.toEqual(['peer-b-dated', 'peer-a-ahead']);
  });

  it('take a peer listed under two subjects at its newest date', async () => {
    const { discovery } = await fixture([
      ...peerProfile('peer-b', ago(2 * HOUR)),
      ...peerProfile('peer-a', ago(3 * HOUR)),
      ...buildAgentProfile({ peerId: 'peer-a', name: 'again', skills: [], agentAddress: WALLET, lastSeen: ago(HOUR) }).quads,
    ]);
    await expect(discovery.findCurrentAgentPeerIds(WALLET, { limit: 8, nowMs: NOW })).resolves.toEqual(['peer-a', 'peer-b']);
  });

  it('find a wallet whatever the case of the stored or asked-for address', async () => {
    const mixed = '0xABCDEF00000000000000000000000000000000AB';
    const { discovery } = await fixture(buildAgentProfile({
      peerId: 'peer-a', name: 'a', skills: [], agentAddress: mixed, lastSeen: ago(HOUR),
    }).quads);
    await expect(discovery.findCurrentAgentPeerIds(mixed.toLowerCase(), { limit: 8, nowMs: NOW })).resolves.toEqual(['peer-a']);
    await expect(discovery.findCurrentAgentPeerIds(mixed, { limit: 8, nowMs: NOW })).resolves.toEqual(['peer-a']);
  });

  it('find an address that is not an EVM wallet as written', async () => {
    const { discovery, store } = await fixture([]);
    await store.insert(peerProfile('peer-a', ago(HOUR)).map((quad) => (
      quad.predicate === `${DKG}agentAddress` ? { ...quad, object: '"agent-handle"' } : quad
    )));
    await expect(discovery.findCurrentAgentPeerIds('agent-handle', { limit: 8, nowMs: NOW })).resolves.toEqual(['peer-a']);
  });

  it('are empty for a wallet nobody lists, and use the clock when no time is given', async () => {
    const { discovery } = await fixture(peerProfile('peer-a', new Date().toISOString()));
    await expect(discovery.findCurrentAgentPeerIds('0x00000000000000000000000000000000000000cd', { limit: 8 })).resolves.toEqual([]);
    await expect(discovery.findCurrentAgentPeerIds(WALLET, { limit: 8 })).resolves.toEqual(['peer-a']);
  });

  it('skip a row without a peer id', async () => {
    const { discovery } = await fixture([]);
    const engine = { query: async () => ({ bindings: [{ lastSeen: `"${ago(HOUR)}"` }, { peerId: '"peer-a"' }] }) };
    const stubbed = new DiscoveryClient(engine as unknown as DKGQueryEngine);
    await expect(stubbed.findCurrentAgentPeerIds(WALLET, { limit: 8, nowMs: NOW })).resolves.toEqual(['peer-a']);
    await expect(discovery.findCurrentAgentPeerIds(WALLET, { limit: 8, nowMs: NOW })).resolves.toEqual([]);
  });

  it('stop at an aborted signal', async () => {
    const { discovery } = await fixture(peerProfile('peer-a', ago(HOUR)));
    const controller = new AbortController();
    controller.abort(new Error('caller stopped'));
    await expect(discovery.findCurrentAgentPeerIds(WALLET, { limit: 8, nowMs: NOW, signal: controller.signal }))
      .rejects.toThrow();
  });

  it('are the one current peer once an update replaced the union an earlier sync stored', async () => {
    const union = [
      ...buildAgentProfile({ peerId: 'peer-a-dead', name: 'a', skills: [], agentAddress: WALLET, lastSeen: ago(6 * HOUR) }).quads,
      ...buildAgentProfile({ peerId: 'peer-b-dead', name: 'a', skills: [], agentAddress: WALLET, lastSeen: ago(5 * HOUR) }).quads,
    ];
    const { store, discovery } = await fixture(union);
    await expect(discovery.findCurrentAgentPeerIds(WALLET, { limit: 8, nowMs: NOW }))
      .resolves.toEqual(['peer-a-dead', 'peer-b-dead']);
    await storeAgentProfileQuads(
      store,
      buildAgentProfile({ peerId: 'peer-z-live', name: 'a', skills: [], agentAddress: WALLET, lastSeen: ago(60_000) }).quads,
      async (quads) => { await store.insert(quads); return quads; },
      { nowMs: NOW },
    );
    await expect(discovery.findCurrentAgentPeerIds(WALLET, { limit: 8, nowMs: NOW })).resolves.toEqual(['peer-z-live']);
    await expect(discovery.findAgentPeerPageByAddress(WALLET, { limit: 8 }))
      .resolves.toEqual({ peerIds: ['peer-z-live'], nextAfterPeerId: null });
  });
});
