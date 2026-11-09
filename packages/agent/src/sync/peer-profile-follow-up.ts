// SPDX-License-Identifier: Apache-2.0

/**
 * Follow-up pulls of the `agents` graph from a peer whose own profile the
 * connect-time pull did not bring.
 *
 * A node publishes its agent profile just after it starts serving sync, and a
 * peer pulls its `agents` graph as soon as the sync protocol shows up in
 * identify. That pull can run first and leave the starting node's own profile
 * out (a Core's publish takes longer than an Edge's), and the peer's next
 * whole-scope pass comes minutes later. So when a pull of the `agents` graph
 * from a peer leaves that peer's own profile missing, pull the graph from it
 * again shortly after, a few times, until the profile is there.
 *
 * Bounds: one episode per peer at a time, at most one pull per entry of
 * `delaysMs`, only while the peer stays connected; a peer whose episode ran
 * out of pulls without its profile gets no other one; closing the follow-up
 * (the peer sync session's end) cancels every pending pull.
 */

/** When the follow-up pulls run: after the pull that lacked the profile, then after each other. */
export const PEER_PROFILE_FOLLOW_UP_DELAYS_MS: readonly number[] = Object.freeze([2_000, 10_000, 30_000]);

export interface PeerProfileFollowUpDeps {
  /** Whether the local `agents` graph holds a profile that names `peerId`. */
  hasProfile(peerId: string, signal: AbortSignal): Promise<boolean>;
  isConnected(peerId: string): boolean;
  /** One durable pull of the `agents` graph from `peerId`. */
  pullAgents(peerId: string, signal: AbortSignal): Promise<void>;
  logInfo(message: string): void;
  setTimer?: (run: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class PeerProfileFollowUp {
  readonly #deps: PeerProfileFollowUpDeps;
  readonly #delaysMs: readonly number[];
  readonly #lifetime = new AbortController();
  /** Peers with an episode under way: the timer of the next pull, null while a check or pull runs. */
  readonly #episodes = new Map<string, unknown>();
  /** Peers whose episode ran out of pulls without the profile. */
  readonly #gaveUp = new Set<string>();
  readonly #setTimer: (run: () => void, delayMs: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;

  constructor(deps: PeerProfileFollowUpDeps, delaysMs: readonly number[] = PEER_PROFILE_FOLLOW_UP_DELAYS_MS) {
    this.#deps = deps;
    this.#delaysMs = delaysMs;
    this.#setTimer = deps.setTimer ?? ((run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      timer.unref?.();
      return timer;
    });
    this.#clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  /** A pull of the `agents` graph from `peerId` has just run: start an episode if its profile is still missing. */
  async observePull(peerId: string): Promise<void> {
    const signal = this.#lifetime.signal;
    if (signal.aborted || this.#episodes.has(peerId) || this.#gaveUp.has(peerId)) return;
    this.#episodes.set(peerId, null);
    let missing = false;
    try {
      missing = !(await this.#deps.hasProfile(peerId, signal));
    } catch {
      // An unreadable store tells nothing about the peer: no episode.
    }
    if (signal.aborted) return;
    if (missing) this.#schedule(peerId, 0);
    else this.#episodes.delete(peerId);
  }

  /** Cancel every pending pull; later observations start nothing. */
  close(): void {
    this.#lifetime.abort();
    for (const timer of this.#episodes.values()) {
      if (timer !== null) this.#clearTimer(timer);
    }
    this.#episodes.clear();
  }

  #schedule(peerId: string, attempt: number): void {
    const delayMs = this.#delaysMs[attempt];
    if (delayMs === undefined) {
      this.#episodes.delete(peerId);
      this.#gaveUp.add(peerId);
      this.#deps.logInfo(`Agents graph of ${peerId.slice(-8)} still lacks the peer's own profile after ${attempt} follow-up pull(s)`);
      return;
    }
    this.#episodes.set(peerId, this.#setTimer(() => { void this.#pull(peerId, attempt); }, delayMs));
  }

  async #pull(peerId: string, attempt: number): Promise<void> {
    const signal = this.#lifetime.signal;
    if (signal.aborted) return;
    if (!this.#deps.isConnected(peerId)) {
      this.#episodes.delete(peerId);
      return;
    }
    this.#episodes.set(peerId, null);
    let found = false;
    try {
      await this.#deps.pullAgents(peerId, signal);
      found = await this.#deps.hasProfile(peerId, signal);
    } catch {
      // A failed pull counts as an attempt; the next one may succeed.
    }
    if (signal.aborted) return;
    if (!found) {
      this.#schedule(peerId, attempt + 1);
      return;
    }
    this.#episodes.delete(peerId);
    this.#deps.logInfo(`Pulled the own profile of ${peerId.slice(-8)} with follow-up pull ${attempt + 1} of its agents graph`);
  }
}

const followUpsByLifetime = new WeakMap<object, PeerProfileFollowUp>();

/**
 * The follow-up of one peer sync session, created on first use and closed
 * with the session (`onClose` runs at once on a session already closed).
 */
export function peerProfileFollowUpFor(
  lifetime: { onClose(cleanup: () => void): unknown },
  create: () => PeerProfileFollowUp,
): PeerProfileFollowUp {
  let followUp = followUpsByLifetime.get(lifetime);
  if (followUp === undefined) {
    const created = create();
    followUp = created;
    followUpsByLifetime.set(lifetime, created);
    lifetime.onClose(() => created.close());
  }
  return followUp;
}
