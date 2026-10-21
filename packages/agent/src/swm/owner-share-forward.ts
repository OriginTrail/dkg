// SPDX-License-Identifier: Apache-2.0

/**
 * A Core passes a member's signed share of a public graph on to the graph's
 * owner, and the owner takes it as if the member had sent it.
 *
 * The owner of a public graph must hold a member's share with the member's
 * author seal to publish the member's asset to Verified Memory, and a copy it
 * pulls from a Core carries no seal. A member that reaches the graph only
 * through Cores sends its share to the owner itself only once it can map the
 * owner's wallet to a peer (`relay-only-share-routes.ts`, route 2), which may
 * take long or never happen on a loaded network. The Cores the share reaches
 * are connected to the owner, so:
 *
 * - Core side ({@link shouldForwardShareToOwner}, {@link OwnerShareForwarder}):
 *   right after a Core applies a member's share into a named sub-graph of a
 *   public graph without an allowlist that it hosts or subscribes to, it sends
 *   the share's original envelope bytes, unchanged, to the owner's peers it is
 *   connected to: first hop only (the share came from its publisher), at most
 *   {@link OWNER_FORWARD_MAX_PEERS} peers, one attempt each with no outbox,
 *   each (graph, operation, peer) once, and nothing after `stop()`.
 * - Owner side ({@link checkRelayedShare}): the owner takes such a share only
 *   from an admitted Core, only as the graph's curator of a public graph
 *   without an allowlist, and only when the envelope is the asset author's own
 *   signature over a plain share into a named sub-graph that is at most
 *   `GOSSIP_ENVELOPE_FRESHNESS_MS` old. It then applies it on the share
 *   handler's replay path, which keeps the author seal as for a direct send.
 *   Each Core the share reaches passes it on, so the owner runs the handler
 *   once for the same bytes ({@link RelayedShareApplies}): a copy that
 *   arrives while one is applied waits for it, and one after it is answered
 *   as applied without a store write.
 *
 * Nothing here retries: a forward that is lost leaves the member's own route
 * to the owner, as before.
 */

import {
  computeGossipSigningPayload,
  createGraphKnowledgeAssetScope,
  decodeEncryptedWorkspacePayload,
  decodeGossipEnvelope,
  decodeSwmSenderKeyMessage,
  decodeWorkspacePublishRequest,
  ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
  GOSSIP_ENVELOPE_FRESHNESS_MS,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  knowledgeAssetAgentAddressesEqual,
  resolveWithinAbort,
  SWM_SENDER_KEY_MESSAGE_TYPE,
  type GossipEnvelopeMsg,
  type WorkspacePublishRequestMsg,
} from '@origintrail-official/dkg-core';
import { createHash } from 'node:crypto';
import { ethers } from 'ethers';
import { rememberBounded } from '../bounded-map.js';
import { GraphOwnerPeers } from './relay-only-share-routes.js';

/** Owner peers one share is passed on to. */
export const OWNER_FORWARD_MAX_PEERS = 2;
/** Deadline of one send to an owner peer. */
export const OWNER_FORWARD_TIMEOUT_MS = 10_000;
/** Deadline of the owner lookup; it reads the local store only. */
export const OWNER_FORWARD_LOOKUP_TIMEOUT_MS = 5_000;
/** How long a (graph, operation, peer) that was sent is not sent again. */
export const OWNER_FORWARD_DEDUPE_TTL_MS = 30 * 60_000;
/** Sent (graph, operation, peer) entries remembered at most. */
export const OWNER_FORWARD_DEDUPE_MAX = 4_096;
/** Sends in flight at once; a forward beyond it is dropped. */
export const OWNER_FORWARD_MAX_IN_FLIGHT = 8;
/** How far ahead of the owner's clock a relayed envelope may be signed. */
export const RELAYED_SHARE_FUTURE_SKEW_MS = 30_000;
/** Relayed shares one Core may send the owner per minute. */
export const RELAYED_SHARE_RATE_PER_MINUTE = 120;
/** Senders whose rate is tracked at once. */
const RELAYED_SHARE_RATE_SENDERS_MAX = 256;
/**
 * How long the owner answers another copy of a relayed share it applied
 * without applying it again: the whole window in which the copy's envelope
 * passes {@link checkRelayedShare}, so a copy past it is refused as stale.
 */
