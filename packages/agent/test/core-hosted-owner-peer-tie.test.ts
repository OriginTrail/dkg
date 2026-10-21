// SPDX-License-Identifier: Apache-2.0

/**
 * What a Core checks of a share before it takes the share's sender for a node
 * of the graph's owner (`core-hosted-owner-peer-tie.ts`): the owner the graph
 * id names signed the envelope, recently, over a plain share that names the
 * sender as its publisher; how many signatures it checks; and how it keeps
 * the ties. The Core's use of the tie is in core-hosted-definition.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  computeGossipSigningPayload,
  encodeGossipEnvelope,
  GOSSIP_ENVELOPE_FRESHNESS_MS,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import {
  OWNER_TIE_CHECK_SENDERS_MAX,
  OWNER_TIE_CHECKS_PER_MINUTE,
  OWNER_TIE_CHECKS_PER_SENDER_PER_MINUTE,
  OWNER_TIE_HOSTED_MAX,
  OWNER_TIE_HOSTED_TTL_MS,
  OWNER_TIE_PENDING_MAX,
  OWNER_TIE_PENDING_PER_SENDER,
  OWNER_TIE_PENDING_TTL_MS,
  ownerPeerClaimHolds,
  OwnerPeerTies,
  OwnerTieCheckBudget,
  readOwnerPeerClaim as readClaim,
  readOwnerShareHeader,
  type OwnerPeerClaim,
} from '../src/core-hosted-owner-peer-tie.js';
import { RELAYED_SHARE_FUTURE_SKEW_MS } from '../src/swm/owner-share-forward.js';
import {
  OWNER_WALLET,
  RELAYED_CG,
  STRANGER,
  encryptedPayload,
  relayedShareRequest,
  senderKeyPayload,
  signedEnvelope,
} from './_helpers/relayed-share-fixtures.js';

const OWNER_NODE = '12D3KooWOwnerNodeOfTheGraph';
const OTHER_NODE = '12D3KooWAnotherNode';
const NOW = Date.parse('2026-10-19T12:00:00.000Z');

/** Every check but the signature, as the Core runs them: the header first, then the rest. */
function readOwnerPeerClaim(wire: Uint8Array, fromPeerId: string, now: number): OwnerPeerClaim | null {
  const header = readOwnerShareHeader(wire);
  return header === null ? null : readClaim(header, fromPeerId, now);
}

/** The owner's share naming `publisherPeerId`, signed by `signer` at `signedAt`. */
async function ownerShare(options: {
  readonly signer?: ethers.Wallet;
  readonly publisherPeerId?: string;
  readonly contextGraphId?: string;
  readonly payloadGraphId?: string;
  readonly signedAt?: number;
} = {}): Promise<Uint8Array> {
  const contextGraphId = options.contextGraphId ?? RELAYED_CG;
  const payload = await relayedShareRequest({
    contextGraphId: options.payloadGraphId ?? contextGraphId,
    publisherPeerId: options.publisherPeerId ?? OWNER_NODE,
  });
  return signedEnvelope(payload, options.signer ?? OWNER_WALLET, { contextGraphId, signedAt: new Date(options.signedAt ?? NOW) });
}

/** An envelope with the given fields around `payload`, as a sender may craft it. */
function crafted(fields: Partial<Parameters<typeof encodeGossipEnvelope>[0]>, payload: Uint8Array): Uint8Array {
  return encodeGossipEnvelope({
    version: GOSSIP_ENVELOPE_VERSION,
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH,
    contextGraphId: RELAYED_CG,
    agentAddress: OWNER_WALLET.address,
    timestamp: new Date(NOW).toISOString(),
    signature: new Uint8Array(65).fill(1),
    payload,
    ...fields,
  });
}

