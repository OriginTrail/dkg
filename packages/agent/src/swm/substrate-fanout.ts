/**
 * SWM Reliable Fan-out — substrate fan-out policy + execution
 * (rc.9 PR-C, Step 3 of the plan).
 *
 * Sits between `publishWorkspaceGossip` (the SWM share egress
 * point) and the GossipSub mesh / Universal Messenger substrate.
 * Owns three concerns:
 *
 *   1. **Tier decision** — given a `CGMemberEnumeration`, decide
 *      which transports to use. As of the PR-C codex review (R2)
 *      gossip is the UNIVERSAL baseline: it always runs. Substrate
 *      decides whether to *also* run, adding a per-known-peer
 *      reliability upgrade for peers we have a roster for:
 *        - `{ useSubstrate: true,  useGossip: true }` — curated
 *          CG (`source: 'allowlist'`); roster is authoritative,
 *          but we still gossip because during a rolling rc.8/rc.9
 *          upgrade some allowlisted peers won't yet support
 *          `/dkg/10.0.1/swm-update` — substrate-only would silently
 *          stop delivering to those peers (libp2p
 *          protocol-negotiation error → sendReliable queues/retries
 *          forever, never reaches the receiver). Gossip is the
 *          cross-version safety net; PR-D will use per-peer ACK
 *          feedback to opportunistically suppress the gossip leg
 *          for peers that have confirmed substrate support.
 *        - `{ useSubstrate: true,  useGossip: true  }` — public CG
 *          (`source: 'topic-subscribers'`) at or below
 *          `maxSubstrateMembers`. Gossip remains the canonical
 *          transport (catches latecomer subscribers we don't yet
 *          see in the subscriber view); substrate is a top-up that
 *          raises per-known-peer reliability into the same window
 *          chat enjoys.
 *        - `{ useSubstrate: false, useGossip: true  }` — public CG
 *          above the threshold (substrate fan-out scales
 *          poorly above ~100 peers — N round-trips per share), or
 *          `source: 'none'` (bootstrap state or agent-gated
 *          private CG without an enumerable peer roster — see
 *          `enumerate-cg-members.ts` for why the latter fails
 *          closed).
 *
 *      NB: this module is intentionally PURE — it does not consult
 *      `process.env`. The caller (`DKGAgent`) reads
 *      `DKG_SWM_SUBSTRATE_MAX_MEMBERS` at construction time and
 *      passes the result in via `maxSubstrateMembers`.
 *
 *   2. **Fan-out execution** — for the chosen substrate set, fire
 *      `messenger.sendReliable` in PARALLEL via `Promise.allSettled`
 *      so one slow peer doesn't tail-latency the whole share. Each
 *      per-peer outcome is classified as `delivered` /
 *      `inFlight` / `queued` / `failed` and tallied into the
 *      bookkeeping callback the caller provides.
 *
 *      Why parallel and not sequential? A curated CG with 50
 *      members would otherwise pay 50 × p99 latency in the worst
 *      case. Parallel fan-out caps the wall-clock at p99 of the
 *      slowest single send.
 *
 *      Why `allSettled` and not `all`? `all` short-circuits on
 *      first reject — but `messenger.sendReliable` doesn't reject
 *      on transient failures (it returns `delivered: false,
 *      queued: true` and persists into the outbox). A synchronous
 *      throw here is the unrecoverable case (e.g. invalid peerId
 *      shape) where the failure is local-side, not network-side,
 *      and we want to record it but keep fanning out to the rest.
 *
 *   3. **Receiver-side coupling** — none, by design. The substrate
 *      handler registered on `PROTOCOL_SWM_UPDATE` hands the wire
 *      bytes straight to `SharedMemoryHandler.handle()`, the exact
 *      same in-process apply path the gossip subscription drives.
 *      That means PR-A's `seenShareOps`/`redundantApplies` accounting
 *      automatically covers double-delivery (gossip + substrate of
 *      the same share to the same peer) — the second arrival just
 *      bumps `swm.redundantApplies` for that cgId. No new dedup
 *      machinery needed at this layer.
 *
 * Watchdog / ACK / outstanding-table is PR-D, NOT here. PR-C is
 * "send it and tally what happened"; PR-D adds "and if nobody
 * acked, top up after N seconds".
 */