export const RELAYED_SHARE_APPLIED_TTL_MS = GOSSIP_ENVELOPE_FRESHNESS_MS + RELAYED_SHARE_FUTURE_SKEW_MS;
/** Applied relayed shares remembered at most. */
export const RELAYED_SHARE_APPLIED_MAX = 4_096;

/** What a share's envelope carries, as far as a forward cares. */
export type ShareEnvelopeKind = 'signed-plain' | 'sender-key' | 'encrypted' | 'unsigned' | 'other';

interface DecodedShareEnvelope {
  readonly kind: ShareEnvelopeKind;
  readonly envelope?: GossipEnvelopeMsg;
}

function decodeShareEnvelope(bytes: Uint8Array): DecodedShareEnvelope {
  let envelope: GossipEnvelopeMsg;
  try {
    envelope = decodeGossipEnvelope(bytes);
  } catch {
    return { kind: 'other' };
  }
  return { kind: decodedShareEnvelopeKind(envelope), envelope };
}

/** The kind of a decoded share envelope: `other` for another version or type, or an empty payload. */
export function decodedShareEnvelopeKind(envelope: GossipEnvelopeMsg): ShareEnvelopeKind {
  if (envelope.version !== GOSSIP_ENVELOPE_VERSION || envelope.type !== GOSSIP_TYPE_WORKSPACE_PUBLISH || !envelope.payload?.length) {
    return 'other';
  }
  if (isEncryptedPayload(envelope.payload)) return 'encrypted';
  if (isSenderKeyPayload(envelope.payload)) return 'sender-key';
  if (!envelope.signature?.length || !envelope.agentAddress || !ethers.isAddress(envelope.agentAddress)) return 'unsigned';
  return 'signed-plain';
}

function isEncryptedPayload(payload: Uint8Array): boolean {
  try {
    return decodeEncryptedWorkspacePayload(payload).type === ENCRYPTED_WORKSPACE_ENVELOPE_TYPE;
  } catch {
    return false;
  }
}

function isSenderKeyPayload(payload: Uint8Array): boolean {
  try {
    return decodeSwmSenderKeyMessage(payload).type === SWM_SENDER_KEY_MESSAGE_TYPE;
  } catch {
    return false;
  }
}

/** The kind of a share's wire bytes: only a signed plain share is passed on. */
export function shareEnvelopeKind(bytes: Uint8Array): ShareEnvelopeKind {
  return decodeShareEnvelope(bytes).kind;
}

/** Whether a graph's metadata lists a peer or agent allowlist. */
export function graphHasAllowlist(meta: { readonly allowedPeers: readonly string[]; readonly allowedAgents: readonly string[] }): boolean {
  return meta.allowedPeers.length > 0 || meta.allowedAgents.length > 0;
}

/** The facts of one applied share that decide a forward, all known without a store read. */
export interface OwnerForwardFacts {
  readonly nodeRole: 'core' | 'edge' | undefined;
  /** The Core hosts the public graph (it signed a StorageACK for it). */
  readonly hosted: boolean;
  /** The node subscribes to the graph. */
  readonly subscribed: boolean;
  readonly subGraphName: string | null | undefined;
  readonly shareOperationId: string | undefined;
  readonly publisherPeerId: string | undefined;
  readonly fromPeerId: string;
  readonly wire: Uint8Array;
}

/** The checks of a forward that read the node's state, asked last and in this order. */
export interface OwnerForwardChecks {
  ownerIsLocal(): boolean;
  /** The graph is public and lists no allowlist. */
  publicWithoutAllowlist(): Promise<boolean>;
}

/**
 * Whether a share this node just applied goes on to the graph's owner: on a
 * Core, for a graph it hosts or subscribes to, into a named sub-graph, sent by
 * its publisher (the first hop), a signed plain share, the owner on another
 * node, the graph public without an allowlist.
 */
export async function shouldForwardShareToOwner(facts: OwnerForwardFacts, checks: OwnerForwardChecks): Promise<boolean> {
  if (facts.nodeRole !== 'core') return false;
  if (!facts.hosted && !facts.subscribed) return false;
  if (!facts.subGraphName || !facts.shareOperationId) return false;
  if (facts.publisherPeerId === undefined || facts.publisherPeerId !== facts.fromPeerId) return false;
  if (shareEnvelopeKind(facts.wire) !== 'signed-plain') return false;
  if (checks.ownerIsLocal()) return false;
  return checks.publicWithoutAllowlist();
}

