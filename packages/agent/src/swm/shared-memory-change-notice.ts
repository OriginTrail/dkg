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
 * carries no data. A follower that accepts it pulls the graph's shared memory
 * from the sender at once, through the sync it already runs: the same
 * authorization, the same verification and the same storage path as a
 * periodic pull. The rules for receiving share data do not change.
 *
 * That pull is of the whole graph, so the follower keeps one pull per graph
 * and sender: the scope a notice names is for logs only. A notice that
 * arrives while that pull runs is answered by one more pull after it, since
 * the running one may have read the sender's metadata before the change.
 *
 * A node that does not know the protocol refuses the stream; the owner sends
 * once, without retries, and goes on. Nothing waits for the notice.
 *
 * A root share of a catalog-owned graph does not use this notice: it reaches
 * the owner as its author's catalog head, and the owner passes the head's
 * announcement on through the catalog's own delivery. The followers it tells
 * are found the same way ({@link swmChangeRecipients}).
 *
 * Members that reach the graph only through Cores (relay-only Edges with no
 * route to the owner) send their shares to those Cores. A Core that hosts the
 * graph applies a share into a named sub-graph and sends the same notice to
 * the graph's owner when it is connected to it, so that the owner pulls the
 * share from the Core (`core-hosted-graph.ts`). The owner accepts it under the
 * same rule as any notice.
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
  /** What changed, for logs only: the share's operation id. */
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

// ── Owner side ────────────────────────────────────────────────────────────

/** What the owner needs to find whom to tell of a change. */
export interface SwmChangeRecipientPorts {
  /** True when this node owns the graph and the graph is public. */
  readonly ownsPublicGraph: (contextGraphId: string) => Promise<boolean>;
  /** The graph's followers that a direct send reaches (see `shared-memory-followers.ts`). */
  readonly followers: (contextGraphId: string) => Promise<readonly string[]>;
  /** Record a change's source as a follower: a peer whose share this owner applied follows the graph. */
  readonly noteFollower?: (contextGraphId: string, peerId: string) => void;
  readonly selfPeerId: () => string;
}

/**
 * The followers to tell of the changes `sources` made to a graph, when this
 * node owns the graph and it is public; nobody otherwise. The sources are
 * recorded as followers of the graph. A lone source holds its change and is
 * left out; with several (the changes of several peers told at once), each
 * lacks the others' changes.
 */
export async function swmChangeRecipients(
  ports: SwmChangeRecipientPorts,
  contextGraphId: string,
  sources: ReadonlySet<string>,
): Promise<string[]> {
  if (!await ports.ownsPublicGraph(contextGraphId)) return [];
  for (const source of sources) ports.noteFollower?.(contextGraphId, source);
  const self = ports.selfPeerId();
  const skip = sources.size === 1 ? sources : new Set<string>();
  return [...new Set(await ports.followers(contextGraphId))]
    .filter((peerId) => peerId !== self && !skip.has(peerId));
}

/** One share from another peer, as the owner applied it. */
export interface SwmRemoteChange {
  readonly contextGraphId: string;
  readonly subGraphName: string | null;
  readonly hint: string;
  /** The peer the share came from; it holds the change and gets no notice of it. */
  readonly sourcePeerId: string;
}

export interface SwmChangeNotifierPorts extends SwmChangeRecipientPorts {
  /** One attempt per recipient, no retries; resolves with how many it reached. */
  readonly deliver: (notice: SwmChangeNoticeV1, recipients: readonly string[]) => Promise<number>;
  /**
   * On a Core that hosts the public graph: the peers of the graph's owner it is
   * connected to, told of a change into a named sub-graph. Empty elsewhere.
   */
  readonly hostedGraphOwnerPeers?: (contextGraphId: string) => Promise<readonly string[]>;
  readonly log?: (message: string) => void;
  /** Shortest gap between two notices of one scope; changes within it share one trailing notice. */
  readonly minIntervalMs?: number;
  readonly now?: () => number;
}

export const SWM_CHANGE_NOTICE_MIN_INTERVAL_MS = 1_000;
/** Scopes with a trailing notice waiting at once; a burst over more drops the excess, periodic sync stays. */
const MAX_WAITING_SCOPES = 256;

interface WaitingChange {
  change: SwmRemoteChange;
  readonly sources: Set<string>;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** One key per graph and scope. */
function scopeKey(contextGraphId: string, subGraphName: string | null): string {
  return `${contextGraphId}\0${subGraphName ?? ''}`;
}

export class SwmChangeNotifier {
  readonly #ports: SwmChangeNotifierPorts;
  readonly #minIntervalMs: number;
  readonly #now: () => number;
  readonly #lastSentAt = new Map<string, number>();
  readonly #waiting = new Map<string, WaitingChange>();
  readonly #inFlight = new Set<Promise<void>>();
  #stopped = false;