import type { ReliableSendResult } from '../p2p/messenger.js';
import type { CGMemberEnumeration } from './enumerate-cg-members.js';

/**
 * Per-call decision: which transports to use for ONE share.
 *
 * `useSubstrate` and `useGossip` are independent booleans so the
 * caller can write a single `if`/`if` block instead of a switch on
 * three named tiers; the four meaningful combinations are
 * captured exactly by the 2-bit product.
 */
export interface FanOutPlan {
  useSubstrate: boolean;
  useGossip: boolean;
  /**
   * Recipient set for the substrate leg. Empty array iff
   * `useSubstrate === false`. Already de-duplicated and
   * self-excluded by `CGMemberEnumerator`; this module does NOT
   * filter further.
   *
   * PR-J round 2 (codex RED #3 on #584): for `topic-subscribers`
   * CGs this is the `CGMemberEnumeration.substrateEligibleMembers`
   * subset when an `isPeerDialable` predicate was wired —
   * potentially smaller than `enumeratedMembers`. For
   * `allowlist` CGs the substrate target IS the full enumerated
   * set (curated CGs deliberately track offline allowlistees so
   * the watchdog can fire substrate top-up on reconnect).
   */
  substrateMembers: readonly string[];
  /**
   * Full enumerated recipient set, regardless of whether the
   * substrate leg actually targets each peer. Equals
   * `substrateMembers` when `useSubstrate === true`. When
   * `useSubstrate === false` for a public CG above
   * `maxSubstrateMembers`, this still carries every subscriber
   * the enumerator returned — so PR-D's `SwmAckQuorum` can track
   * the full expected delivery set for large public CGs (where
   * gossip is the ONLY transport and ack feedback is the only
   * way to know who actually got the share).
   *
   * Added in rc.9 PR-D codex follow-up #D3. Pre-D3 the
   * `SwmAckQuorum` track gate keyed off `substrateMembers.length
   * > 0`, which silently disabled the watchdog for the entire
   * gossip-only-because-too-many-subscribers branch.
   */
  enumeratedMembers: readonly string[];
  /**
   * The {@link CGMemberEnumeration.source} that drove the
   * decision. Surfaced for observability (log lines / per-tier
   * metric breakdown / soak postmortem).
   */
  enumerationSource: CGMemberEnumeration['source'];
  /**
   * Pre-truncation member count (before `maxSubstrateMembers`
   * gate kicked in). Equals `substrateMembers.length` when
   * `useSubstrate === true`. When `useSubstrate === false` for a
   * public CG that exceeded the threshold, this is the count
   * that tripped the gate. Used by the caller's WARN log so
   * operators can see "gossip-only because 137 > 100".
   */
  enumeratedCount: number;
}

/** Decision input — kept narrow so the policy is easy to test. */
export interface ChooseFanOutTierInput {
  enumeration: CGMemberEnumeration;
  /**
   * Maximum number of members we'll substrate-fan-out to. Above
   * this, public CGs fall back to gossip-only (substrate cost
   * grows linearly in members; gossip cost is independent of N).
   * Curated CGs are NOT truncated by this — see {@link chooseFanOutTier}
   * jsdoc for why.
   */
  maxSubstrateMembers: number;
}

