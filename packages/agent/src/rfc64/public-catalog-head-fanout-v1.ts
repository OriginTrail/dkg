// SPDX-License-Identifier: Apache-2.0

/**
 * One fan-out of one author-catalog head announcement (GH#3081): which of the named peers this
 * node's own policy lets it announce to, and bounded sends to them. The delivery owner in
 * `public-catalog-head-delivery-v1.ts` decides which head is sent when; this is how one is sent.
 *
 * Selection asks the head transport's own policy decision for every peer, a few at a time, and
 * keeps three answers apart:
 *
 * - authorized: the peer is sent the head.
 * - refused: the policy answered no. Nothing is sent, and that is not a failure.
 * - unchecked: there is no answer. A lookup the decision needed failed or came back
 *   empty-handed, the decision did not arrive before the selection deadline, or too many
 *   decisions were already in flight. Such a peer is asked about once more while the deadline
 *   allows. Without an answer it is sent nothing and is reported apart from the refusals: a node
 *   that cannot check delivers to nobody, and must not look like a node with nobody to deliver to.
 *
 * Selection has a deadline of its own. Its reads cannot be cut short, so a decision that outlives
 * the deadline is left to end by itself and its answer is ignored. The decisions in flight are
 * counted, and past {@link RFC64_CATALOG_HEAD_MAX_DECISIONS_IN_FLIGHT_V1} no new one is started.
 *
 * Sends start in waves of {@link RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1} under one time budget
 * for all the sends of a fan-out, counted from its first send. A fan-out owns one abort
 * controller and one budget timer that every send of it shares; no signal is composed per send.
 * A send also asks this node's policy, before and after the wire, and those reads cannot be cut
 * short either. So once its signal has aborted, a fan-out waits for a send only for as long as a
 * send needs to unwind ({@link RFC64_CATALOG_HEAD_FANOUT_ABORT_GRACE_MS_V1}). A send that is
 * still not over then is reported with the fan-out and left to end by itself; with its signal
 * aborted it can no longer put anything on the wire. Abandoned sends are counted, and past
 * {@link RFC64_CATALOG_HEAD_MAX_ABANDONED_SENDS_V1} no new send is started.
 *
 * A send that the transport's policy wrapper denied is told apart by where it was denied. Before
 * the send, nothing went out: a refusal, or unchecked when that decision could not be made.
 * After it, the head went out while the peer was authorized and the authorization could not be
 * confirmed afterwards. A denial that is not the wrapper's own is the remote peer's answer, which
 * is a failed delivery.
 */

import type { SendOptions } from '@origintrail-official/dkg-core';

