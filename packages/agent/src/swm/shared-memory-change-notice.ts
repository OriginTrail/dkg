// SPDX-License-Identifier: Apache-2.0

/**
 * A notice that a public context graph's shared memory changed on the sender.
 *
 * Members of a public graph that reach each other only through its owner
 * (Edges behind relays) never send each other a share: each member sends its
 * shares to the owner (#3208), and no node passes a share on. Another member
 * got such a share only at its next sync with the owner, minutes later.
 *
 * When the owner applies a share from another peer, it sends each of its
 * followers except the share's author this notice. The notice names the
 * graph, the scope (the root or a named sub-graph) and a hint for logs; it
 * carries no data. A follower that accepts it pulls that scope from the
 * sender at once, through the sync it already runs: the same authorization,
 * the same verification and the same storage path as a periodic pull. The
 * rules for receiving share data do not change.
 *
 * A node that does not know the protocol refuses the stream; the owner sends
 * once, without retries, and goes on. Nothing waits for the notice.
 */

import { validateContextGraphId, validateSubGraphName } from '@origintrail-official/dkg-core';

export const SWM_CHANGE_NOTICE_KIND_V1 = 'dkg-swm-change-notice-v1';
/** Upper bound of an encoded notice; a valid one is well below it. */
export const SWM_CHANGE_NOTICE_MAX_BYTES = 2_048;
const HINT_PATTERN = /^[\x21-\x7e]{1,256}$/;

export interface SwmChangeNoticeV1 {
  readonly contextGraphId: string;
  /** The named sub-graph that changed; null for the graph's root. */
  readonly subGraphName: string | null;
  /** What changed, for logs only: the share's operation id or the catalog head. */
  readonly hint: string;
}

const UTF8 = new TextEncoder();
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

function invalid(reason: string): never {
  throw new Error(`Invalid shared-memory change notice: ${reason}`);
}

function checkedNotice(value: SwmChangeNoticeV1): SwmChangeNoticeV1 {
  const graph = validateContextGraphId(value.contextGraphId);
  if (!graph.valid) invalid(graph.reason ?? 'context graph id');
  if (value.subGraphName !== null) {
    const subGraph = validateSubGraphName(value.subGraphName);
    if (!subGraph.valid) invalid(subGraph.reason ?? 'sub-graph name');
  }
  if (typeof value.hint !== 'string' || !HINT_PATTERN.test(value.hint)) invalid('hint');
  return { contextGraphId: value.contextGraphId, subGraphName: value.subGraphName, hint: value.hint };
}

/** Canonical bytes: one JSON object with its keys in a fixed order. */
export function encodeSwmChangeNoticeV1(notice: SwmChangeNoticeV1): Uint8Array {
  const { contextGraphId, subGraphName, hint } = checkedNotice(notice);
  const bytes = UTF8.encode(JSON.stringify({ contextGraphId, hint, kind: SWM_CHANGE_NOTICE_KIND_V1, subGraphName }));
  if (bytes.byteLength > SWM_CHANGE_NOTICE_MAX_BYTES) invalid('too large');
  return bytes;
}

