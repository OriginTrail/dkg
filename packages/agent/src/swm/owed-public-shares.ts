// SPDX-License-Identifier: Apache-2.0

/**
 * Shares into a public context graph that are owed to someone, kept and sent
 * again for a bounded time.
 *
 * A relay-only Edge reaches the other members of a public graph only through
 * the peers it is connected to (`relay-only-share-routes.ts`). Right after a
 * graph is created none of those routes may exist yet: no Core subscribes to
 * the graph, no connected Core hosts it, and the graph's owner is not in the
 * Edge's phonebook. A share made then went to nobody, and nothing sent it
 * again. The share's delivery tracking (`ack-quorum.ts`) cannot do it: it
 * tracks only recipients the share went to, it re-sends the original bytes,
 * and it ends after five minutes, the age at which receivers refuse an
 * envelope as too old.
 *
 * So the agent keeps such a share here, by its operation id, for what it owes:
 *  - `holder`: the share reached no peer at all, or only Cores that refused
 *    it. Any connected Core that takes it settles this; the others then pull
 *    it from that Core.
 *  - `owner`: the graph's owner, on another node, did not get it. The owner
 *    needs the share itself, not a pulled copy, because only the share carries
 *    its author's seal. The owner's route is asked again on each pass, until
 *    it finds the owner.
 * Every {@link OWED_PUBLIC_SHARE_RETRY_MS} one pass sends at most
 * {@link OWED_PUBLIC_SHARES_PER_PASS} records, those owed to any peer first;
 * within each kind the record tried longest ago goes first, a record never
 * tried before any other, oldest first among equals. So records that keep
 * failing take turns with the others instead of holding every place of every
 * pass while a newer record waits until it expires. A record with no peer to
 * go to now does not count, and keeps its place. A share is
 * signed again before it is sent once its envelope is older than
 * {@link OWED_PUBLIC_SHARE_RESIGN_AFTER_MS}. A record ends when what it owes
 * is settled, when the owner refuses the share, when every Core it was sent to
 * refuses it, when its graph is no longer public, after
 * {@link OWED_PUBLIC_SHARE_RESIGN_FAILURES_MAX} failed signings, or after
 * {@link OWED_PUBLIC_SHARE_TTL_MS}. At most {@link OWED_PUBLIC_SHARES_MAX}
 * records, of at most {@link OWED_PUBLIC_SHARES_MAX_BYTES} together, are kept;
 * the oldest makes room. Shares dropped unsent are warned of once a pass.
 *
 * A pass never writes the agent's memory of Cores that refused a share
 * (`relay-only-share-routes.ts`): a receiver answers a share it will never
 * apply, an outdated version among them, as it answers one for a graph it
 * does not host, so an old share sent again must not keep a Core from the
 * next fresh share. A Core that refused a record is only not sent that record
 * again.
 */

import { decodeGossipEnvelope, GOSSIP_ENVELOPE_FRESHNESS_MS } from '@origintrail-official/dkg-core';
import type { FanOutPeerRecord } from './substrate-fanout.js';

/** How long a share is kept before it is given up, with a warning. */
export const OWED_PUBLIC_SHARE_TTL_MS = 30 * 60_000;
/** Spacing of the passes that send owed shares again. */
export const OWED_PUBLIC_SHARE_RETRY_MS = 30_000;
/** Shares kept at once. */
export const OWED_PUBLIC_SHARES_MAX = 64;
/** Bytes the kept shares may hold together, each counted with its envelope: a share can be 4 MiB. */
export const OWED_PUBLIC_SHARES_MAX_BYTES = 32 * 1024 * 1024;
/** Shares one pass sends, those that reached nobody first; a share with nobody to go to does not count. */
export const OWED_PUBLIC_SHARES_PER_PASS = 8;
/** Owner peers one pass sends a share to, in order, until one takes it. */
export const OWED_PUBLIC_SHARE_OWNER_PEERS_MAX = 2;
/**
 * A share whose envelope is older than this is signed again before it is
 * sent: receivers refuse an envelope older than
 * `GOSSIP_ENVELOPE_FRESHNESS_MS`, and a send can take up to a minute.
 */