/** One share to pass on. */
export interface OwnerShareToForward {
  readonly contextGraphId: string;
  readonly shareOperationId: string;
  /** The peer the share came from; never sent back to. */
  readonly fromPeerId: string;
  /** The share's envelope bytes as received. */
  readonly wire: Uint8Array;
}

/** The owner peer's answer to one forward. */
export type OwnerForwardAnswer = 'applied' | 'refused';

/** What the forwarder uses of the agent. */
export interface OwnerShareForwardPorts {
  /** The owner's peers this node can name, connected or not; bounded by `signal`. */
  ownerPeers(contextGraphId: string, signal: AbortSignal): Promise<readonly string[]>;
  isConnected(peerId: string): boolean;
  selfPeerId(): string;
  /** One send; rejects on a transport failure, and when `signal` aborts. */
  send(peerId: string, wire: Uint8Array, options: { readonly signal: AbortSignal; readonly timeoutMs: number }): Promise<OwnerForwardAnswer>;
  logDebug(message: string): void;
}

export interface OwnerShareForwarderOptions {
  readonly now?: () => number;
  readonly maxPeers?: number;
  readonly maxInFlight?: number;
  readonly timeoutMs?: number;
  readonly lookupTimeoutMs?: number;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One Core's forwards of members' shares to graph owners. The owner's peers
 * are looked up from the local store within {@link OWNER_FORWARD_LOOKUP_TIMEOUT_MS}
 * and kept per graph (found ones for five minutes, none for a minute), and only
 * peers that are connected at the time of the send get the share. Never throws.
 */
export class OwnerShareForwarder {
  readonly #ports: OwnerShareForwardPorts;
  readonly #now: () => number;
  readonly #maxPeers: number;
  readonly #maxInFlight: number;
  readonly #timeoutMs: number;
  readonly #lookupTimeoutMs: number;
  readonly #owners: GraphOwnerPeers;
  readonly #abort = new AbortController();
  /** (graph, operation, peer) that got the share, with when. */
  readonly #sent = new Map<string, number>();
  /** Answers of `applied` per (graph, operation); for diagnostics and tests. */
  readonly #applied = new Map<string, number>();
  readonly #inFlight = new Set<string>();
  readonly #tasks = new Set<Promise<void>>();
  #stopped = false;

  constructor(ports: OwnerShareForwardPorts, options: OwnerShareForwarderOptions = {}) {
    this.#ports = ports;
    this.#now = options.now ?? Date.now;
    this.#maxPeers = options.maxPeers ?? OWNER_FORWARD_MAX_PEERS;
    this.#maxInFlight = options.maxInFlight ?? OWNER_FORWARD_MAX_IN_FLIGHT;
    this.#timeoutMs = options.timeoutMs ?? OWNER_FORWARD_TIMEOUT_MS;
    this.#lookupTimeoutMs = options.lookupTimeoutMs ?? OWNER_FORWARD_LOOKUP_TIMEOUT_MS;
    this.#owners = new GraphOwnerPeers((contextGraphId) => this.#lookUp(contextGraphId), this.#now);
  }

  /** Pass `share` on to the owner's connected peers, in the background. */
  forward(share: OwnerShareToForward): void {
    if (this.#stopped) return;
    const task = this.#run(share).catch((error: unknown) => {
      this.#ports.logDebug(`Share op=${share.shareOperationId} of "${share.contextGraphId}" not passed on to its owner: ${errorText(error)}`);
    });
    this.#tasks.add(task);
    void task.finally(() => this.#tasks.delete(task));
  }

  /** Owner peers that answered `applied` for the share. */
  appliedCount(contextGraphId: string, shareOperationId: string): number {
    return this.#applied.get(`${contextGraphId}\0${shareOperationId}`) ?? 0;
  }

  /** Sends in flight now. */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** No forward from now on; sends in flight are aborted. */
  stop(): void {
    this.#stopped = true;
    this.#abort.abort();
  }