describe('readOwnerPeerClaim and ownerPeerClaimHolds', () => {
  it('takes the owner\'s signed share naming the node that delivered it', async () => {
    const claim = readOwnerPeerClaim(await ownerShare(), OWNER_NODE, NOW);
    expect(claim).toMatchObject({
      contextGraphId: RELAYED_CG,
      owner: OWNER_WALLET.address.toLowerCase(),
      peerId: OWNER_NODE,
      signedAt: NOW,
    });
    expect(ownerPeerClaimHolds(claim!)).toBe(true);
    // At both edges of the freshness window.
    expect(readOwnerPeerClaim(await ownerShare({ signedAt: NOW - GOSSIP_ENVELOPE_FRESHNESS_MS }), OWNER_NODE, NOW)).not.toBeNull();
    expect(readOwnerPeerClaim(await ownerShare({ signedAt: NOW + RELAYED_SHARE_FUTURE_SKEW_MS }), OWNER_NODE, NOW)).not.toBeNull();
  });

  it('refuses the owner\'s share delivered by another node than the one it names', async () => {
    expect(readOwnerPeerClaim(await ownerShare(), OTHER_NODE, NOW)).toBeNull();
    expect(readOwnerPeerClaim(await ownerShare({ publisherPeerId: OTHER_NODE }), OWNER_NODE, NOW)).toBeNull();
  });

  it('refuses a share another wallet signed, and one for a graph whose id names another wallet', async () => {
    expect(readOwnerPeerClaim(await ownerShare({ signer: STRANGER }), OWNER_NODE, NOW)).toBeNull();
    const strangersGraph = `${STRANGER.address.toLowerCase()}/relayed-share`;
    expect(readOwnerPeerClaim(await ownerShare({ contextGraphId: strangersGraph }), OWNER_NODE, NOW)).toBeNull();
    // A graph id that names no wallet: nothing to tie a node to.
    expect(readOwnerPeerClaim(await ownerShare({ contextGraphId: 'plain-graph' }), OWNER_NODE, NOW)).toBeNull();
  });

  it('refuses a share signed outside the freshness window or without a valid time', async () => {
    expect(readOwnerPeerClaim(await ownerShare({ signedAt: NOW - GOSSIP_ENVELOPE_FRESHNESS_MS - 1 }), OWNER_NODE, NOW)).toBeNull();
    expect(readOwnerPeerClaim(await ownerShare({ signedAt: NOW + RELAYED_SHARE_FUTURE_SKEW_MS + 1 }), OWNER_NODE, NOW)).toBeNull();
    const payload = await relayedShareRequest({ publisherPeerId: OWNER_NODE });
    expect(readOwnerPeerClaim(crafted({ timestamp: 'not a time' }, payload), OWNER_NODE, NOW)).toBeNull();
  });

  it('refuses a share whose payload names another graph than its envelope', async () => {
    const other = `${OWNER_WALLET.address.toLowerCase()}/another-graph`;
    expect(readOwnerPeerClaim(await ownerShare({ payloadGraphId: other }), OWNER_NODE, NOW)).toBeNull();
  });

  it('refuses sender-key, encrypted and unsigned payloads, a payload that is no share, and bytes that are no envelope', async () => {
    expect(readOwnerPeerClaim(await signedEnvelope(senderKeyPayload(), OWNER_WALLET), OWNER_NODE, NOW)).toBeNull();
    expect(readOwnerPeerClaim(await signedEnvelope(encryptedPayload(), OWNER_WALLET), OWNER_NODE, NOW)).toBeNull();
    const payload = await relayedShareRequest({ publisherPeerId: OWNER_NODE });
    expect(readOwnerPeerClaim(crafted({ signature: new Uint8Array() }, payload), OWNER_NODE, NOW)).toBeNull();
    expect(readOwnerPeerClaim(crafted({}, new Uint8Array([0xff, 0xff, 0xff])), OWNER_NODE, NOW)).toBeNull();
    expect(readOwnerPeerClaim(new Uint8Array([1, 2, 3]), OWNER_NODE, NOW)).toBeNull();
  });

  it('refuses another envelope version or type, and an empty payload', async () => {
    const payload = await relayedShareRequest({ publisherPeerId: OWNER_NODE });
    expect(readOwnerPeerClaim(crafted({ version: '9.9.9' }, payload), OWNER_NODE, NOW)).toBeNull();
    expect(readOwnerPeerClaim(crafted({ type: 'another-type' }, payload), OWNER_NODE, NOW)).toBeNull();
    expect(readOwnerPeerClaim(crafted({}, new Uint8Array()), OWNER_NODE, NOW)).toBeNull();
  });

  it('finds the signature false when the envelope claims the owner but another wallet signed it, or it is no signature', async () => {
    const payload = await relayedShareRequest({ publisherPeerId: OWNER_NODE });
    const timestamp = new Date(NOW).toISOString();
    // The bytes the owner would sign; the stranger signs them instead.
    const strangersSignature = ethers.getBytes(await STRANGER.signMessage(
      computeGossipSigningPayload(GOSSIP_TYPE_WORKSPACE_PUBLISH, RELAYED_CG, timestamp, payload),
    ));
    const forged = readOwnerPeerClaim(crafted({ timestamp, signature: strangersSignature }, payload), OWNER_NODE, NOW);
    expect(forged).not.toBeNull();
    expect(ownerPeerClaimHolds(forged!)).toBe(false);
    const garbage = readOwnerPeerClaim(crafted({ timestamp, signature: new Uint8Array([1, 2, 3]) }, payload), OWNER_NODE, NOW);
    expect(garbage).not.toBeNull();
    expect(ownerPeerClaimHolds(garbage!)).toBe(false);
  });
});