export const OWED_PUBLIC_SHARE_RESIGN_AFTER_MS = GOSSIP_ENVELOPE_FRESHNESS_MS - 60_000;
/** Failed signings after which a share is given up: an external signer may hold a pass for minutes. */
export const OWED_PUBLIC_SHARE_RESIGN_FAILURES_MAX = 3;
/** Dropped shares one warning names; the others are counted. */
const DROPPED_NAMED_MAX = 3;

/** What became of one send of an owed share. */
export type OwedShareSendOutcome = 'delivered' | 'retryable' | 'rejected' | 'failed';

/** The outcome of one send, from the substrate's classification of it. */
export function owedShareOutcomeOf(outcome: FanOutPeerRecord['outcome']): OwedShareSendOutcome {
  if (outcome === 'delivered' || outcome === 'rejected' || outcome === 'failed') return outcome;
  return 'retryable';
}

/** When `wire`, a signed gossip envelope, was signed; `fallback` for bytes that carry no timestamp. */
export function envelopeSignedAtMs(wire: Uint8Array, fallback: number): number {
  try {
    const signedAt = Date.parse(decodeGossipEnvelope(wire).timestamp);
    return Number.isFinite(signedAt) ? signedAt : fallback;
  } catch {
    return fallback;
  }
}

export interface OwedPublicShareInput<S> {
  readonly shareOperationId: string;
  readonly contextGraphId: string;
  /** The named sub-graph the share went to; `null` for the root. */
  readonly subGraphName: string | null;
  /** The share's payload, signed again into a fresh envelope when `wire` grows old. */
  readonly message: Uint8Array;
  /** What goes on the wire: the share's signed envelope. */
  readonly wire: Uint8Array;
  readonly signedAt: number;
  /** What signs `message` again; opaque here. */
  readonly signer: S;
  /** The share reached no peer at all, or only Cores that refused it. */
  readonly holder: boolean;
  /** The graph's owner, on another node, did not get the share. */
  readonly owner: boolean;
}

/** One owed share, as the ports see it. */
export interface OwedPublicShare<S> extends OwedPublicShareInput<S> {
  readonly createdAt: number;
  /** Passes that worked on the share; part of each send's message id. */
  readonly attempts: number;
}

interface OwedRecord<S> extends OwedPublicShare<S> {
  wire: Uint8Array;
  signedAt: number;
  attempts: number;
  holder: boolean;
  owner: boolean;
  resignFailures: number;
  /** The store's count of shares tried, taken when this one was last tried; 0 while it never was. */
  lastTry: number;
  /** Cores that refused this share; it is not sent to them again. */
  readonly refusedBy: Set<string>;
}

/** What the store uses of the agent. */
export interface OwedPublicSharePorts<S> {
  /** Whether the graph is public now; never asked more than once a pass per graph. */
  isPublic(contextGraphId: string): Promise<boolean>;
  /** Connected Cores, none of `exclude`, that may hold the graph's share of this scope now, bounded. */
  holderPeers(contextGraphId: string, subGraphName: string | null, exclude: ReadonlySet<string>): Promise<readonly string[]>;
  /** The owner's peers this node can send to now, the graph known public; empty while the owner is not found. */
  ownerPeers(contextGraphId: string): Promise<readonly string[]>;
  /** A fresh envelope for the share's message. */
  resign(share: OwedPublicShare<S>): Promise<Uint8Array>;
  send(peerId: string, share: OwedPublicShare<S>): Promise<OwedShareSendOutcome>;
  /** False while the agent is not running: a pass then sends nothing. */
  isOpen(): boolean;
  logInfo(message: string): void;
  logWarn(message: string): void;
}

export interface OwedPublicSharesOptions {
  /** Defaults to `Date.now`; tests pass their own clock. */
  readonly now?: () => number;
  /** Runs `run` after `ms`; defaults to an unref'd `setTimeout`. */
  readonly schedule?: (run: () => void, ms: number) => { cancel(): void };
  /** Defaults to {@link OWED_PUBLIC_SHARES_MAX_BYTES}. */
  readonly maxBytes?: number;
}

function scheduleUnref(run: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(run, ms);
  (timer as { unref?: () => void }).unref?.();
  return { cancel: () => clearTimeout(timer) };
}

