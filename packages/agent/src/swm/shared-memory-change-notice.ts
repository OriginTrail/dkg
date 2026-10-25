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
 * A follower the notice did not reach is sent it again 3 s later, and once
 * more 15 s after that (#3421): a relayed connection to a follower behind a
 * NAT often lives too short for one stream, and a follower that misses the
 * notice otherwise waits for its next periodic pull. A node that does not know
 * the protocol refuses the stream and is not sent it again; one known not to
 * speak it is not sent it at all. The owner logs who it did not reach and why.
 * Nothing waits for the notice.
 *
 * The followers are those the owner knows at the change, and it knows them
 * from their requests since it started. A member that asks again only after
 * the change, as one that comes back a moment after the owner restarted,
 * would get the change only at its next periodic pull, a minute or more
 * later. So a peer that becomes a follower by asking for the graph's catalog
 * heads is sent the notice of the latest change another peer made within
 * {@link SWM_CHANGE_NOTICE_NEW_FOLLOWER_WINDOW_MS}, once
 * ({@link SwmChangeNotifier.afterNewFollower}). A peer that becomes a
 * follower by pulling the graph needs none: its pull carries every change
 * before it.
 *
 * A root share of a catalog-owned graph does not use this notice: it reaches
 * the owner as its author's catalog head, and the owner passes the head's
 * announcement on through the catalog's own delivery. The followers it tells
 * are found the same way ({@link swmChangeRecipients}).
 */

import { isProtocolUnsupportedError, validateContextGraphId, validateSubGraphName } from '@origintrail-official/dkg-core';
import { rememberBounded } from '../bounded-map.js';
import { SHARED_MEMORY_FOLLOWER_TTL_MS } from './shared-memory-followers.js';

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

/**
 * How the notice to one follower ended. `unsupported`: the follower does not
 * speak the protocol, and is not sent the notice again.
 */
export type SwmChangeNoticeOutcome = 'reached' | 'unsupported' | 'unreachable' | 'timeout' | 'reset' | 'failed';

export interface SwmChangeNoticeDelivery {
  readonly peerId: string;
  readonly outcome: SwmChangeNoticeOutcome;
}

/** The class of a send that failed, from its error. */
export function swmChangeNoticeFailure(error: unknown): Exclude<SwmChangeNoticeOutcome, 'reached'> {
  const text = (error instanceof Error ? `${error.name} ${error.message}` : String(error)).toLowerCase();
  if (isProtocolUnsupportedError(error) || text.includes('unsupportedprotocol')) return 'unsupported';
  if (/timeout|timed out/.test(text)) return 'timeout';
  if (/dial|no valid addresses|no.reservation|econnrefused|unreachable/.test(text)) return 'unreachable';
  if (/reset|closed|econnreset|epipe/.test(text)) return 'reset';
  return 'failed';
}

export interface SwmChangeNotifierPorts extends SwmChangeRecipientPorts {
  /** One attempt per recipient; resolves with how each one ended. */
  readonly deliver: (notice: SwmChangeNoticeV1, recipients: readonly string[]) => Promise<readonly SwmChangeNoticeDelivery[]>;
  /** False for a peer known not to speak the notice protocol: it is left out and counted apart. */
  readonly supportsNotice?: (peerId: string) => Promise<boolean | undefined>;
  readonly log?: (message: string) => void;
  /** Shortest gap between two notices of one scope; changes within it share one trailing notice. */
  readonly minIntervalMs?: number;
  /** Pauses before each resend to the followers the attempt before did not reach. */
  readonly resendDelaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export const SWM_CHANGE_NOTICE_MIN_INTERVAL_MS = 1_000;
export const SWM_CHANGE_NOTICE_RESEND_DELAYS_MS: readonly number[] = [3_000, 15_000];
/** Followers named in the log line of a notice that did not reach them; the rest are counted. */
const MAX_LOGGED_MISSES = 8;
/** Scopes with a trailing notice waiting at once; a burst over more drops the excess, periodic sync stays. */
const MAX_WAITING_SCOPES = 256;
/**
 * How long a change is told to a peer that becomes a follower after it: as
 * long as a follower stays one without asking again, so that a peer that was
 * no follower at the change has had no notice of it.
 */
export const SWM_CHANGE_NOTICE_NEW_FOLLOWER_WINDOW_MS = SHARED_MEMORY_FOLLOWER_TTL_MS;
/** Sources whose latest change is kept per graph; the one that changed it the longest ago makes room. */
const RECENT_CHANGE_SOURCES_PER_GRAPH = 16;

interface WaitingChange {
  change: SwmRemoteChange;
  readonly sources: Set<string>;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** One notice of one scope on its way: the followers it goes to, once they are known. */
interface NoticeRun {
  recipients?: ReadonlySet<string>;
}

/** One key per graph and scope. */
function scopeKey(contextGraphId: string, subGraphName: string | null): string {
  return `${contextGraphId}\0${subGraphName ?? ''}`;
}

export class SwmChangeNotifier {
  readonly #ports: SwmChangeNotifierPorts;
  readonly #minIntervalMs: number;
  readonly #resendDelaysMs: readonly number[];
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #lastSentAt = new Map<string, number>();
  readonly #waiting = new Map<string, WaitingChange>();
  readonly #inFlight = new Set<Promise<void>>();
  /**
   * The latest notice of each scope still in flight. An older notice leaves
   * its resends to the followers the newer one goes to; it keeps sending to
   * the others, such as the newer change's author, which no notice of its
   * own change is sent to.
   */
  readonly #latest = new Map<string, NoticeRun>();
  /** Per graph, the latest change of each source and when it was applied here, for a later follower. */
  readonly #recentChanges = new Map<string, Map<string, { readonly change: SwmRemoteChange; readonly at: number }>>();
  readonly #whenStopped: Promise<void>;
  #markStopped!: () => void;
  #stopped = false;

  constructor(ports: SwmChangeNotifierPorts) {
    this.#ports = ports;
    this.#minIntervalMs = ports.minIntervalMs ?? SWM_CHANGE_NOTICE_MIN_INTERVAL_MS;
    this.#resendDelaysMs = ports.resendDelaysMs ?? SWM_CHANGE_NOTICE_RESEND_DELAYS_MS;
    this.#sleep = ports.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()));
    this.#now = ports.now ?? Date.now;
    this.#whenStopped = new Promise((resolve) => { this.#markStopped = resolve; });
  }

  /** Called after a share from another peer was applied here. Never throws and never waits for the delivery. */
  afterRemoteChange(change: SwmRemoteChange): void {
    if (this.#stopped) return;
    this.#rememberChange(change);
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

  /**
   * Called when a peer became a follower of a graph by asking for its catalog
   * heads, not following it here before. The notices of earlier changes did
   * not go to it, and the replay it asked for carries the root's catalog
   * heads, not the named sub-graphs. It is sent the notice of the latest
   * change another peer made to the graph within the window, once, and pulls
   * the graph. Never throws and never waits for the delivery.
   */
  afterNewFollower(contextGraphId: string, peerId: string): void {
    if (this.#stopped) return;
    const latest = this.#latestChangeFor(contextGraphId, peerId);
    if (latest === undefined) return;
    const run = this.#tellNewFollower(latest, peerId).catch((error: unknown) => {
      this.#ports.log?.(`SWM change notice for "${contextGraphId}" not delivered to new follower ${peerId.slice(-8)}: ${errorText(error)}`);
    });
    this.#inFlight.add(run);
    void run.finally(() => this.#inFlight.delete(run));
  }

  /** Resolves when every delivery started so far has ended; for tests and shutdown. */
  async settled(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled(this.#inFlight);
  }

  /** Shutdown: drop the trailing notices that wait, end the waits for a resend, and send no more. */
  stop(): void {
    this.#stopped = true;
    this.#markStopped();
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
    const notice: NoticeRun = {};
    this.#latest.set(key, notice);
    const run = this.#fanOut(key, notice, change, sources).catch((error: unknown) => {
      this.#ports.log?.(`SWM change notice for "${change.contextGraphId}" not delivered: ${errorText(error)}`);
    }).finally(() => {
      if (this.#latest.get(key) === notice) this.#latest.delete(key);
    });
    this.#inFlight.add(run);
    void run.finally(() => this.#inFlight.delete(run));
  }

  async #fanOut(key: string, run: NoticeRun, change: SwmRemoteChange, sources: ReadonlySet<string>): Promise<void> {
    const recipients = await swmChangeRecipients(this.#ports, change.contextGraphId, sources);
    run.recipients = new Set(recipients);
    if (recipients.length === 0) return;
    const { contextGraphId, subGraphName, hint } = change;
    const notice = { contextGraphId, subGraphName, hint };
    const unsupported = new Set(await this.#knownWithoutNotice(recipients));
    const followers = recipients.filter((peerId) => !unsupported.has(peerId));
    const outcomes = new Map<string, SwmChangeNoticeOutcome>();
    let pending = followers;
    let resent = 0;
    let handedOver = false;
    for (let attempt = 0; pending.length > 0 && attempt <= this.#resendDelaysMs.length; attempt += 1) {
      if (attempt > 0) {
        await Promise.race([this.#sleep(this.#resendDelaysMs[attempt - 1]!), this.#whenStopped]);
        if (this.#stopped) break;
        // A newer notice of this scope carries the resends to the followers it goes to.
        const newer = this.#latest.get(key);
        const covered = newer === run ? undefined : newer?.recipients;
        if (covered !== undefined) {
          const left = pending.filter((peerId) => !covered.has(peerId));
          handedOver ||= left.length < pending.length;
          pending = left;
          if (pending.length === 0) break;
        }
      }
      for (const { peerId, outcome } of await this.#ports.deliver(notice, pending)) {
        outcomes.set(peerId, outcome);
        if (outcome === 'reached' && attempt > 0) resent += 1;
      }
      pending = pending.filter((peerId) => {
        const outcome = outcomes.get(peerId) ?? 'failed';
        if (outcome === 'unsupported') unsupported.add(peerId);
        return outcome !== 'reached' && outcome !== 'unsupported';
      });
    }
    const scope = subGraphName === null ? 'root' : `sub-graph "${subGraphName}"`;
    const sentTo = followers.filter((peerId) => !unsupported.has(peerId));
    const reached = sentTo.filter((peerId) => outcomes.get(peerId) === 'reached').length;
    const misses = sentTo.filter((peerId) => outcomes.get(peerId) !== 'reached')
      .map((peerId) => `${peerId.slice(-8)}=${outcomes.get(peerId) ?? 'failed'}`);
    this.#ports.log?.(
      `SWM change notice for "${contextGraphId}" ${scope} (${hint}): reached ${reached} of ${sentTo.length} follower(s)`
      + (resent > 0 ? `, ${resent} on a resend` : '')
      + (misses.length > 0 ? `; not reached: ${misses.slice(0, MAX_LOGGED_MISSES).join(', ')}` : '')
      + (misses.length > MAX_LOGGED_MISSES ? ` (+${misses.length - MAX_LOGGED_MISSES} more)` : '')
      + (handedOver && misses.length > 0 ? '; a newer notice takes over the resends' : '')
      + (unsupported.size > 0 ? `; ${unsupported.size} without the notice protocol` : ''),
    );
  }

  /** Keep a change for a peer that becomes a follower after it: per graph, the latest of each source. */
  #rememberChange(change: SwmRemoteChange): void {
    const bySource = this.#recentChanges.get(change.contextGraphId)
      ?? new Map<string, { readonly change: SwmRemoteChange; readonly at: number }>();
    rememberBounded(bySource, change.sourcePeerId, { change, at: this.#now() }, RECENT_CHANGE_SOURCES_PER_GRAPH);
    rememberBounded(this.#recentChanges, change.contextGraphId, bySource, 4 * MAX_WAITING_SCOPES);
  }

  /** The latest change to a graph within the window that a peer other than `peerId` made. */
  #latestChangeFor(contextGraphId: string, peerId: string): SwmRemoteChange | undefined {
    const bySource = this.#recentChanges.get(contextGraphId);
    if (bySource === undefined) return undefined;
    const oldest = this.#now() - SWM_CHANGE_NOTICE_NEW_FOLLOWER_WINDOW_MS;
    let latest: { readonly change: SwmRemoteChange; readonly at: number } | undefined;
    for (const [source, entry] of bySource) {
      if (source === peerId || entry.at < oldest) continue;
      if (latest === undefined || entry.at >= latest.at) latest = entry;
    }
    return latest?.change;
  }

  /** The notice of `change` to one new follower, sent again as any notice is; one log line. */
  async #tellNewFollower(change: SwmRemoteChange, peerId: string): Promise<void> {
    if (peerId === this.#ports.selfPeerId() || !await this.#ports.ownsPublicGraph(change.contextGraphId)) return;
    if ((await this.#knownWithoutNotice([peerId])).length > 0) return;
    const { contextGraphId, subGraphName, hint } = change;
    let outcome: SwmChangeNoticeOutcome = 'failed';
    let attempt = 0;
    for (; attempt <= this.#resendDelaysMs.length; attempt += 1) {
      if (attempt > 0) {
        await Promise.race([this.#sleep(this.#resendDelaysMs[attempt - 1]!), this.#whenStopped]);
        if (this.#stopped) break;
      }
      const delivered = await this.#ports.deliver({ contextGraphId, subGraphName, hint }, [peerId]);
      outcome = delivered.find((delivery) => delivery.peerId === peerId)?.outcome ?? 'failed';
      if (outcome === 'reached' || outcome === 'unsupported') break;
    }
    const scope = subGraphName === null ? 'root' : `sub-graph "${subGraphName}"`;
    this.#ports.log?.(
      `SWM change notice for "${contextGraphId}" ${scope} (${hint}) to new follower ${peerId.slice(-8)}: `
        + (outcome === 'reached' ? `reached${attempt > 0 ? ' on a resend' : ''}` : `not reached (${outcome})`),
    );
  }

  /** The recipients known not to speak the notice protocol. */
  async #knownWithoutNotice(recipients: readonly string[]): Promise<string[]> {
    const supportsNotice = this.#ports.supportsNotice;
    if (supportsNotice === undefined) return [];
    const support = await Promise.all(recipients.map((peerId) => supportsNotice(peerId).catch(() => undefined)));
    return recipients.filter((_, index) => support[index] === false);
  }
}

/** Send one encoded notice to each recipient; how each send ended. */
export async function sendSwmChangeNotice(
  notice: SwmChangeNoticeV1,
  recipients: readonly string[],
  send: (peerId: string, bytes: Uint8Array) => Promise<unknown>,
): Promise<SwmChangeNoticeDelivery[]> {
  const bytes = encodeSwmChangeNoticeV1(notice);
  const results = await Promise.allSettled(recipients.map((peerId) => send(peerId, bytes)));
  return results.map((result, index) => ({
    peerId: recipients[index]!,
    outcome: result.status === 'fulfilled' ? 'reached' : swmChangeNoticeFailure(result.reason),
  }));
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