  /** Resolves once the forwards started so far have ended; for tests. */
  async settled(): Promise<void> {
    while (this.#tasks.size > 0) await Promise.allSettled(this.#tasks);
  }

  async #lookUp(contextGraphId: string): Promise<readonly string[]> {
    const deadline = AbortSignal.timeout(this.#lookupTimeoutMs);
    const peerIds = await resolveWithinAbort((signal) => this.#ports.ownerPeers(contextGraphId, signal ?? deadline), deadline) ?? [];
    // Peers named but not connected are kept as "none found": the owner may
    // connect within the minute an empty answer is kept, a stale peer never.
    return peerIds.filter((peerId) => this.#ports.isConnected(peerId));
  }

  async #run(share: OwnerShareToForward): Promise<void> {
    const owners = await this.#owners.of(share.contextGraphId);
    if (this.#stopped) return;
    const self = this.#ports.selfPeerId();
    const targets = [...new Set(owners)]
      .filter((peerId) => peerId !== self && peerId !== share.fromPeerId && this.#ports.isConnected(peerId))
      .slice(0, this.#maxPeers);
    if (targets.length === 0) {
      this.#ports.logDebug(`Share op=${share.shareOperationId} of "${share.contextGraphId}": no connected owner peer to pass it on to`);
      return;
    }
    await Promise.all(targets.map((peerId) => this.#sendOnce(share, peerId)));
  }

  async #sendOnce(share: OwnerShareToForward, peerId: string): Promise<void> {
    const key = `${share.contextGraphId}\0${share.shareOperationId}\0${peerId}`;
    if (this.#stopped || this.#recentlySent(key) || this.#inFlight.has(key)) return;
    if (this.#inFlight.size >= this.#maxInFlight) {
      this.#ports.logDebug(`Share op=${share.shareOperationId} of "${share.contextGraphId}" not passed on to ${peerId.slice(-8)}: ${this.#inFlight.size} sends in flight`);
      return;
    }
    this.#inFlight.add(key);
    try {
      const answer = await this.#ports.send(peerId, share.wire, { signal: this.#abort.signal, timeoutMs: this.#timeoutMs });
      rememberBounded(this.#sent, key, this.#now(), OWNER_FORWARD_DEDUPE_MAX);
      if (answer === 'applied') {
        const shareKey = `${share.contextGraphId}\0${share.shareOperationId}`;
        rememberBounded(this.#applied, shareKey, (this.#applied.get(shareKey) ?? 0) + 1, OWNER_FORWARD_DEDUPE_MAX);
      }
      this.#ports.logDebug(`Share op=${share.shareOperationId} of "${share.contextGraphId}" passed on to owner peer ${peerId.slice(-8)}: ${answer}`);
    } catch (error) {
      // Not remembered and not sent again: an owner without the protocol, or
      // one that is gone, refuses the next share too.
      this.#ports.logDebug(`Share op=${share.shareOperationId} of "${share.contextGraphId}" not passed on to owner peer ${peerId.slice(-8)}: ${errorText(error)}`);
    } finally {
      this.#inFlight.delete(key);
    }
  }

  #recentlySent(key: string): boolean {
    const at = this.#sent.get(key);
    if (at === undefined) return false;
    if (this.#now() - at < OWNER_FORWARD_DEDUPE_TTL_MS) return true;
    this.#sent.delete(key);
    return false;
  }
}

/** The owner's verdict on a relayed share's bytes alone. */
export type RelayedShareCheck =
  | {
    readonly ok: true;
    readonly contextGraphId: string;
    readonly subGraphName: string;
    readonly shareOperationId: string;
    readonly author: string;
  }
  | { readonly ok: false; readonly reason: string };

function refused(reason: string): RelayedShareCheck {
  return { ok: false, reason };
}

/**
 * What the owner checks of a relayed share before its state is read: a signed
 * share envelope at most `GOSSIP_ENVELOPE_FRESHNESS_MS` old (and at most
 * {@link RELAYED_SHARE_FUTURE_SKEW_MS} ahead), a plain payload, not sender-key
 * or encrypted, into a named sub-graph of the envelope's graph, whose asset
 * author is the envelope's signer and whose signature holds.
 */
export function checkRelayedShare(bytes: Uint8Array, now: number): RelayedShareCheck {
  const { kind, envelope } = decodeShareEnvelope(bytes);
  if (kind !== 'signed-plain' || envelope === undefined) return refused(`not a signed plain share (${kind})`);
  const signedAt = Date.parse(envelope.timestamp);
  if (!Number.isFinite(signedAt)) return refused('envelope has no valid timestamp');
  if (now - signedAt > GOSSIP_ENVELOPE_FRESHNESS_MS || signedAt - now > RELAYED_SHARE_FUTURE_SKEW_MS) {
    return refused(`envelope signed at ${envelope.timestamp} is outside the freshness window`);
  }
  let request: WorkspacePublishRequestMsg;
  try {
    request = decodeWorkspacePublishRequest(envelope.payload);
  } catch {
    return refused('payload is not a share request');
  }
  if (request.contextGraphId !== envelope.contextGraphId) return refused('payload names another graph than its envelope');
  if (!request.subGraphName) return refused('share into the root scope');
  let author: string;
  try {
    author = createGraphKnowledgeAssetScope(request.kaUal ?? '', request.assertionVersion ?? '').agentAddress;
  } catch {
    return refused('share names no asset scope');
  }
  if (request.agentAddress && !knowledgeAssetAgentAddressesEqual(request.agentAddress, author)) {
    return refused('share names two authors');
  }
  if (!knowledgeAssetAgentAddressesEqual(author, envelope.agentAddress)) return refused('envelope signer is not the asset author');
  try {
    const signer = ethers.verifyMessage(
      computeGossipSigningPayload(envelope.type, envelope.contextGraphId, envelope.timestamp, envelope.payload),
      ethers.hexlify(envelope.signature),
    );
    if (!knowledgeAssetAgentAddressesEqual(signer, envelope.agentAddress)) return refused('envelope signature is not the signer\'s');
  } catch {
    return refused('envelope signature does not verify');
  }
  return {
    ok: true,
    contextGraphId: envelope.contextGraphId,
    subGraphName: request.subGraphName,
    shareOperationId: request.shareOperationId,
    author,
  };
}

/** What names one relayed share for {@link RelayedShareApplies}: its graph, its operation and its exact bytes. */
export function relayedShareKey(contextGraphId: string, shareOperationId: string, wire: Uint8Array): string {
  return `${contextGraphId}\0${shareOperationId}\0${createHash('sha256').update(wire).digest('hex')}`;
}

/** How the owner took one copy of a relayed share. */
export type RelayedShareApply = 'applied' | 'applied-before' | 'refused';

export interface RelayedShareAppliesOptions {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

/**
 * The relayed shares the owner applied, by {@link relayedShareKey}, and the
 * applies in flight. Every Core a member's share reaches passes the same
 * bytes on, so without it each copy would run the share handler again, with
 * its store writes and change event.
 */
export class RelayedShareApplies {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  /** Key of an applied share, with when. */
  readonly #applied = new Map<string, number>();
  readonly #inFlight = new Map<string, Promise<boolean>>();

  constructor(options: RelayedShareAppliesOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? RELAYED_SHARE_APPLIED_TTL_MS;
    this.#maxEntries = options.maxEntries ?? RELAYED_SHARE_APPLIED_MAX;
  }

  /**
   * Run `apply` (true when the share was applied) unless the share was
   * applied within the TTL; a copy that comes while an apply is in flight
   * gets that apply's result, or its error. Only an apply that succeeded is
   * remembered, so a copy after a refusal or an error is applied in full.
   */
  async once(key: string, apply: () => Promise<boolean>): Promise<RelayedShareApply> {
    if (this.#appliedRecently(key)) return 'applied-before';
    const pending = this.#inFlight.get(key);
    if (pending !== undefined) return (await pending) ? 'applied-before' : 'refused';
    const run = (async () => {
      try {
        const applied = await apply();
        if (applied) rememberBounded(this.#applied, key, this.#now(), this.#maxEntries);
        return applied;
      } finally {
        this.#inFlight.delete(key);
      }
    })();
    this.#inFlight.set(key, run);
    return (await run) ? 'applied' : 'refused';
  }

  #appliedRecently(key: string): boolean {
    const at = this.#applied.get(key);
    if (at === undefined) return false;
    if (this.#now() - at < this.#ttlMs) return true;
    this.#applied.delete(key);
    return false;
  }
}

/** Relayed shares per sender per minute, bounded in senders. */
export class RelayedShareRateLimit {
  readonly #now: () => number;
  readonly #perMinute: number;
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(perMinute = RELAYED_SHARE_RATE_PER_MINUTE, now: () => number = Date.now) {
    this.#perMinute = perMinute;
    this.#now = now;
  }

  /** Counts one share from `peerId`; false when it passes the minute's limit. */
  allow(peerId: string): boolean {
    const now = this.#now();
    const window = this.#windows.get(peerId);
    if (window === undefined || now - window.start >= 60_000) {
      rememberBounded(this.#windows, peerId, { start: now, count: 1 }, RELAYED_SHARE_RATE_SENDERS_MAX);
      return true;
    }
    if (window.count >= this.#perMinute) return false;
    window.count += 1;
    return true;
  }
}
