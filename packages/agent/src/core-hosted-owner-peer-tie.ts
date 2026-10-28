// SPDX-License-Identifier: Apache-2.0

/**
 * Which node of a registered public graph's owner a Core may ask first for the
 * graph's definition (`core-hosted-definition.ts`).
 *
 * A StorageACK request carries no signature of its own, so the peer that sends
 * one proves nothing about the graph's owner. A share into the graph does: its
 * envelope is signed by the writing agent's wallet over the graph id, the
 * signing time and the share request, and the request names the node that
 * publishes it. A share is a claim for the node that delivered it when:
 *  - the envelope is a plain, signed share (not sender-key, not encrypted);
 *  - its signer is the owner wallet the graph id names (`<wallet>/<name>`),
 *    the wallet the graph's definition must name as its curator;
 *  - it was signed within `GOSSIP_ENVELOPE_FRESHNESS_MS` before now, or at
 *    most `RELAYED_SHARE_FUTURE_SKEW_MS` ahead of it;
 *  - the request names the envelope's graph and, as its publisher, the peer
 *    that delivered it over its own authenticated connection;
 *  - and the signature recovers to that wallet.
 * The owner's wallet signed a statement naming that node: the same share
 * delivered by any other peer ties nothing, and an edited request fails the
 * signature check. The request may carry no content at all: the owner's node
 * offers the tie to the Cores it is connected to that way
 * (`swm/owner-tie-offer.ts`).
 *
 * The checks run cheapest first: the envelope and its signer's address
 * ({@link readOwnerShareHeader}), then the rest but the signature
 * ({@link readOwnerPeerClaim}), and the signature last
 * ({@link ownerPeerClaimHolds}). Between the first two the caller skips the
 * node it has tied to the graph already, and before the signature it asks
 * {@link OwnerTieCheckBudget}: at most a number of signature checks per
 * sending node and per node in all each minute.
 *
 * The ties ({@link OwnerPeerTies}) of graphs the Core hosts and of graphs it
 * does not host yet are kept apart: the latter are few per sending node,
 * short-lived, and never take the place of a hosted graph's tie.
 */