  constructor(ports: SwmChangeNotifierPorts) {
    this.#ports = ports;
    this.#minIntervalMs = ports.minIntervalMs ?? SWM_CHANGE_NOTICE_MIN_INTERVAL_MS;
    this.#now = ports.now ?? Date.now;
  }

  /** Called after a share from another peer was applied here. Never throws and never waits for the delivery. */
  afterRemoteChange(change: SwmRemoteChange): void {
    if (this.#stopped) return;
    const key = scopeKey(change.contextGraphId, change.subGraphName);
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
    if (this.#waiting.size >= MAX_WAITING_SCOPES) return;
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

  /** Shutdown: drop the trailing notices that wait and send no more. */
  stop(): void {
    this.#stopped = true;
    for (const waiting of this.#waiting.values()) clearTimeout(waiting.timer);
    this.#waiting.clear();
  }

  #start(key: string, change: SwmRemoteChange, sources: ReadonlySet<string>): void {
    this.#lastSentAt.delete(key);
    this.#lastSentAt.set(key, this.#now());
    if (this.#lastSentAt.size > 4 * MAX_WAITING_SCOPES) {
      const oldest = this.#lastSentAt.keys().next().value;
      if (oldest !== undefined) this.#lastSentAt.delete(oldest);
    }
    const run = this.#fanOut(change, sources).catch((error: unknown) => {
      this.#ports.log?.(`SWM change notice for "${change.contextGraphId}" not delivered: ${errorText(error)}`);
    });
    this.#inFlight.add(run);
    void run.finally(() => this.#inFlight.delete(run));
  }

  async #fanOut(change: SwmRemoteChange, sources: ReadonlySet<string>): Promise<void> {
    const { contextGraphId, subGraphName, hint } = change;
    let recipients = await swmChangeRecipients(this.#ports, contextGraphId, sources);
    let told = 'follower(s)';
    if (recipients.length === 0 && subGraphName !== null && this.#ports.hostedGraphOwnerPeers !== undefined) {
      // A Core that hosts the graph: its owner, unless the change is the owner's own.
      const self = this.#ports.selfPeerId();
      recipients = (await this.#ports.hostedGraphOwnerPeers(contextGraphId))
        .filter((peerId) => peerId !== self && !sources.has(peerId));
      told = 'owner peer(s)';
    }
    if (recipients.length === 0) return;
    const reached = await this.#ports.deliver({ contextGraphId, subGraphName, hint }, recipients);
    const scope = subGraphName === null ? 'root' : `sub-graph "${subGraphName}"`;
    this.#ports.log?.(
      `SWM change notice for "${contextGraphId}" ${scope} (${hint}): reached ${reached} of ${recipients.length} ${told}`,
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
   * Pull the graph's shared memory from the peer through the existing
   * validated sync, against the peer's state at the call: a sync of the graph
   * from the peer that was already running may have read the peer before the
   * change, so the pull must not join it. `deferred` when local admission
   * turned the pull away (a busy sync slot): the receiver tries again after a
   * pause.
   */
  readonly pull: (peerId: string, contextGraphId: string) => Promise<'pulled' | 'deferred'>;
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
  | 'invalid'
  | 'stopped';

export const SWM_CHANGE_NOTICE_PER_PEER_LIMIT = 60;
export const SWM_CHANGE_NOTICE_DEFERRED_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000];
export const SWM_CHANGE_NOTICE_PER_PEER_WINDOW_MS = 60_000;
/** Graphs (each from one sender) pulled at once; notices for more are dropped and periodic sync covers them. */
const MAX_PULLS = 64;
/** Peers whose recent notices are counted; the longest silent makes room. */
const MAX_COUNTED_PEERS = 1_024;

/** One graph's pull from one sender. */
interface GraphPull {
  /** The latest notice that arrived while the pull ran or waited: one more pull follows it. */
  trailing: SwmChangeNoticeV1 | null;
}

export class SwmChangeNoticeReceiver {
  readonly #ports: SwmChangeNoticeReceiverPorts;
  readonly #perPeerLimit: number;
  readonly #perPeerWindowMs: number;
  readonly #now: () => number;
  readonly #retryDelaysMs: readonly number[];
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #recent = new Map<string, number[]>();
  /** Graph and sender of each pull that runs or waits for a retry. */
  readonly #pulling = new Map<string, GraphPull>();
  readonly #runs = new Set<Promise<void>>();
  readonly #whenStopped: Promise<void>;
  #markStopped!: () => void;
  #stopped = false;

  constructor(ports: SwmChangeNoticeReceiverPorts) {
    this.#ports = ports;
    this.#perPeerLimit = ports.perPeerLimit ?? SWM_CHANGE_NOTICE_PER_PEER_LIMIT;
    this.#perPeerWindowMs = ports.perPeerWindowMs ?? SWM_CHANGE_NOTICE_PER_PEER_WINDOW_MS;
    this.#now = ports.now ?? Date.now;
    this.#retryDelaysMs = ports.deferredRetryDelaysMs ?? SWM_CHANGE_NOTICE_DEFERRED_RETRY_DELAYS_MS;
    this.#sleep = ports.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
    this.#whenStopped = new Promise((resolve) => { this.#markStopped = resolve; });
  }

  /** Handle one notice from `fromPeerId`. Starts the pull and returns without waiting for it. */
  async handle(bytes: Uint8Array, fromPeerId: string): Promise<SwmChangeNoticeDisposition> {
    if (this.#stopped) return 'stopped';
    let notice: SwmChangeNoticeV1;
    try {
      notice = decodeSwmChangeNoticeV1(bytes);
    } catch {
      return 'invalid';
    }
    if (!this.#admit(fromPeerId)) return 'rate-limited';
    const refusal = await this.#refusal(notice.contextGraphId, fromPeerId);
    if (refusal !== null) return refusal;
    if (this.#stopped) return 'stopped';
    const key = `${notice.contextGraphId}\0${fromPeerId}`;
    const running = this.#pulling.get(key);
    if (running !== undefined) {
      running.trailing = notice;
      return 'coalesced';
    }
    if (this.#pulling.size >= MAX_PULLS) return 'busy';
    const pull: GraphPull = { trailing: null };
    this.#pulling.set(key, pull);
    const run = this.#pullUntilQuiet(key, pull, fromPeerId, notice);
    this.#runs.add(run);
    void run.finally(() => this.#runs.delete(run));
    return 'pulling';
  }

  /** Resolves when every pull started so far has ended; for tests and shutdown. */
  async settled(): Promise<void> {
    while (this.#runs.size > 0) await Promise.allSettled(this.#runs);
  }

  /** Shutdown: ignore notices from now on, and start no pull and no retry. A pull already running ends on its own. */
  stop(): void {
    this.#stopped = true;
    this.#markStopped();
  }

  /** Why a notice about the graph from this peer is not one to pull on; null when it is. */
  async #refusal(contextGraphId: string, peerId: string): Promise<'not-followed' | 'sender-not-accepted' | null> {
    if (!await this.#ports.follows(contextGraphId)) return 'not-followed';
    if (!await this.#ports.acceptsSender(contextGraphId, peerId)) return 'sender-not-accepted';
    return null;
  }

  /** Never rejects. */
  async #pullUntilQuiet(key: string, pull: GraphPull, peerId: string, first: SwmChangeNoticeV1): Promise<void> {
    let notice = first;
    let deferrals = 0;
    try {
      for (;;) {
        // The notices that came before this point are covered by the pull below.
        pull.trailing = null;
        const outcome = await this.#pullOnce(peerId, notice);
        let next: SwmChangeNoticeV1 | null = pull.trailing;
        if (outcome === 'deferred' && deferrals < this.#retryDelaysMs.length) {
          // Still in flight while it waits: notices that arrive meanwhile join it.
          await Promise.race([this.#sleep(this.#retryDelaysMs[deferrals]!), this.#whenStopped]);
          deferrals += 1;
          next = pull.trailing ?? notice;
        } else {
          deferrals = 0;
        }
        if (next === null || this.#stopped) return;
        // Admitted again: while the last pull ran, this node may have stopped
        // following the graph, or the sender may have gone.
        if (await this.#refusal(notice.contextGraphId, peerId) !== null || this.#stopped) return;
        notice = pull.trailing ?? next;
      }
    } catch (error) {
      this.#ports.log?.(
        `SWM change notice pulls of "${notice.contextGraphId}" from ${peerId.slice(-8)} stopped: ${errorText(error)}`,
      );
    } finally {
      this.#pulling.delete(key);
    }
  }

  async #pullOnce(peerId: string, notice: SwmChangeNoticeV1): Promise<'pulled' | 'deferred' | 'failed'> {
    try {
      return await this.#ports.pull(peerId, notice.contextGraphId);
    } catch (error) {
      this.#ports.log?.(
        `SWM change notice pull of "${notice.contextGraphId}" from ${peerId.slice(-8)} failed: ${errorText(error)}`,
      );
      return 'failed';
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
