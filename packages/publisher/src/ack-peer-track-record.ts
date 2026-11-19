import type { ACKPeerOutcomeReport, ACKPeerRoundOutcome } from './ack-peer-status-ledger.js';

/** How long one round's outcome for a core shapes later rounds. */
export const ACK_PEER_TRACK_RECORD_TTL_MS = 10 * 60_000;

/** Cores remembered at once; the least recently reported goes first. */
export const ACK_PEER_TRACK_RECORD_MAX_PEERS = 512;

export interface ACKCandidatePlan {
  /** Candidates to ask, in the order to ask them. */
  readonly peers: string[];
  /** Candidates left out because the chain recently said their ACK signer cannot count. */
  readonly ineligible: ReadonlySet<string>;
}

interface Entry {
  readonly outcome: ACKPeerRoundOutcome;
  readonly at: number;
}

/**
 * What the last ACK rounds showed about each core, kept across rounds so the
 * next round asks the cores that can answer and asks them in a useful order.
 *
 * - A core whose ACK signer the chain reported outside the sharding table (or
 *   without a registered key) is left out until the record expires, as long
 *   as enough cores remain for the quorum: its ACK cannot count, and checking
 *   it costs chain reads in every round.
 * - The rest are ordered: cores with a recent valid ACK first, fastest first;
 *   then cores with no recent record; then cores that recently declined or did
 *   not answer. Every remaining core is still asked; the round dials them all.
 *
 * Records come only from completed rounds: signature-checked ACKs and the
 * chain's verdict on the signer. Nothing a peer merely claims leaves it out.
 */
export class ACKPeerTrackRecord {
  readonly #entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = ACK_PEER_TRACK_RECORD_TTL_MS,
    private readonly maxPeers = ACK_PEER_TRACK_RECORD_MAX_PEERS,
  ) {}

  /** Keep one finished round's outcomes; a core's newest outcome replaces its older one. */
  record(reports: readonly ACKPeerOutcomeReport[]): void {
    const at = this.now();
    for (const { peerId, outcome } of reports) {
      this.#entries.delete(peerId);
      this.#entries.set(peerId, { outcome, at });
    }
    while (this.#entries.size > this.maxPeers) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  /** The core's latest unexpired outcome. */
  outcome(peerId: string): ACKPeerRoundOutcome | undefined {
    const entry = this.#entries.get(peerId);
    if (!entry) return undefined;
    if (this.now() - entry.at >= this.ttlMs) {
      this.#entries.delete(peerId);
      return undefined;
    }
    return entry.outcome;
  }

  /**
   * Order `candidates` (already eligible by role, protocol and admission) for
   * one round that needs `requiredACKs` valid ACKs. Ties keep their given order.
   */
  plan(candidates: readonly string[], requiredACKs: number): ACKCandidatePlan {
    const outcomes = new Map(candidates.map((peerId) => [peerId, this.outcome(peerId)] as const));
    const ineligible = candidates.filter((peerId) => outcomes.get(peerId)?.kind === 'ineligible-signer');
    // Never leave fewer candidates than the quorum: the round would fail before
    // asking anyone, where today it still reports every core's own answer.
    const left = candidates.length - ineligible.length >= requiredACKs ? new Set(ineligible) : new Set<string>();
    const rank = (outcome: ACKPeerRoundOutcome | undefined): number => {
      if (outcome === undefined) return 1;
      switch (outcome.kind) {
        case 'valid': return 0;
        case 'declined':
        case 'unanswered': return 2;
        case 'ineligible-signer': return 3;
      }
    };
    const latency = (outcome: ACKPeerRoundOutcome | undefined): number =>
      outcome?.kind === 'valid' ? outcome.latencyMs : 0;
    const peers = candidates
      .filter((peerId) => !left.has(peerId))
      .map((peerId, index) => ({ peerId, index, outcome: outcomes.get(peerId) }))
      .sort((a, b) => rank(a.outcome) - rank(b.outcome)
        || latency(a.outcome) - latency(b.outcome)
        || a.index - b.index)
      .map(({ peerId }) => peerId);
    return { peers, ineligible: left };
  }
}