import {
  computeGossipSigningPayload,
  decodeGossipEnvelope,
  decodeWorkspacePublishRequest,
  GOSSIP_ENVELOPE_FRESHNESS_MS,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  type GossipEnvelopeMsg,
  type WorkspacePublishRequestMsg,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { rememberBounded } from './bounded-map.js';
import { rfc64UnregisteredAuthorityOwnerV1 } from './rfc64/unregistered-authority-transport-v1.js';
import { decodedShareEnvelopeKind, RELAYED_SHARE_FUTURE_SKEW_MS } from './swm/owner-share-forward.js';

/** Signature checks of shares per sending node and minute. */
export const OWNER_TIE_CHECKS_PER_SENDER_PER_MINUTE = 60;
/** Signature checks of shares per minute in all, whoever sends them. */
export const OWNER_TIE_CHECKS_PER_MINUTE = 300;
/** Sending nodes whose checks are counted at once; a node beyond them is not checked until a count ends. */
export const OWNER_TIE_CHECK_SENDERS_MAX = 256;
/** Hosted graphs whose tied node a Core remembers at most. */
export const OWNER_TIE_HOSTED_MAX = 1_024;
/** How long a hosted graph's tie lasts after the tied node's last share. */
export const OWNER_TIE_HOSTED_TTL_MS = 24 * 60 * 60_000;
/** Graphs not hosted yet whose tied node a Core remembers at most. */
export const OWNER_TIE_PENDING_MAX = 256;
/** Ties of graphs not hosted yet one node holds at most; a further one replaces its oldest. */
export const OWNER_TIE_PENDING_PER_SENDER = 8;
/** How long the tie of a graph not hosted yet lasts after the tied node's last share: an envelope's whole freshness window. */
export const OWNER_TIE_PENDING_TTL_MS = GOSSIP_ENVELOPE_FRESHNESS_MS + RELAYED_SHARE_FUTURE_SKEW_MS;

const MINUTE_MS = 60_000;

/** A share envelope whose signer's address is the owner wallet its graph id names; nothing else is checked yet. */
export interface OwnerShareHeader {
  readonly contextGraphId: string;
  /** The owner wallet the graph id names, lower case. */
  readonly owner: string;
  readonly envelope: GossipEnvelopeMsg;
}

/** A share's claim that the node which delivered it is a node of the graph's owner; its signature is not checked yet. */
export interface OwnerPeerClaim {
  readonly contextGraphId: string;
  /** The owner wallet the graph id names, lower case. */
  readonly owner: string;
  /** The node the share names as its publisher, which delivered it. */
  readonly peerId: string;
  /** When the envelope was signed (epoch ms). */
  readonly signedAt: number;
  readonly envelope: GossipEnvelopeMsg;
}

/**
 * The header of `wire` when it is a share envelope whose signer's address is
 * the owner wallet its graph id names, else null. Never throws.
 */
export function readOwnerShareHeader(wire: Uint8Array): OwnerShareHeader | null {
  let envelope: GossipEnvelopeMsg;
  try {
    envelope = decodeGossipEnvelope(wire);
  } catch {
    return null;
  }
  if (envelope.version !== GOSSIP_ENVELOPE_VERSION || envelope.type !== GOSSIP_TYPE_WORKSPACE_PUBLISH || !envelope.payload?.length) {
    return null;
  }
  const owner = rfc64UnregisteredAuthorityOwnerV1(envelope.contextGraphId);
  if (owner === null || envelope.agentAddress?.toLowerCase() !== owner) return null;
  return { contextGraphId: envelope.contextGraphId, owner, envelope };
}

/**
 * The claim the share `header` read, delivered by `fromPeerId`, makes for that
 * node, or null when it makes none: every check but the signature. Never throws.
 */
export function readOwnerPeerClaim(header: OwnerShareHeader, fromPeerId: string, now: number): OwnerPeerClaim | null {
  const { envelope } = header;
  const signedAt = Date.parse(envelope.timestamp);
  if (!(signedAt >= now - GOSSIP_ENVELOPE_FRESHNESS_MS && signedAt <= now + RELAYED_SHARE_FUTURE_SKEW_MS)) return null;
  if (decodedShareEnvelopeKind(envelope) !== 'signed-plain') return null;
  let request: WorkspacePublishRequestMsg;
  try {
    request = decodeWorkspacePublishRequest(envelope.payload);
  } catch {
    return null;
  }
  if (request.contextGraphId !== envelope.contextGraphId || request.publisherPeerId !== fromPeerId) return null;
  return { contextGraphId: header.contextGraphId, owner: header.owner, peerId: fromPeerId, signedAt, envelope };
}

/** Whether the claim's envelope signature recovers to the owner wallet. Never throws. */
export function ownerPeerClaimHolds(claim: OwnerPeerClaim): boolean {
  const { envelope } = claim;
  try {
    const signer = ethers.verifyMessage(
      computeGossipSigningPayload(envelope.type, envelope.contextGraphId, envelope.timestamp, envelope.payload),
      ethers.hexlify(envelope.signature),
    );
    return signer.toLowerCase() === claim.owner;
  } catch {
    return false;
  }
}

/**
 * The signature checks a Core may run, each minute: at most
 * {@link OWNER_TIE_CHECKS_PER_SENDER_PER_MINUTE} per sending node, and at most
 * {@link OWNER_TIE_CHECKS_PER_MINUTE} in all. A node's count is kept for its
 * whole minute: while {@link OWNER_TIE_CHECK_SENDERS_MAX} nodes have counts
 * running, another node is not checked until one of them ends.
 */
export class OwnerTieCheckBudget {
  readonly #now: () => number;
  readonly #perSender: number;
  readonly #perMinute: number;
  readonly #sendersMax: number;
  /** Each sender's minute, oldest start first. */
  readonly #senders = new Map<string, { readonly start: number; count: number }>();
  #all = { start: Number.NEGATIVE_INFINITY, count: 0 };

  constructor(
    limits: { readonly perSender?: number; readonly perMinute?: number; readonly sendersMax?: number } = {},
    now: () => number = Date.now,
  ) {
    this.#perSender = limits.perSender ?? OWNER_TIE_CHECKS_PER_SENDER_PER_MINUTE;
    this.#perMinute = limits.perMinute ?? OWNER_TIE_CHECKS_PER_MINUTE;
    this.#sendersMax = limits.sendersMax ?? OWNER_TIE_CHECK_SENDERS_MAX;
    this.#now = now;
  }

  /** Counts one check for `peerId`; false when its own or the node's limit for the minute is reached. */
  allow(peerId: string): boolean {
    const now = this.#now();
    let window = this.#senders.get(peerId);
    if (window === undefined || now - window.start >= MINUTE_MS) {
      this.#senders.delete(peerId);
      this.#dropEnded(now);
      if (this.#senders.size >= this.#sendersMax) return false;
      window = { start: now, count: 0 };
      this.#senders.set(peerId, window);
    }
    if (window.count >= this.#perSender) return false;
    if (now - this.#all.start >= MINUTE_MS) this.#all = { start: now, count: 0 };
    if (this.#all.count >= this.#perMinute) return false;
    window.count += 1;
    this.#all.count += 1;
    return true;
  }

  #dropEnded(now: number): void {
    for (const [peerId, window] of this.#senders) {
      if (now - window.start < MINUTE_MS) return;
      this.#senders.delete(peerId);
    }
  }
}

/** The node a share signed by the graph's owner tied to the graph. */
export interface OwnerPeerTie {
  readonly owner: string;
  readonly peerId: string;
  /** When the tie was made, or the tied node last renewed it with a share (epoch ms). */
  at: number;
  /** Whether the node was asked for the definition since it went missing. */
  asked: boolean;
}

/**
 * Each graph's tied node, the latest one: up to {@link OWNER_TIE_HOSTED_MAX}
 * hosted graphs for {@link OWNER_TIE_HOSTED_TTL_MS}, and apart from them up to
 * {@link OWNER_TIE_PENDING_MAX} graphs not hosted yet for
 * {@link OWNER_TIE_PENDING_TTL_MS}, {@link OWNER_TIE_PENDING_PER_SENDER} per
 * node. A pending tie moves to the hosted ones once its graph is hosted.
 */
export class OwnerPeerTies {
  readonly #now: () => number;
  readonly #hosted = new Map<string, OwnerPeerTie>();
  readonly #pending = new Map<string, OwnerPeerTie>();

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The graph's tie; a pending one moves to the hosted ties when `hosted`. */
  get(contextGraphId: string, hosted: boolean): OwnerPeerTie | undefined {
    const now = this.#now();
    const tie = this.#live(this.#hosted, contextGraphId, OWNER_TIE_HOSTED_TTL_MS, now);
    if (tie !== undefined) return tie;
    const pending = this.#live(this.#pending, contextGraphId, OWNER_TIE_PENDING_TTL_MS, now);
    if (pending === undefined || !hosted) return pending;
    this.#pending.delete(contextGraphId);
    rememberBounded(this.#hosted, contextGraphId, pending, OWNER_TIE_HOSTED_MAX);
    return pending;
  }

  /** Whether `peerId` is the graph's tied node; its share renews the tie. */
  renew(contextGraphId: string, peerId: string): boolean {
    const tie = this.get(contextGraphId, false);
    if (tie?.peerId !== peerId) return false;
    tie.at = this.#now();
    return true;
  }

  /** Tie `peerId` to the graph in place of its tied node, among the hosted or the pending ties. */
  record(contextGraphId: string, owner: string, peerId: string, hosted: boolean): OwnerPeerTie {
    const now = this.#now();
    const tie: OwnerPeerTie = { owner, peerId, at: now, asked: false };
    this.#hosted.delete(contextGraphId);
    this.#pending.delete(contextGraphId);
    if (hosted) {
      rememberBounded(this.#hosted, contextGraphId, tie, OWNER_TIE_HOSTED_MAX);
      return tie;
    }
    const own: string[] = [];
    for (const [graphId, pending] of this.#pending) {
      if (now - pending.at >= OWNER_TIE_PENDING_TTL_MS) this.#pending.delete(graphId);
      else if (pending.peerId === peerId) own.push(graphId);
    }
    if (own.length >= OWNER_TIE_PENDING_PER_SENDER) this.#pending.delete(own[0]!);
    rememberBounded(this.#pending, contextGraphId, tie, OWNER_TIE_PENDING_MAX);
    return tie;
  }

  /** Ties held, hosted and pending; for tests. */
  get sizes(): { readonly hosted: number; readonly pending: number } {
    return { hosted: this.#hosted.size, pending: this.#pending.size };
  }

  #live(memory: Map<string, OwnerPeerTie>, contextGraphId: string, ttlMs: number, now: number): OwnerPeerTie | undefined {
    const tie = memory.get(contextGraphId);
    if (tie === undefined || now - tie.at < ttlMs) return tie;
    memory.delete(contextGraphId);
    return undefined;
  }
}