/**
 * Pure tier-decision function. No I/O, no clock, no globals — safe
 * to call N times per share if the caller wants (only enumeration
 * cost dominates, and the enumerator has its own 60s cache).
 *
 * Decision matrix (see RFC-003 §6 + this module's header for the
 * full rationale). After PR-C codex R2, gossip is always on; the
 * substrate is an additive per-known-peer reliability layer.
 *
 *   | source              | members vs cap       | substrate | gossip |
 *   |---------------------|----------------------|-----------|--------|
 *   | allowlist           | (any size)           | YES       | YES    |
 *   | topic-subscribers   | <= maxSubstrateMembers | YES     | YES    |
 *   | topic-subscribers   | >  maxSubstrateMembers | NO      | YES    |
 *   | none                | (always empty)       | NO        | YES    |
 *
 * Why not truncate large curated CGs to the first
 * `maxSubstrateMembers`? A curated CG above the threshold is rare
 * (testnet curated CGs we've seen are <20 members), but the
 * delivery semantics matter more than the threshold cost: dropping
 * a substrate target because we're over budget would silently
 * regress reliability for the dropped peers. If a curated CG ever
 * does grow that large, PR-D's ACK + watchdog will catch missed
 * peers on the next tick (and the soak postmortem will surface
 * the throughput cost so we can decide whether to add batching
 * or sharding for rc.10).
 *
 * Why curated CGs ALSO publish to gossip (PR-C codex R2): rolling
 * rc.8 → rc.9 upgrades mean some allowlisted peers may not yet
 * speak `/dkg/10.0.1/swm-update`. Substrate-only delivery would
 * silently hit libp2p protocol-negotiation errors, sendReliable
 * would queue/retry forever, and the peer would stop receiving
 * SWM updates entirely until it upgraded. The gossip leg is a
 * cross-version safety net. Cost: one extra gossip publish per
 * share — negligible on small curated rosters, and receiver-side
 * dedup (`SharedMemoryHandler.seenShareOps`, PR-A) absorbs the
 * resulting double-delivery cleanly. PR-D will use per-peer ACK
 * feedback to opportunistically suppress the gossip leg for peers
 * confirmed to support substrate, recovering the wire-load saving
 * once a CG's roster is fully on rc.9+.
 */
export function chooseFanOutTier(input: ChooseFanOutTierInput): FanOutPlan {
  const { enumeration, maxSubstrateMembers } = input;
  const enumeratedCount = enumeration.members.length;
  // PR-J round 2 (codex RED #3 on #584): substrate target may be
  // a subset of `members` when the enumerator's `isPeerDialable`
  // filter dropped ghost peer-exchange entries. `members` stays
  // as the full gossip-eligible set (drives `enumeratedMembers`
  // → SwmAckQuorum.expectedMembers); the substrate target uses
  // the filtered subset when available. For curated
  // (`allowlist`) CGs the enumerator never populates this field
  // (we deliberately track offline allowlistees), so the
  // fallback to `members` preserves curated semantics.
  const substrateTarget = enumeration.substrateEligibleMembers ?? enumeration.members;

  switch (enumeration.source) {
    case 'allowlist':
      return {
        useSubstrate: true,
        useGossip: true,
        substrateMembers: enumeration.members,
        enumeratedMembers: enumeration.members,
        enumerationSource: 'allowlist',
        enumeratedCount,
      };
    case 'topic-subscribers':
      if (enumeratedCount <= maxSubstrateMembers) {
        return {
          useSubstrate: true,
          useGossip: true,
          substrateMembers: substrateTarget,
          enumeratedMembers: enumeration.members,
          enumerationSource: 'topic-subscribers',
          enumeratedCount,
        };
      }
      // rc.9 PR-D codex follow-up #D3: keep the full subscriber
      // list on `enumeratedMembers` even when we drop substrate.
      // SwmAckQuorum needs it to track expected delivery for
      // large public CGs (gossip-only) — pre-D3 the watchdog
      // was silently disabled here.
      return {
        useSubstrate: false,
        useGossip: true,
        substrateMembers: [],
        enumeratedMembers: enumeration.members,
        enumerationSource: 'topic-subscribers',
        enumeratedCount,
      };
    case 'none':
      return {
        useSubstrate: false,
        useGossip: true,
        substrateMembers: [],
        enumeratedMembers: [],
        enumerationSource: 'none',
        enumeratedCount,
      };
  }
}