describe('readOwnerShareHeader', () => {
  it('reads the graph and its owner from an envelope whose signer address is the owner, before anything else is checked', async () => {
    // A stale envelope delivered by another node: the header alone says nothing about either.
    const header = readOwnerShareHeader(await ownerShare({ signedAt: NOW - 10 * GOSSIP_ENVELOPE_FRESHNESS_MS, publisherPeerId: OTHER_NODE }));
    expect(header).toMatchObject({ contextGraphId: RELAYED_CG, owner: OWNER_WALLET.address.toLowerCase() });
    expect(readClaim(header!, OWNER_NODE, NOW)).toBeNull();
  });

  it('reads nothing from an envelope whose signer address is not the owner the graph id names', async () => {
    const payload = await relayedShareRequest({ publisherPeerId: OWNER_NODE });
    expect(readOwnerShareHeader(crafted({ agentAddress: STRANGER.address }, payload))).toBeNull();
    expect(readOwnerShareHeader(crafted({ contextGraphId: 'plain-graph' }, payload))).toBeNull();
    expect(readOwnerShareHeader(crafted({ version: '9.9.9' }, payload))).toBeNull();
    expect(readOwnerShareHeader(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('OwnerTieCheckBudget', () => {
  it(`allows ${OWNER_TIE_CHECKS_PER_SENDER_PER_MINUTE} checks per sender a minute, then refuses it until its minute ends`, () => {
    let now = NOW;
    const budget = new OwnerTieCheckBudget({}, () => now);
    for (let i = 0; i < OWNER_TIE_CHECKS_PER_SENDER_PER_MINUTE; i += 1) expect(budget.allow(OTHER_NODE)).toBe(true);
    expect(budget.allow(OTHER_NODE)).toBe(false);
    expect(budget.allow(OWNER_NODE)).toBe(true);
    now += 59_999;
    expect(budget.allow(OTHER_NODE)).toBe(false);
    now += 1;
    expect(budget.allow(OTHER_NODE)).toBe(true);
  });

  it(`allows at most ${OWNER_TIE_CHECKS_PER_MINUTE} checks a minute in all, however many senders rotate`, () => {
    let now = NOW;
    const budget = new OwnerTieCheckBudget({}, () => now);
    let allowed = 0;
    // One check each from ever more nodes, then up to each node's own limit.
    for (let i = 0; i < 4 * OWNER_TIE_CHECK_SENDERS_MAX; i += 1) {
      if (budget.allow(`12D3KooWRotating${i}`)) allowed += 1;
    }
    expect(allowed).toBe(OWNER_TIE_CHECK_SENDERS_MAX);
    for (let i = 0; i < OWNER_TIE_CHECK_SENDERS_MAX + 1; i += 1) {
      for (let j = 0; j < OWNER_TIE_CHECKS_PER_SENDER_PER_MINUTE; j += 1) {
        if (budget.allow(`12D3KooWRotating${i}`)) allowed += 1;
      }
    }
    expect(allowed).toBe(OWNER_TIE_CHECKS_PER_MINUTE);
    // Any further node waits for the next minute.
    expect(budget.allow(OWNER_NODE)).toBe(false);
    now += 60_000;
    expect(budget.allow(OWNER_NODE)).toBe(true);
  });

  it('gives a sender that used up its checks no fresh count when other senders fill the table', () => {
    let now = NOW;
    const budget = new OwnerTieCheckBudget({ perMinute: 1_000_000 }, () => now);
    for (let i = 0; i < OWNER_TIE_CHECKS_PER_SENDER_PER_MINUTE; i += 1) budget.allow(OTHER_NODE);
    expect(budget.allow(OTHER_NODE)).toBe(false);
    // As many other nodes are checked once each within the same minute.
    let others = 0;
    for (let i = 0; i < OWNER_TIE_CHECK_SENDERS_MAX; i += 1) {
      now += 1;
      if (budget.allow(`12D3KooWFiller${i}`)) others += 1;
    }
    expect(others).toBe(OWNER_TIE_CHECK_SENDERS_MAX - 1);
    expect(budget.allow(OTHER_NODE)).toBe(false);
    // Once its minute ends its count ends, and it makes room for one more sender.
    now = NOW + 60_000;
    expect(budget.allow(OTHER_NODE)).toBe(true);
    expect(budget.allow('12D3KooWFillerLate')).toBe(false);
    now += OWNER_TIE_CHECK_SENDERS_MAX;
    expect(budget.allow('12D3KooWFillerLate')).toBe(true);
  });
});

describe('OwnerPeerTies', () => {
  const GRAPH = RELAYED_CG;
  const OWNER = OWNER_WALLET.address.toLowerCase();
  const junkGraph = (i: number) => `${STRANGER.address.toLowerCase()}/junk-${i}`;
  const junkNode = (i: number) => `12D3KooWJunkNode${i}`;

  it('keeps a hosted graph\'s tie apart from ties of graphs not hosted yet, which cannot push it out', () => {
    const ties = new OwnerPeerTies(() => NOW);
    ties.record(GRAPH, OWNER, OWNER_NODE, true);
    for (let i = 0; i < 4 * OWNER_TIE_PENDING_MAX; i += 1) ties.record(junkGraph(i), STRANGER.address.toLowerCase(), junkNode(i), false);
    expect(ties.get(GRAPH, true)?.peerId).toBe(OWNER_NODE);
    expect(ties.sizes).toEqual({ hosted: 1, pending: OWNER_TIE_PENDING_MAX });
    // Hosted graphs push each other out only past their own bound.
    for (let i = 0; i < OWNER_TIE_HOSTED_MAX; i += 1) ties.record(`${OWNER}/hosted-${i}`, OWNER, OWNER_NODE, true);
    expect(ties.get(GRAPH, true)).toBeUndefined();
    expect(ties.sizes.hosted).toBe(OWNER_TIE_HOSTED_MAX);
  });

  it(`keeps ${OWNER_TIE_PENDING_PER_SENDER} ties of graphs not hosted yet per node, its oldest giving way`, () => {
    const ties = new OwnerPeerTies(() => NOW);
    ties.record(GRAPH, OWNER, OWNER_NODE, false);
    for (let i = 0; i < 3 * OWNER_TIE_PENDING_PER_SENDER; i += 1) ties.record(junkGraph(i), STRANGER.address.toLowerCase(), OTHER_NODE, false);
    expect(ties.sizes.pending).toBe(OWNER_TIE_PENDING_PER_SENDER + 1);
    expect(ties.get(junkGraph(0), false)).toBeUndefined();
    expect(ties.get(junkGraph(3 * OWNER_TIE_PENDING_PER_SENDER - 1), false)?.peerId).toBe(OTHER_NODE);
    // The owner's pending tie is untouched by another node's.
    expect(ties.get(GRAPH, false)?.peerId).toBe(OWNER_NODE);
  });

  it('moves a pending tie to the hosted ties once its graph is hosted, and lets each kind lapse after its time unless renewed', () => {
    let now = NOW;
    const ties = new OwnerPeerTies(() => now);
    ties.record(GRAPH, OWNER, OWNER_NODE, false);
    ties.record(junkGraph(1), STRANGER.address.toLowerCase(), OTHER_NODE, false);
    now += OWNER_TIE_PENDING_TTL_MS - 1;
    // The tied node's share renews its tie; another node's does not.
    expect(ties.renew(GRAPH, OWNER_NODE)).toBe(true);
    expect(ties.renew(GRAPH, OTHER_NODE)).toBe(false);
    now += 1;
    expect(ties.get(junkGraph(1), false)).toBeUndefined();
    expect(ties.get(GRAPH, false)?.peerId).toBe(OWNER_NODE);
    expect(ties.sizes).toEqual({ hosted: 0, pending: 1 });
    expect(ties.get(GRAPH, true)?.peerId).toBe(OWNER_NODE);
    expect(ties.sizes).toEqual({ hosted: 1, pending: 0 });
    // Hosted, it outlasts the pending time and lapses after its own, counted from the renewal.
    now += OWNER_TIE_HOSTED_TTL_MS - 2;
    expect(ties.get(GRAPH, true)?.peerId).toBe(OWNER_NODE);
    now += 1;
    expect(ties.get(GRAPH, true)).toBeUndefined();
    expect(ties.renew(GRAPH, OWNER_NODE)).toBe(false);
  });

  it('replaces a graph\'s tie with the latest node, hosted or not, and makes room by dropping lapsed pending ties first', () => {
    let now = NOW;
    const ties = new OwnerPeerTies(() => now);
    ties.record(GRAPH, OWNER, OWNER_NODE, true);
    ties.record(GRAPH, OWNER, OTHER_NODE, false);
    expect(ties.sizes).toEqual({ hosted: 0, pending: 1 });
    expect(ties.get(GRAPH, false)?.peerId).toBe(OTHER_NODE);
    for (let i = 0; i < OWNER_TIE_PENDING_MAX - 1; i += 1) ties.record(junkGraph(i), STRANGER.address.toLowerCase(), junkNode(i), false);
    now += OWNER_TIE_PENDING_TTL_MS;
    ties.record(junkGraph(OWNER_TIE_PENDING_MAX), STRANGER.address.toLowerCase(), junkNode(0), false);
    expect(ties.sizes.pending).toBe(1);
  });
});