function describeShare(share: { contextGraphId: string; subGraphName: string | null; shareOperationId: string }): string {
  return `SWM share into "${share.contextGraphId}"`
    + (share.subGraphName === null ? '' : ` sub-graph "${share.subGraphName}"`)
    + ` op=${share.shareOperationId}`;
}

function bytesOf(share: { message: Uint8Array; wire: Uint8Array }): number {
  return share.message.byteLength + share.wire.byteLength;
}

function missing(share: { holder: boolean; owner: boolean }): string {
  return [share.holder ? 'any peer' : '', share.owner ? 'the graph\'s owner' : ''].filter(Boolean).join(' or ');
}

/** Shares dropped without reaching what they owed, for one warning. */
class DroppedShares {
  #named: string[] = [];
  #count = 0;

  add(share: OwedPublicShare<unknown>): void {
    this.#count += 1;
    if (this.#named.length < DROPPED_NAMED_MAX) this.#named.push(`${describeShare(share)} (owed ${missing(share)})`);
  }

  /** One warning for the shares added since the last one, if any. */
  flush(warn: (message: string) => void, why: string): void {
    if (this.#count === 0) return;
    const more = this.#count - this.#named.length;
    warn(`${this.#count} SWM share${this.#count === 1 ? '' : 's'} ${why}, not having reached what ${this.#count === 1 ? 'it' : 'they'} owed: `
      + this.#named.join('; ') + (more > 0 ? `; and ${more} more` : ''));
    this.#named = [];
    this.#count = 0;
  }
}

/** What one pass asks once per graph. */
interface PassLookups {
  readonly publicGraphs: Map<string, Promise<boolean>>;
  readonly owners: Map<string, Promise<readonly string[]>>;
}

function lookUpOnce<T>(cache: Map<string, Promise<T>>, key: string, run: () => Promise<T>, fallback: T): Promise<T> {
  let lookup = cache.get(key);
  if (lookup === undefined) {
    lookup = settled(run, fallback);
    cache.set(key, lookup);
  }
  return lookup;
}

/** One agent's owed shares; see the module comment. */
export class OwedPublicShares<S> {
  readonly #ports: OwedPublicSharePorts<S>;
  readonly #now: () => number;
  readonly #schedule: (run: () => void, ms: number) => { cancel(): void };
  readonly #maxBytes: number;
  /** By operation id, in insertion order: the first record is the oldest. */
  readonly #shares = new Map<string, OwedRecord<S>>();
  /** Shares that made room for newer ones since the last pass. */
  readonly #droppedForRoom = new DroppedShares();
  /** Shares tried so far, over all passes: a share's {@link OwedRecord.lastTry} orders the next pass. */
  #tries = 0;
  #timer: { cancel(): void } | undefined;
  #running: Promise<void> | undefined;
  #closed = false;
  /** Bumped by {@link close}: a pass started before it sends nothing more, even after {@link reopen}. */
  #generation = 0;

  constructor(ports: OwedPublicSharePorts<S>, options: OwedPublicSharesOptions = {}) {
    this.#ports = ports;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule = options.schedule ?? scheduleUnref;
    this.#maxBytes = options.maxBytes ?? OWED_PUBLIC_SHARES_MAX_BYTES;
  }

  get size(): number {
    return this.#shares.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The records, oldest first; for tests and diagnostics. */
  snapshot(): ReadonlyArray<OwedPublicShare<S>> {
    return [...this.#shares.values()].map((share) => ({ ...share }));
  }

  /** Keep `input` for what it owes. A share already kept owes what both owe. */
  owe(input: OwedPublicShareInput<S>): void {
    if (this.#closed || (!input.holder && !input.owner)) return;
    const kept = this.#shares.get(input.shareOperationId);
    if (kept !== undefined) {
      kept.holder ||= input.holder;
      kept.owner ||= input.owner;
      return;
    }
    const bytes = bytesOf(input);
    if (bytes > this.#maxBytes) {
      this.#ports.logWarn(`${describeShare(input)} not kept to be sent again: ${bytes} bytes is more than the ${this.#maxBytes} kept for owed shares`);
      return;
    }
    let keptBytes = [...this.#shares.values()].reduce((sum, share) => sum + bytesOf(share), 0);
    for (const oldest of this.#shares.values()) {
      if (this.#shares.size < OWED_PUBLIC_SHARES_MAX && keptBytes + bytes <= this.#maxBytes) break;
      this.#shares.delete(oldest.shareOperationId);
      keptBytes -= bytesOf(oldest);
      this.#droppedForRoom.add(oldest);
    }
    this.#shares.set(input.shareOperationId, {
      ...input, createdAt: this.#now(), attempts: 0, resignFailures: 0, lastTry: 0, refusedBy: new Set(),
    });
    this.#arm();
  }

  /** One pass now; a pass that is running is joined, never doubled. */
  tick(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    if (this.#closed) return Promise.resolve();
    this.#timer?.cancel();
    this.#timer = undefined;
    const running: Promise<void> = this.#pass(this.#generation).finally(() => {
      if (this.#running === running) this.#running = undefined;
      this.#arm();
    });
    this.#running = running;
    return running;
  }

  /** Resolves once no pass runs. */
  async whenIdle(): Promise<void> {
    while (this.#running !== undefined) await this.#running;
  }

  /**
   * Stop: no pass is scheduled any more, a running pass sends and logs
   * nothing more, and no share is kept until {@link reopen}.
   */
  close(): void {
    this.#closed = true;
    this.#generation += 1;
    this.#timer?.cancel();
    this.#timer = undefined;
    this.#running = undefined;
    this.#shares.clear();
  }

  /** Keep shares again after a restart; the store starts with none. */
  reopen(): void {
    this.#closed = false;
  }

  #arm(): void {
    if (this.#closed || this.#timer !== undefined || this.#running !== undefined || this.#shares.size === 0) return;
    this.#timer = this.#schedule(() => {
      this.#timer = undefined;
      void this.tick();
    }, OWED_PUBLIC_SHARE_RETRY_MS);
  }

  #open(generation: number): boolean {
    return generation === this.#generation && !this.#closed && this.#ports.isOpen();
  }

  async #pass(generation: number): Promise<void> {
    const now = this.#now();
    const expired = new DroppedShares();
    for (const share of this.#shares.values()) {
      if (now - share.createdAt < OWED_PUBLIC_SHARE_TTL_MS) continue;
      this.#shares.delete(share.shareOperationId);
      expired.add(share);
    }
    const warn = (message: string) => this.#ports.logWarn(message);
    expired.flush(warn, `given up after ${OWED_PUBLIC_SHARE_TTL_MS / 60_000} min`);
    this.#droppedForRoom.flush(warn, 'dropped to make room for newer owed shares');
    const lookups: PassLookups = { publicGraphs: new Map(), owners: new Map() };
    // A share that reached nobody goes first. Within each kind the share tried
    // longest ago goes first; the sort keeps equals oldest first. A share tried
    // in this pass goes behind every share of its kind this pass did not get
    // to, so the shares of one kind take turns, and none waits behind shares
    // that keep failing until it expires.
    const shares = [...this.#shares.values()]
      .sort((left, right) => Number(right.holder) - Number(left.holder) || left.lastTry - right.lastTry);
    let sent = 0;
    for (const share of shares) {
      if (sent >= OWED_PUBLIC_SHARES_PER_PASS || !this.#open(generation)) return;
      if (this.#shares.get(share.shareOperationId) !== share) continue;
      if (await this.#retry(share, lookups, generation)) sent += 1;
    }
  }

  /** Whether the share was sent, or tried to be: false when it had nobody to go to. */
  async #retry(share: OwedRecord<S>, lookups: PassLookups, generation: number): Promise<boolean> {
    const isPublic = await lookUpOnce(lookups.publicGraphs, share.contextGraphId, () => this.#ports.isPublic(share.contextGraphId), false);
    if (!this.#open(generation)) return false;
    if (!isPublic) {
      this.#shares.delete(share.shareOperationId);
      this.#ports.logInfo(`${describeShare(share)} not sent again: the graph is not public now, or its access policy cannot be read`);
      return false;
    }
    const holders = share.holder
      ? await settled(() => this.#ports.holderPeers(share.contextGraphId, share.subGraphName, share.refusedBy), [])
      : [];
    const owners = share.owner
      ? (await lookUpOnce(lookups.owners, share.contextGraphId, () => this.#ports.ownerPeers(share.contextGraphId), []))
        .slice(0, OWED_PUBLIC_SHARE_OWNER_PEERS_MAX)
      : [];
    if (!this.#open(generation) || (holders.length === 0 && owners.length === 0)) return false;
    share.attempts += 1;
    this.#tries += 1;
    share.lastTry = this.#tries;
    if (this.#now() - share.signedAt >= OWED_PUBLIC_SHARE_RESIGN_AFTER_MS && !(await this.#resign(share, generation))) return true;
    if (holders.length > 0) {
      const outcomes = await Promise.all(holders.map((peerId) => this.#send(peerId, share)));
      if (!this.#open(generation)) return true;
      holders.forEach((peerId, index) => {
        if (outcomes[index] === 'rejected') share.refusedBy.add(peerId);
      });
      if (outcomes.includes('delivered')) {
        share.holder = false;
      } else if (outcomes.every((outcome) => outcome === 'rejected')) {
        // A refused share is not applied later: no Core is asked again.
        share.holder = false;
        this.#ports.logInfo(`${describeShare(share)} refused by every Core it was sent to again; not sent to a Core any more`);
      }
    }
    for (const peerId of owners) {
      const outcome = await this.#send(peerId, share);
      if (!this.#open(generation)) return true;
      if (outcome === 'delivered') {
        this.#ports.logInfo(`${describeShare(share)} reached the graph's owner ${peerId.slice(-8)} on attempt ${share.attempts}`);
      } else if (outcome === 'rejected') {
        this.#ports.logWarn(`${describeShare(share)} refused by the graph's owner ${peerId.slice(-8)}; not sent again`);
      } else {
        continue;
      }
      share.owner = false;
      break;
    }
    if (!share.holder && !share.owner) this.#shares.delete(share.shareOperationId);
    return true;
  }

  /** Sign the share again; false when that failed, the share then kept for a later pass or given up. */
  async #resign(share: OwedRecord<S>, generation: number): Promise<boolean> {
    try {
      const wire = await this.#ports.resign(share);
      if (!this.#open(generation)) return false;
      share.wire = wire;
      share.signedAt = this.#now();
      share.resignFailures = 0;
      return true;
    } catch (error) {
      if (!this.#open(generation)) return false;
      share.resignFailures += 1;
      const reason = error instanceof Error ? error.message : String(error);
      if (share.resignFailures < OWED_PUBLIC_SHARE_RESIGN_FAILURES_MAX) {
        this.#ports.logInfo(`${describeShare(share)} not signed again, kept for the next pass: ${reason}`);
      } else {
        this.#shares.delete(share.shareOperationId);
        this.#ports.logWarn(`${describeShare(share)} given up without reaching ${missing(share)}: not signed again after ${share.resignFailures} tries: ${reason}`);
      }
      return false;
    }
  }

  #send(peerId: string, share: OwedRecord<S>): Promise<OwedShareSendOutcome> {
    return settled<OwedShareSendOutcome>(() => this.#ports.send(peerId, share), 'failed');
  }
}

/** What `run` resolves with, or `fallback` when it throws or rejects. */
async function settled<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback;
  }
}

const owedPublicSharesByAgent = new WeakMap<object, OwedPublicShares<unknown>>();

/**
 * The agent's owed shares, created with `ports()` on first use. `stop()`
 * closes them, so that a share made while the agent stops is not kept, and
 * `start()` reopens them.
 */
export function owedPublicSharesOf<S>(
  agent: object,
  ports: () => OwedPublicSharePorts<S>,
  options?: OwedPublicSharesOptions,
): OwedPublicShares<S> {
  let shares = owedPublicSharesByAgent.get(agent) as OwedPublicShares<S> | undefined;
  if (shares === undefined) {
    shares = new OwedPublicShares(ports(), options);
    owedPublicSharesByAgent.set(agent, shares as OwedPublicShares<unknown>);
  }
  return shares;
}

/** The agent's owed shares, if it has any store; never creates one. */
export function peekOwedPublicShares(agent: object): OwedPublicShares<unknown> | undefined {
  return owedPublicSharesByAgent.get(agent);
}