/** Per-peer substrate fan-out outcome, the bookkeeping vocabulary. */
export type FanOutOutcome =
  // `messenger.sendReliable` returned `delivered: true` AND the
  // receiver's response was the empty Uint8Array (the
  // applied-OK ACK from `DKGAgent.handleSwmUpdate`). Payload is
  // in the receiver's SharedMemoryHandler. No follow-up needed.
  | 'delivered'
  // `messenger.sendReliable` returned `delivered: true` but the
  // receiver's response was the {@link FANOUT_RESPONSE_REJECTED}
  // sentinel — the receiver explicitly rejected the share for
  // a permanent reason (peer not in allowlist, bad agent
  // signature, validation failure). The sender drops the share
  // — retrying the same wire bytes would produce the same
  // rejection. Counted separately from `delivered` because PR-C
  // codex R6 caught that bundling them overstated end-to-end
  // success in `/api/slo`'s `swm.substrateFanout.delivered`.
  | 'rejected'
  // rc.9 PR-D (codex follow-up from PR-G #G1, deferred here so
  // it lands together with the watchdog that actually
  // reschedules retryable peers): `messenger.sendReliable`
  // returned `delivered: true` but the receiver's response was
  // the {@link FANOUT_RESPONSE_RETRYABLE} sentinel — the
  // receiver saw a TRANSIENT rejection (CAS pre-condition not
  // yet met; upstream writes pending). The sender does NOT
  // count this as delivered; SwmAckQuorum's watchdog handles
  // the actual re-send by leaving the peer out of the pre-acked
  // set so it falls through to the expectedMembers∖acked window
  // and substrate top-up fires at watchdogMs.
  //
  // Pre-PR-D the receiver THREW on retryable rejections, hoping
  // libp2p would surface the handler-abort as a recoverable
  // stream-reset that `isRecoverableSendError()` would re-queue
  // into the outbox. That hope was fragile: the non-pooled
  // ProtocolRouter aborts with the literal string `"handler
  // error"`, which matches none of the recoverable substrings,
  // so the share got DROPPED instead of queued. The sentinel
  // is deterministic — receiver returns the byte at the wire
  // layer, sender's classifier re-buckets it into 'retryable',
  // SwmAckQuorum's watchdog fires top-up. NOTE the throw path
  // remains in handleSwmUpdate as the fallback when PR-D's
  // watchdog is disabled (test seam / config flag), so the
  // pre-PR-D behaviour is recoverable.
  | 'retryable'
  // `messenger.sendReliable` returned `delivered: false, queued:
  // true`. Persisted into the durable substrate outbox; will be
  // retried by `Messenger.processOutboxTick` and on the next
  // reconnect. From this layer's POV, treat as a soft failure
  // (it's NOT a delivery confirmation) but DON'T re-fan out —
  // would just enqueue another row for the same logical share.
  | 'queued'
  // `messenger.sendReliable` returned the rare `inFlight: true`
  // (another sender already owns the in-process attempt for this
  // peer × protocol × messageId). Effectively a no-op for THIS
  // call; the other sender's outcome is what counts. Surfaced as
  // its own bucket because it shouldn't be lumped with "failed"
  // (no actual failure) or "delivered" (no actual delivery from
  // OUR call).
  | 'inFlight'
  // Synchronous throw OR `delivered: false, queued: false`.
  // Unrecoverable from this layer — usually a programming bug
  // (invalid peerId shape) or a substrate misconfiguration. The
  // share won't reach this peer via substrate. Gossip may still
  // cover it if `useGossip: true`; otherwise the next sync-on-
  // reconnect is the safety net.
  | 'failed';

/**
 * Wire sentinel returned by the substrate receiver
 * (`DKGAgent.handleSwmUpdate`) for permanent rejections that
 * the sender should drop without counting as delivered (peer
 * not in CG allowlist, bad agent signature, validation
 * rejection). Single-byte `0x01` chosen because:
 *
 *   - Distinguishable from the empty-Uint8Array applied-OK
 *     response (length 0 vs length 1).
 *   - Forward-compatible with PR-D's planned `SwmShareAck`:
 *     PR-D will replace this with a structured protobuf
 *     payload, but the 1-byte sentinel pins the
 *     "delivered ≠ applied" semantic for the rc.9 release line.
 *   - Older substrate senders that don't recognise the sentinel
 *     treat the 1-byte response as a successful `delivered`
 *     (slight metric overcount but no behavioural regression —
 *     they continue to drop the share locally because nothing
 *     further runs on a normal response).
 */
export const FANOUT_RESPONSE_REJECTED: Uint8Array = new Uint8Array([0x01]);

/**
 * rc.9 PR-D (codex follow-up from PR-G #G1, deferred here so
 * it lands together with the SwmAckQuorum watchdog). Wire
 * sentinel returned by the substrate receiver for TRANSIENT
 * rejections — the receiver couldn't apply the share right
 * now (CAS pre-condition not yet met) but the same wire bytes
 * might apply successfully on retry once upstream state
 * converges.
 *
 * Older substrate senders (pre-PR-D) treat 0x02 identically to
 * 0x01 — opaque non-empty byte → `delivered: true` in their
 * classifier. Slight metric overcount during rolling rc.9 PR-C
 * → PR-D upgrades; no behavioural regression since receivers
 * still dedup via `seenShareOps` (PR-A).
 */