import {
  withRfc64CatalogPolicyProbeV1,
  type Rfc64CatalogPolicyProbeV1,
} from './catalog-policy-decision-probe-v1.js';
import { rfc64CatalogPolicyDenialPhaseV1 } from './catalog-transport-authorization-v1.js';
import {
  Rfc64PublicCatalogTransportErrorV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from './public-catalog-transport-v1.js';
import { mapWithConcurrency } from '../map-with-concurrency.js';

/** Sends a fan-out starts together. */
export const RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1 = 16;
/**
 * The next wave starts when the previous one has settled, or after this long when it has not, so
 * a peer that never answers holds back the peers of later waves by at most this much per wave and
 * never the peers of its own wave. All sends still end with the fan-out's one budget.
 */
export const RFC64_CATALOG_HEAD_FANOUT_WAVE_INTERVAL_MS_V1 = 1_000;
/**
 * Policy decisions one selection has in flight at once. For a private graph one decision reads
 * this node's store several times and, when the graph is registered on chain, the chain once. A
 * few at a time let identical chain reads that are in flight together be shared, without queueing
 * a burst of store reads.
 */
export const RFC64_CATALOG_HEAD_SELECTION_CONCURRENCY_V1 = 4;
/**
 * Policy decisions all selections may have in flight together, the ones that outlived their
 * selection's deadline included. Past it a peer is not asked about and counts as unchecked.
 */
export const RFC64_CATALOG_HEAD_MAX_DECISIONS_IN_FLIGHT_V1 = 16;
/**
 * How long a fan-out whose signal has aborted (its budget ended, the owner closed, or the caller
 * gave up) still waits for its sends to unwind. A send on the wire ends at once; one that is
 * waiting for a policy read of its own does not, and is abandoned after this long.
 */
export const RFC64_CATALOG_HEAD_FANOUT_ABORT_GRACE_MS_V1 = 1_000;
/**
 * Sends that may be left to end by themselves after their fan-out ended, all fan-outs together.
 * A send is in that state only while a policy read of its own is still in flight. Past this many,
 * a new send is not started and is reported as failed.
 */
export const RFC64_CATALOG_HEAD_MAX_ABANDONED_SENDS_V1 = 4_096;
const ABANDONED_SENDS_MESSAGE_V1 =
  'RFC-64 catalog head sends of earlier fan-outs have not ended: no new send is started';

export interface AnnounceRfc64PublicCatalogHeadResultV1 {
  /** Validated immutable snapshot used for every delivery attempt. */
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  /** Input-order peers that returned the exact transport ACK. */
  readonly announcedPeers: readonly string[];
  /**
   * Input-order peers whose attempt threw, returned a non-ACK, or was not reached before the
   * budget ended; `code` classifies typed failures.
   */
  readonly failedPeers: ReadonlyArray<{
    readonly peerId: string;
    readonly error: string;
    readonly code?: Rfc64PublicCatalogTransportErrorV1['code'];
  }>;
}

export interface Rfc64CatalogHeadFanoutPortsV1 {
  /** One announcement to one peer through the head transport, which rechecks the policy there. */
  readonly send: (
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    sendOptions: SendOptions,
  ) => Promise<void>;
  /**
   * Whether this node's own policy lets it announce `announcement` to the peer now: the head
   * transport's own decision, asked without sending anything.
   */
  readonly isPeerAuthorized: (
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ) => Promise<boolean>;
  /** Time budget of the sends of one whole fan-out, from the first send (ms). */
  readonly fanoutBudgetMs: number;
  /** Deadline of one selection, from its start (ms). Defaults to the budget of the sends. */
  readonly selectionBudgetMs?: number;
  /** Override of {@link RFC64_CATALOG_HEAD_MAX_ABANDONED_SENDS_V1}. */
  readonly maxAbandonedSends?: number;
  /** Monotonic milliseconds. */
  readonly now: () => number;
}

/**
 * What became of one send.
 *
 * - `refused`: this node's policy said no before the send. Nothing went out.
 * - `unchecked`: the policy decision before the send could not be made. Nothing went out.
 * - `unconfirmed`: the head went out while the peer was authorized, and once the send had
 *   finished this node could not confirm the authorization: it had ended, or could not be checked.
 * - `failed`: anything else, the remote peer's own denial included.
 */
export type Rfc64CatalogHeadSendV1 = Readonly<
  | { peerId: string; outcome: 'sent' }
  | {
    peerId: string;
    outcome: 'refused' | 'unchecked' | 'unconfirmed' | 'failed';
    failure: unknown;
  }
>;

export interface Rfc64CatalogHeadFanoutSessionV1 {
  /** Aborts when the budget ends, the owner closes, or the awaiting caller's signal aborts. */
  readonly signal: AbortSignal;
  /**
   * Rejects with the signal's reason once the signal has aborted and the grace for unwinding has
   * passed: what every send of the fan-out races, so that none can hold it for longer.
   */
  readonly abandoned: Promise<never>;
  remainingMs(): number;
  /** True when the budget, not the close path or a caller, ended the fan-out. */
  budgetEnded(): boolean;
  end(): void;
}

/** The peers of one head, by this node's own policy decision. Each list is in input order. */
export interface Rfc64CatalogHeadSelectionV1 {
  readonly eligible: readonly string[];
  readonly refused: readonly string[];
  readonly unchecked: readonly string[];
}

type PeerDecisionV1 = 'authorized' | 'refused' | 'unchecked';

export class Rfc64CatalogHeadFanoutV1 {
  readonly #ports: Rfc64CatalogHeadFanoutPortsV1;
  readonly #lifecycle: AbortSignal;
  /** Settles when the owner closes: what a selection waits on beside its work and its deadline. */
  readonly #closed: Promise<void>;
  #decisionsInFlight = 0;
  /** Sends whose fan-out ended while a policy read of theirs was still in flight. */
  #abandonedSends = 0;

  /** `lifecycle` aborts when the owner closes: every fan-out ends with it. */
  constructor(ports: Rfc64CatalogHeadFanoutPortsV1, lifecycle: AbortSignal) {
    this.#ports = ports;
    this.#lifecycle = lifecycle;
    this.#closed = new Promise<void>((resolve) => {
      if (lifecycle.aborted) resolve();
      else lifecycle.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  /** One abort controller and one timer for a whole fan-out; sources are followed, not composed. */
  begin(caller?: AbortSignal): Rfc64CatalogHeadFanoutSessionV1 {
    const budgetMs = this.#ports.fanoutBudgetMs;
    const controller = new AbortController();
    const budgetEnded = new DOMException(
      `RFC-64 catalog head fan-out exceeded its ${budgetMs} ms budget`,
      'TimeoutError',
    );
    const deadlineAt = this.#ports.now() + budgetMs;
    const timer = setTimeout(() => controller.abort(budgetEnded), budgetMs);
    timer.unref?.();
    const detachers: Array<() => void> = [];
    for (const source of [this.#lifecycle, caller]) {
      if (source === undefined) continue;
      if (source.aborted) {
        controller.abort(source.reason);
        continue;
      }
      const onAbort = (): void => controller.abort(source.reason);
      source.addEventListener('abort', onAbort, { once: true });
      detachers.push(() => source.removeEventListener('abort', onAbort));
    }
    let grace: ReturnType<typeof setTimeout> | undefined;
    const abandoned = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        grace = setTimeout(
          () => reject(controller.signal.reason),
          RFC64_CATALOG_HEAD_FANOUT_ABORT_GRACE_MS_V1,
        );
        grace.unref?.();
      };
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    // Raced by the sends; with none left to race it, the rejection is nobody's to handle.
    abandoned.catch(() => undefined);
    return {
      signal: controller.signal,
      abandoned,
      remainingMs: () => Math.max(1, Math.ceil(deadlineAt - this.#ports.now())),
      budgetEnded: () => controller.signal.reason === budgetEnded,
      end: () => {
        clearTimeout(timer);
        clearTimeout(grace);
        for (const detach of detachers.splice(0)) detach();
      },
    };
  }

  /**
   * Sends in bounded waves under the session's one budget. Never rejects. `onSendsStarted` is
   * called once every send has been started. Peers the budget ended before are reported as
   * failed; peers a caller's abort or the close path skipped are not reported at all.
   */
  async sendAll(
    session: Rfc64CatalogHeadFanoutSessionV1,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    peers: readonly string[],
    onSendsStarted?: () => void,
  ): Promise<Rfc64CatalogHeadSendV1[]> {
    // Filled by index as each send settles; every index below `next` is filled once all have.
    const sends: Rfc64CatalogHeadSendV1[] = [];
    const maxAbandonedSends = this.#ports.maxAbandonedSends
      ?? RFC64_CATALOG_HEAD_MAX_ABANDONED_SENDS_V1;
    const attempt = async (index: number): Promise<void> => {
      const peerId = peers[index]!;
      if (this.#abandonedSends >= maxAbandonedSends) {
        sends[index] = { peerId, outcome: 'failed', failure: new Error(ABANDONED_SENDS_MESSAGE_V1) };
        return;
      }
      const probe: Rfc64CatalogPolicyProbeV1 = { undecided: false };
      let ended = false;
      const sending = withRfc64CatalogPolicyProbeV1(probe, async () => this.#ports.send(
        peerId,
        announcement,
        { timeoutMs: session.remainingMs(), signal: session.signal },
      )).finally(() => { ended = true; });
      try {
        // The session's abort ends the wait, not only the wire: a policy read of this send that
        // is still in flight must not hold the fan-out, its scope or the close path.
        await Promise.race([sending, session.abandoned]);
        sends[index] = { peerId, outcome: 'sent' };
      } catch (failure) {
        sends[index] = { peerId, outcome: failedSendOutcomeV1(failure, probe), failure };
      }
      if (ended) return;
      // Left to end by itself. Its signal has aborted, so it cannot reach the wire any more.
      this.#abandonedSends += 1;
      void sending.then(() => undefined, () => undefined)
        .then(() => { this.#abandonedSends -= 1; });
    };
    const started: Promise<void>[] = [];
    let next = 0;
    while (next < peers.length && !session.signal.aborted) {
      const wave: Promise<void>[] = [];
      const waveEnd = Math.min(peers.length, next + RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1);
      for (; next < waveEnd; next += 1) wave.push(attempt(next));
      started.push(...wave);
      if (next < peers.length) {
        await settledOrElapsedV1(wave, RFC64_CATALOG_HEAD_FANOUT_WAVE_INTERVAL_MS_V1);
      }
    }
    onSendsStarted?.();
    await Promise.all(started);
    if (session.budgetEnded()) {
      // Peers the budget ended before were asked for and did not get the head: report them.
      for (; next < peers.length; next += 1) {
        sends[next] = { peerId: peers[next]!, outcome: 'failed', failure: session.signal.reason };
      }
    }
    return sends.slice(0, next);
  }

  /**
   * Ask this node's own policy about every peer, a second time about a peer it could not decide
   * on, and stop at the selection deadline. Never rejects. Nothing is remembered: the next
   * selection asks again.
   */
  async select(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    peers: readonly string[],
  ): Promise<Rfc64CatalogHeadSelectionV1> {
    const deadlineAt = this.#ports.now()
      + (this.#ports.selectionBudgetMs ?? this.#ports.fanoutBudgetMs);
    const answers = new Map<string, PeerDecisionV1>();
    const ask = async (asked: readonly string[]): Promise<void> => {
      let listening = true;
      const asking = mapWithConcurrency(
        asked,
        RFC64_CATALOG_HEAD_SELECTION_CONCURRENCY_V1,
        async (peerId) => {
          // Past the deadline, or once the owner is closing, no further decision is worth a read.
          if (!listening || this.#lifecycle.aborted) return;
          const decision = await this.#decide(peerId, announcement);
          if (listening) answers.set(peerId, decision);
        },
      );
      await this.#settledOrDue(asking, deadlineAt);
      listening = false;
    };
    await ask(peers);
    const undecided = peers.filter((peerId) => answers.get(peerId) === 'unchecked');
    if (undecided.length > 0 && !this.#lifecycle.aborted && this.#ports.now() < deadlineAt) {
      await ask(undecided);
    }
    const answered = (decision: PeerDecisionV1): string[] => (
      peers.filter((peerId) => answers.get(peerId) === decision)
    );
    return Object.freeze({
      eligible: answered('authorized'),
      refused: answered('refused'),
      // A peer without an answer in time was not checked either. An owner that is closing gave
      // up asking, which is not the same as being unable to check.
      unchecked: this.#lifecycle.aborted
        ? []
        : peers.filter((peerId) => (answers.get(peerId) ?? 'unchecked') === 'unchecked'),
    });
  }

  /** One decision, asked now and never cached. Never rejects. */
  async #decide(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): Promise<PeerDecisionV1> {
    if (this.#decisionsInFlight >= RFC64_CATALOG_HEAD_MAX_DECISIONS_IN_FLIGHT_V1) return 'unchecked';
    this.#decisionsInFlight += 1;
    const probe: Rfc64CatalogPolicyProbeV1 = { undecided: false };
    try {
      const authorized = await withRfc64CatalogPolicyProbeV1(
        probe,
        async () => this.#ports.isPeerAuthorized(remotePeerId, announcement),
      );
      if (authorized === true) return 'authorized';
      return probe.undecided ? 'unchecked' : 'refused';
    } catch {
      // A decision that fails is no answer.
      return 'unchecked';
    } finally {
      this.#decisionsInFlight -= 1;
    }
  }

  /** Resolves when `work` settles, the deadline passes or the owner closes, whichever is first. */
  async #settledOrDue(work: Promise<unknown>, deadlineAt: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const due = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadlineAt - this.#ports.now()));
      timer.unref?.();
    });
    try {
      await Promise.race([work, due, this.#closed]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The peers that have the head, and every other reported send as a failed peer. */
export function describeRfc64CatalogHeadSendsV1(
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  sends: readonly Rfc64CatalogHeadSendV1[],
): AnnounceRfc64PublicCatalogHeadResultV1 {
  const announcedPeers: string[] = [];
  const failedPeers: Array<AnnounceRfc64PublicCatalogHeadResultV1['failedPeers'][number]> = [];
  for (const send of sends) {
    if (send.outcome === 'sent') {
      announcedPeers.push(send.peerId);
      continue;
    }
    const { failure } = send;
    // Classify where the typed error still exists: the message is display text only.
    failedPeers.push(Object.freeze({
      peerId: send.peerId,
      error: failure instanceof Error ? failure.message : String(failure),
      ...(failure instanceof Rfc64PublicCatalogTransportErrorV1 ? { code: failure.code } : {}),
    }));
  }
  return Object.freeze({
    announcement,
    announcedPeers: Object.freeze(announcedPeers),
    failedPeers: Object.freeze(failedPeers),
  });
}

function failedSendOutcomeV1(
  failure: unknown,
  probe: Readonly<Rfc64CatalogPolicyProbeV1>,
): 'refused' | 'unchecked' | 'unconfirmed' | 'failed' {
  if (
    !(failure instanceof Rfc64PublicCatalogTransportErrorV1)
    || failure.code !== 'catalog-transport-policy-denied'
  ) return 'failed';
  const phase = rfc64CatalogPolicyDenialPhaseV1(failure);
  if (phase === 'before-work') return probe.undecided ? 'unchecked' : 'refused';
  // Not one of this node's own two checks: the remote peer answered with a denial.
  return phase === 'after-work' ? 'unconfirmed' : 'failed';
}

/** Resolves when every promise of `wave` has settled or `intervalMs` has passed, whichever first. */
async function settledOrElapsedV1(
  wave: readonly Promise<void>[],
  intervalMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, intervalMs);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.all(wave), elapsed]);
  } finally {
    clearTimeout(timer);
  }
}