/** The notice in `bytes`; throws unless they are exactly a canonical notice. */
export function decodeSwmChangeNoticeV1(bytes: Uint8Array): SwmChangeNoticeV1 {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > SWM_CHANGE_NOTICE_MAX_BYTES) {
    invalid('empty or too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_FATAL.decode(bytes));
  } catch {
    invalid('not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) invalid('not an object');
  const record = parsed as Record<string, unknown>;
  if (record['kind'] !== SWM_CHANGE_NOTICE_KIND_V1) invalid('kind');
  const { contextGraphId, subGraphName, hint } = record;
  if (typeof contextGraphId !== 'string' || typeof hint !== 'string') invalid('fields');
  if (subGraphName !== null && typeof subGraphName !== 'string') invalid('sub-graph name');
  const notice = checkedNotice({ contextGraphId, subGraphName, hint });
  const canonical = encodeSwmChangeNoticeV1(notice);
  if (canonical.byteLength !== bytes.byteLength || canonical.some((byte, i) => byte !== bytes[i])) {
    invalid('not canonical');
  }
  return notice;
}

/** A hint a notice can carry: `value` when it fits, a generic one otherwise. */
export function swmChangeNoticeHint(value: string | undefined): string {
  return value !== undefined && HINT_PATTERN.test(value) ? value : 'share';
}

/** One key per graph and scope. */
function scopeKey(contextGraphId: string, subGraphName: string | null): string {
  return `${contextGraphId}\0${subGraphName ?? ''}`;
}

// ── Owner side ────────────────────────────────────────────────────────────

/** What one applied share changed, as the owner saw it. */
export interface SwmRemoteChange<TDetail> {
  readonly contextGraphId: string;
  readonly subGraphName: string | null;
  readonly hint: string;
  /** The peer the change came from; it holds the change and gets no notice of it. */
  readonly sourcePeerId: string;
  /** Changes of one lane coalesce: '' for a scope, the author for a root catalog head. */
  readonly lane: string;
  /** What the delivery needs besides the scope (the catalog head announcement of a root change). */
  readonly detail: TDetail;
}

export interface SwmChangeNotifierPorts<TDetail> {
  /** True when this node owns the graph and the graph is public. */
  readonly ownsPublicGraph: (contextGraphId: string) => Promise<boolean>;
  /** The graph's followers that a direct send reaches (see `shared-memory-followers.ts`). */
  readonly followers: (contextGraphId: string) => Promise<readonly string[]>;
  /** Record a change's source as a follower: a peer whose share this owner applied follows the graph. */
  readonly noteFollower?: (contextGraphId: string, peerId: string) => void;
  /** One attempt per recipient, no retries; resolves with how many it reached. */
  readonly deliver: (change: SwmRemoteChange<TDetail>, recipients: readonly string[]) => Promise<number>;
  readonly selfPeerId: () => string;
  readonly log?: (message: string) => void;
  /** Shortest gap between two deliveries of one lane; changes within it share one trailing delivery. */
  readonly minIntervalMs?: number;
  readonly now?: () => number;
}

export const SWM_CHANGE_NOTICE_MIN_INTERVAL_MS = 1_000;
/** Lanes with a trailing delivery waiting at once; a burst over more drops the excess, periodic sync stays. */
const MAX_WAITING_LANES = 256;

interface WaitingChange<TDetail> {
  change: SwmRemoteChange<TDetail>;
  readonly sources: Set<string>;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class SwmChangeNotifier<TDetail> {
  readonly #ports: SwmChangeNotifierPorts<TDetail>;
  readonly #minIntervalMs: number;
  readonly #now: () => number;
  readonly #lastSentAt = new Map<string, number>();
  readonly #waiting = new Map<string, WaitingChange<TDetail>>();
  readonly #inFlight = new Set<Promise<void>>();

  constructor(ports: SwmChangeNotifierPorts<TDetail>) {
    this.#ports = ports;
    this.#minIntervalMs = ports.minIntervalMs ?? SWM_CHANGE_NOTICE_MIN_INTERVAL_MS;
    this.#now = ports.now ?? Date.now;
  }

  /** Called after a share from another peer was applied here. Never throws and never waits for the delivery. */
  afterRemoteChange(change: SwmRemoteChange<TDetail>): void {
    const key = `${scopeKey(change.contextGraphId, change.subGraphName)}\0${change.lane}`;
    const waiting = this.#waiting.get(key);
    if (waiting !== undefined) {
      waiting.change = change;
      waiting.sources.add(change.sourcePeerId);
      return;
    }
    const sinceLast = this.#now() - (this.#lastSentAt.get(key) ?? Number.NEGATIVE_INFINITY);
    if (sinceLast >= this.#minIntervalMs) {
      this.#start(key, change, new Set([change.sourcePeerId]));
      return;
    }
    if (this.#waiting.size >= MAX_WAITING_LANES) return;
    const timer = setTimeout(() => {
      const due = this.#waiting.get(key);
      this.#waiting.delete(key);
      if (due !== undefined) this.#start(key, due.change, due.sources);
    }, this.#minIntervalMs - sinceLast);
    timer.unref?.();
    this.#waiting.set(key, { change, sources: new Set([change.sourcePeerId]), timer });
  }

  /** Resolves when every delivery started so far has ended; for tests and shutdown. */
  async settled(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled(this.#inFlight);
  }

  /** Drop the trailing deliveries that wait. */
  stop(): void {
    for (const waiting of this.#waiting.values()) clearTimeout(waiting.timer);
    this.#waiting.clear();
  }

  #start(key: string, change: SwmRemoteChange<TDetail>, sources: ReadonlySet<string>): void {
    this.#lastSentAt.delete(key);
    this.#lastSentAt.set(key, this.#now());
    if (this.#lastSentAt.size > 4 * MAX_WAITING_LANES) {
      const oldest = this.#lastSentAt.keys().next().value;
      if (oldest !== undefined) this.#lastSentAt.delete(oldest);
    }
    const run = this.#fanOut(change, sources).catch((error: unknown) => {
      this.#ports.log?.(`SWM change notice for "${change.contextGraphId}" not delivered: ${errorText(error)}`);
    });
    this.#inFlight.add(run);
    void run.finally(() => this.#inFlight.delete(run));
  }

  async #fanOut(change: SwmRemoteChange<TDetail>, sources: ReadonlySet<string>): Promise<void> {
    if (!await this.#ports.ownsPublicGraph(change.contextGraphId)) return;
    for (const source of sources) this.#ports.noteFollower?.(change.contextGraphId, source);
    const self = this.#ports.selfPeerId();
    // A lone source holds the change. With several (changes of several peers
    // shared one delivery), each of them lacks the others' changes.
    const skip = sources.size === 1 ? sources : new Set<string>();
    const recipients = [...new Set(await this.#ports.followers(change.contextGraphId))]
      .filter((peerId) => peerId !== self && !skip.has(peerId));
    if (recipients.length === 0) return;
    const reached = await this.#ports.deliver(change, recipients);
    const scope = change.subGraphName === null ? 'root' : `sub-graph "${change.subGraphName}"`;
    this.#ports.log?.(
      `SWM change notice for "${change.contextGraphId}" ${scope} (${change.hint}): `
        + `reached ${reached} of ${recipients.length} follower(s)`,
    );
  }
}

/** Send one encoded notice to each recipient; how many accepted the stream. */
export async function sendSwmChangeNotice(
  notice: SwmChangeNoticeV1,
  recipients: readonly string[],
  send: (peerId: string, bytes: Uint8Array) => Promise<unknown>,
): Promise<number> {
  const bytes = encodeSwmChangeNoticeV1(notice);
  const results = await Promise.allSettled(recipients.map((peerId) => send(peerId, bytes)));
  return results.filter((result) => result.status === 'fulfilled').length;
}

// ── Follower side ─────────────────────────────────────────────────────────

export interface SwmChangeNoticeReceiverPorts {
  /** True when this node follows the graph's shared memory: subscribed to a public graph. */
  readonly follows: (contextGraphId: string) => boolean | Promise<boolean>;
  /** True when a notice about the graph from this peer is one to pull on. */
  readonly acceptsSender: (contextGraphId: string, peerId: string) => boolean | Promise<boolean>;
  /**
   * Pull the scope from the peer through the existing validated sync.
   * `deferred` when local admission turned the pull away (a busy sync slot):
   * the receiver tries again after a pause.
   */
  readonly pull: (peerId: string, notice: SwmChangeNoticeV1) => Promise<'pulled' | 'deferred'>;
  /** Pauses before the next attempts of a deferred pull; after the last, periodic sync takes over. */
  readonly deferredRetryDelaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (message: string) => void;
  /** Notices accepted from one peer in one window; the rest are dropped. */
  readonly perPeerLimit?: number;
  readonly perPeerWindowMs?: number;
  readonly now?: () => number;
}

export type SwmChangeNoticeDisposition =
  | 'pulling'
  | 'coalesced'
  | 'not-followed'
  | 'sender-not-accepted'
  | 'rate-limited'
  | 'busy'
  | 'invalid';

export const SWM_CHANGE_NOTICE_PER_PEER_LIMIT = 60;
export const SWM_CHANGE_NOTICE_DEFERRED_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000];
export const SWM_CHANGE_NOTICE_PER_PEER_WINDOW_MS = 60_000;
/** Scopes pulled at once; notices for more are dropped and periodic sync covers them. */
const MAX_PULLING_SCOPES = 64;
/** Peers whose recent notices are counted; the longest silent makes room. */
const MAX_COUNTED_PEERS = 1_024;

export class SwmChangeNoticeReceiver {
  readonly #ports: SwmChangeNoticeReceiverPorts;
  readonly #perPeerLimit: number;
  readonly #perPeerWindowMs: number;
  readonly #now: () => number;
  readonly #retryDelaysMs: readonly number[];
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #recent = new Map<string, number[]>();
  /** Scopes with a pull running, each with the latest notice that arrived meanwhile. */
  readonly #pulling = new Map<string, { next: { peerId: string; notice: SwmChangeNoticeV1 } | null }>();
  readonly #runs = new Set<Promise<void>>();

  constructor(ports: SwmChangeNoticeReceiverPorts) {
    this.#ports = ports;
    this.#perPeerLimit = ports.perPeerLimit ?? SWM_CHANGE_NOTICE_PER_PEER_LIMIT;
    this.#perPeerWindowMs = ports.perPeerWindowMs ?? SWM_CHANGE_NOTICE_PER_PEER_WINDOW_MS;
    this.#now = ports.now ?? Date.now;
    this.#retryDelaysMs = ports.deferredRetryDelaysMs ?? SWM_CHANGE_NOTICE_DEFERRED_RETRY_DELAYS_MS;
    this.#sleep = ports.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
  }

  /** Handle one notice from `fromPeerId`. Starts the pull and returns without waiting for it. */
  async handle(bytes: Uint8Array, fromPeerId: string): Promise<SwmChangeNoticeDisposition> {
    let notice: SwmChangeNoticeV1;
    try {
      notice = decodeSwmChangeNoticeV1(bytes);
    } catch {
      return 'invalid';
    }
    if (!this.#admit(fromPeerId)) return 'rate-limited';
    if (!await this.#ports.follows(notice.contextGraphId)) return 'not-followed';
    if (!await this.#ports.acceptsSender(notice.contextGraphId, fromPeerId)) return 'sender-not-accepted';
    const key = scopeKey(notice.contextGraphId, notice.subGraphName);
    const running = this.#pulling.get(key);
    if (running !== undefined) {
      running.next = { peerId: fromPeerId, notice };
      return 'coalesced';
    }
    if (this.#pulling.size >= MAX_PULLING_SCOPES) return 'busy';
    const state: { next: { peerId: string; notice: SwmChangeNoticeV1 } | null } = { next: null };
    this.#pulling.set(key, state);
    const run = this.#pullUntilQuiet(key, state, fromPeerId, notice);
    this.#runs.add(run);
    void run.finally(() => this.#runs.delete(run));
    return 'pulling';
  }

  /** Resolves when every pull started so far has ended; for tests and shutdown. */
  async settled(): Promise<void> {
    while (this.#runs.size > 0) await Promise.allSettled(this.#runs);
  }

  async #pullUntilQuiet(
    key: string,
    state: { next: { peerId: string; notice: SwmChangeNoticeV1 } | null },
    peerId: string,
    notice: SwmChangeNoticeV1,
  ): Promise<void> {
    let current: { peerId: string; notice: SwmChangeNoticeV1 } | null = { peerId, notice };
    let deferrals = 0;
    try {
      while (current !== null) {
        let outcome: 'pulled' | 'deferred' | 'failed' = 'failed';
        try {
          outcome = await this.#ports.pull(current.peerId, current.notice);
        } catch (error) {
          this.#ports.log?.(
            `SWM change notice pull of "${current.notice.contextGraphId}" from ${current.peerId.slice(-8)} failed: ${errorText(error)}`,
          );
        }
        if (outcome === 'deferred' && deferrals < this.#retryDelaysMs.length) {
          // Still in flight while it waits: notices that arrive meanwhile join it, and the latest one is pulled.
          await this.#sleep(this.#retryDelaysMs[deferrals]!);
          deferrals += 1;
          current = state.next ?? current;
          state.next = null;
          continue;
        }
        deferrals = 0;
        current = state.next;
        state.next = null;
      }
    } finally {
      this.#pulling.delete(key);
    }
  }

  #admit(peerId: string): boolean {
    const now = this.#now();
    const recent = (this.#recent.get(peerId) ?? []).filter((at) => now - at < this.#perPeerWindowMs);
    this.#recent.delete(peerId);
    if (recent.length >= this.#perPeerLimit) {
      this.#recent.set(peerId, recent);
      return false;
    }
    recent.push(now);
    this.#recent.set(peerId, recent);
    if (this.#recent.size > MAX_COUNTED_PEERS) {
      const oldest = this.#recent.keys().next().value;
      if (oldest !== undefined) this.#recent.delete(oldest);
    }
    return true;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