export const FANOUT_RESPONSE_RETRYABLE: Uint8Array = new Uint8Array([0x02]);

/**
 * Per-peer record handed to {@link FanOutBookkeeper.recordOutcome}.
 * Includes the substrate-returned `attempts` and `messageId` so
 * the caller can correlate against the substrate outbox /
 * `/api/slo`'s `protocols['/dkg/10.0.1/swm-update']` histogram if
 * needed (debug-only; the per-cgId aggregate counters are the
 * production observability surface).
 */
export interface FanOutPeerRecord {
  peerId: string;
  outcome: FanOutOutcome;
  attempts: number;
  /** Substrate-assigned messageId; empty string for synchronous-throw failures. */
  messageId: string;
  /** Failure / queued reason string from the substrate; empty for delivered/inFlight. */
  error: string;
}

/**
 * Caller-side observability hook. The agent's implementation
 * increments per-(cgId, outcome) counters with the same overflow
 * cap pattern PR-A established for `swmGossipPublishFailures`.
 * Kept as an interface so the policy module stays unit-testable
 * with a tiny in-memory stub.
 */
export interface FanOutBookkeeper {
  recordOutcome(cgId: string, record: FanOutPeerRecord): void;
}

/**
 * Substrate dependency narrowed to the single method this module
 * needs. Lets the test suite supply a mock without dragging in
 * the full Messenger surface.
 */
export interface FanOutSubstrate {
  sendReliable(
    peerId: string,
    protocolId: string,
    payload: Uint8Array,
    opts?: { timeoutMs?: number },
  ): Promise<ReliableSendResult>;
}

export interface ExecuteSubstrateFanOutInput {
  contextGraphId: string;
  protocolId: string;
  /** Wire bytes — same encoded workspace gossip message the gossip path publishes. */
  payload: Uint8Array;
  members: readonly string[];
  /** Per-send timeout passed to `messenger.sendReliable`. */
  sendTimeoutMs: number;
  substrate: FanOutSubstrate;
  bookkeeper: FanOutBookkeeper;
}

export interface ExecuteSubstrateFanOutResult {
  /** Total number of substrate sends attempted (== members.length, kept for the WARN log). */
  attempted: number;
  /** Per-outcome counts, summed across all peers. */
  delivered: number;
  /** Permanent receiver-side rejections — sender drops, NOT counted as delivered (PR-C codex R6). */
  rejected: number;
  /**
   * Transient receiver-side rejections — sender does NOT count
   * as delivered; SwmAckQuorum's watchdog (PR-D) fires substrate
   * top-up at watchdogMs so upstream state has time to converge
   * before retry (codex follow-up from PR-G #G1, landed here).
   */
  retryable: number;
  queued: number;
  inFlight: number;
  failed: number;
}

/**
 * Fire `members.length` parallel substrate sends, classify each
 * outcome, hand it to the bookkeeper, and return aggregate
 * counts. Never throws — synchronous throws from `sendReliable`
 * are caught and counted as `failed`.
 *
 * Parallel execution is intentional (see module-level jsdoc); the
 * receiver's `SharedMemoryHandler.handle()` uses
 * `withWriteLocks([sharedMemoryGraphUri])` so concurrent arrivals
 * for the same CG are serialised at the apply layer — no risk of
 * interleaved partial writes from fan-out parallelism on the
 * sender side.
 */
export async function executeSubstrateFanOut(
  input: ExecuteSubstrateFanOutInput,
): Promise<ExecuteSubstrateFanOutResult> {
  const { contextGraphId, protocolId, payload, members, sendTimeoutMs, substrate, bookkeeper } = input;
  const result: ExecuteSubstrateFanOutResult = {
    attempted: members.length,
    delivered: 0,
    rejected: 0,
    retryable: 0,
    queued: 0,
    inFlight: 0,
    failed: 0,
  };

  if (members.length === 0) return result;

  await Promise.allSettled(members.map(async (peerId) => {
    let record: FanOutPeerRecord;
    try {
      const sendResult = await substrate.sendReliable(peerId, protocolId, payload, { timeoutMs: sendTimeoutMs });
      record = classifySendResult(peerId, sendResult);
    } catch (err) {
      record = {
        peerId,
        outcome: 'failed',
        attempts: 0,
        messageId: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
    switch (record.outcome) {
      case 'delivered':
        result.delivered += 1;
        break;
      case 'rejected':
        result.rejected += 1;
        break;
      case 'retryable':
        result.retryable += 1;
        break;
      case 'queued':
        result.queued += 1;
        break;
      case 'inFlight':
        result.inFlight += 1;
        break;
      case 'failed':
        result.failed += 1;
        break;
    }
    bookkeeper.recordOutcome(contextGraphId, record);
  }));

  return result;
}

/**
 * Map a `ReliableSendResult` (the messenger's send-time outcome)
 * onto the application-level {@link FanOutOutcome}. Exported so
 * the watchdog/top-up path (rc.9 PR-D #D6) can reuse the EXACT
 * same classification rules as the main fan-out — keeping
 * sentinel handling (`FANOUT_RESPONSE_REJECTED`,
 * `FANOUT_RESPONSE_RETRYABLE`), queued/inFlight policy, and
 * error-string conventions in a single place. Pure function;
 * no I/O.
 */
export function classifySendResult(peerId: string, sendResult: ReliableSendResult): FanOutPeerRecord {
  if (sendResult.delivered) {
    // PR-C codex R6: receivers signal permanent rejection (peer
    // not in allowlist, bad signature, validation failure) with
    // the single-byte FANOUT_RESPONSE_REJECTED sentinel response.
    // The substrate's `delivered: true` just means "got a normal
    // reply" — we have to peek at the payload to distinguish
    // "applied OK" from "explicitly dropped". Empty response =
    // applied (the historical default and PR-D's planned upgrade
    // path).
    if (isRejectionSentinel(sendResult.response)) {
      return {
        peerId,
        outcome: 'rejected',
        attempts: sendResult.attempts,
        messageId: sendResult.messageId,
        error: 'receiver returned FANOUT_RESPONSE_REJECTED sentinel (permanent rejection)',
      };
    }
    // rc.9 PR-D (codex follow-up from PR-G #G1): the 0x02
    // sentinel means TRANSIENT rejection — SwmAckQuorum's
    // watchdog will fire substrate top-up at watchdogMs.
    if (isRetryableSentinel(sendResult.response)) {
      return {
        peerId,
        outcome: 'retryable',
        attempts: sendResult.attempts,
        messageId: sendResult.messageId,
        error: 'receiver returned FANOUT_RESPONSE_RETRYABLE sentinel (transient rejection)',
      };
    }
    return {
      peerId,
      outcome: 'delivered',
      attempts: sendResult.attempts,
      messageId: sendResult.messageId,
      error: '',
    };
  }
  // delivered: false. Three sub-cases via the discriminator.
  if ('inFlight' in sendResult && sendResult.inFlight === true) {
    return {
      peerId,
      outcome: 'inFlight',
      attempts: sendResult.attempts,
      messageId: sendResult.messageId,
      error: sendResult.error,
    };
  }
  if ('queued' in sendResult && sendResult.queued === true) {
    return {
      peerId,
      outcome: 'queued',
      attempts: sendResult.attempts,
      messageId: sendResult.messageId,
      error: sendResult.error,
    };
  }
  // Defensive — the ReliableSendResult union currently only has
  // three variants (delivered / queued / inFlight). If a fourth
  // variant is ever added without updating this site, classify
  // it as `failed` so the substrate fan-out doesn't silently
  // double-count or lose track.
  return {
    peerId,
    outcome: 'failed',
    attempts: 0,
    messageId: '',
    error: 'unrecognised ReliableSendResult variant',
  };
}

/**
 * Does the substrate response equal {@link FANOUT_RESPONSE_REJECTED}?
 *
 * Direct `===` doesn't work because the response Uint8Array is
 * reconstructed by the substrate (decode path); we compare bytes
 * instead. Tight 1-byte check — anything else (empty for applied
 * OK, or future structured PR-D `SwmShareAck` payloads) is
 * treated as `delivered`.
 */
function isRejectionSentinel(response: Uint8Array | undefined): boolean {
  return response !== undefined && response.byteLength === 1 && response[0] === 0x01;
}

function isRetryableSentinel(response: Uint8Array | undefined): boolean {
  return response !== undefined && response.byteLength === 1 && response[0] === 0x02;
}
