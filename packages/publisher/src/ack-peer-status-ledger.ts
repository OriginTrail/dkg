import type { CollectedACK } from './ack-collector.js';
import type { PeerOutcome } from './ack-errors.js';

type PeerStatus =
  | { kind: 'ack'; ack: CollectedACK; latencyMs: number }
  | { kind: 'storage-decline'; code: string; message: string }
  | { kind: 'ack-validation'; reason: string }
  | { kind: 'protocol-unsupported'; message: string }
  | { kind: 'transport-error'; message: string };

/**
 * One asked core's outcome in a finished ACK round, as the publisher keeps it
 * across rounds (ack-peer-track-record.ts). A core still unanswered when the
 * quorum settled reports nothing: it was slower, not failing.
 */
export type ACKPeerRoundOutcome =
  /** A counted ACK, `latencyMs` after the round started (signer check included). */
  | { readonly kind: 'valid'; readonly latencyMs: number }
  /** The chain said this core's ACK signer cannot count (not in the sharding table, key not registered). */
  | { readonly kind: 'ineligible-signer'; readonly reason: string }
  /** It declined, sent an ACK that failed validation, or does not speak the protocol. */
  | { readonly kind: 'declined'; readonly code: string }
  /** No reply: the transport failed or timed out on every attempt. */
  | { readonly kind: 'unanswered' };

export interface ACKPeerOutcomeReport {
  readonly peerId: string;
  readonly outcome: ACKPeerRoundOutcome;
}

/** Receives every asked core's outcome once a round is decided. */
export type ACKPeerOutcomesObserver = (reports: readonly ACKPeerOutcomeReport[]) => void;

/** Chain verdicts on a signer's identity that hold whatever the core signs. */
const INELIGIBLE_SIGNER_VERDICTS = new Set(['ACK_VERIFY:not-in-sharding-table', 'ACK_VERIFY:key-not-registered']);

export interface ACKCandidateCounts {
  total: number;
  ack: number;
  declined: number;
  invalid: number;
  unsupported: number;
  transport: number;
  pending: number;
}

const counterByStatus = {
  ack: 'ack', 'storage-decline': 'declined', 'ack-validation': 'invalid',
  'protocol-unsupported': 'unsupported', 'transport-error': 'transport',
} satisfies Record<PeerStatus['kind'], Exclude<keyof ACKCandidateCounts, 'total' | 'pending'>>;

/**
 * Owns the terminal status for every peer participating in one ACK round.
 * Recording a new status replaces stale evidence from an earlier attempt, and
 * its projections keep structured telemetry and legacy operator text in
 * sync as new status categories are added.
 */
export class PeerStatusLedger {
  private readonly statuses = new Map<string, PeerStatus>();
  private readonly startedAt: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAt = now();
  }

  recordACK(ack: CollectedACK): void {
    this.statuses.set(ack.peerId, { kind: 'ack', ack, latencyMs: Math.max(0, this.now() - this.startedAt) });
  }

  recordStorageDecline(peerId: string, code: string, message: string): void {
    this.statuses.set(peerId, { kind: 'storage-decline', code, message });
  }

  recordACKValidation(peerId: string, reason: string): void {
    this.statuses.set(peerId, { kind: 'ack-validation', reason });
  }

  recordProtocolUnsupported(peerId: string, message: string): void {
    this.statuses.set(peerId, { kind: 'protocol-unsupported', message });
  }

  recordTransportError(peerId: string, message: string): void {
    this.statuses.set(peerId, { kind: 'transport-error', message });
  }

  clear(peerId: string): void {
    this.statuses.delete(peerId);
  }

  /**
   * The round is decided: report each asked core's outcome to `observer`
   * (when given; its errors never reach the round) and return the counts.
   */
  settle(corePeers: readonly string[], observer?: ACKPeerOutcomesObserver): ACKCandidateCounts {
    if (observer) {
      try { observer(this.outcomes(corePeers)); } catch { /* observation cannot change ACK decisions */ }
    }
    return this.counts(corePeers);
  }

  /** Each asked core's outcome; one with no terminal status, or only our own failed signer read, reports none. */
  outcomes(corePeers: readonly string[]): ACKPeerOutcomeReport[] {
    const reports: ACKPeerOutcomeReport[] = [];
    for (const peerId of corePeers) {
      const status = this.statuses.get(peerId);
      if (!status) continue;
      switch (status.kind) {
        case 'ack':
          reports.push({ peerId, outcome: { kind: 'valid', latencyMs: status.latencyMs } });
          break;
        case 'ack-validation':
          if (INELIGIBLE_SIGNER_VERDICTS.has(status.reason)) {
            reports.push({ peerId, outcome: { kind: 'ineligible-signer', reason: status.reason } });
          } else if (!status.reason.startsWith('ACK_VERIFY:')) {
            reports.push({ peerId, outcome: { kind: 'declined', code: status.reason } });
          }
          break;
        case 'storage-decline':
          reports.push({ peerId, outcome: { kind: 'declined', code: status.code } });
          break;
        case 'protocol-unsupported':
          reports.push({ peerId, outcome: { kind: 'declined', code: 'PROTOCOL_UNSUPPORTED' } });
          break;
        case 'transport-error':
          reports.push({ peerId, outcome: { kind: 'unanswered' } });
          break;
      }
    }
    return reports;
  }

  /** Aggregate the frozen candidate scope directly from typed terminal states. */
  counts(corePeers: readonly string[]): ACKCandidateCounts {
    const counts: ACKCandidateCounts = { total: corePeers.length, ack: 0, declined: 0,
      invalid: 0, unsupported: 0, transport: 0, pending: 0 };
    for (const peerId of corePeers) {
      const status = this.statuses.get(peerId);
      if (status) counts[counterByStatus[status.kind]]++;
      else counts.pending++;
    }
    return counts;
  }

  snapshot(corePeers: string[]): PeerOutcome[] {
    return corePeers.map((peerId): PeerOutcome => {
      const status = this.statuses.get(peerId);
      if (!status) return { peerId, reason: 'no_response' };
      switch (status.kind) {
        case 'ack': {
          const advertised = status.ack.subscriptionSource !== undefined ? true : undefined;
          return {
            peerId,
            dialOk: true,
            protocolSupported: true,
            ...(advertised !== undefined ? { swmHostModeAdvertised: advertised } : {}),
            reason: status.ack.subscriptionSource
              ? `ACK:${status.ack.subscriptionSource}`
              : 'ACK',
          };
        }
        case 'storage-decline':
          return {
            peerId,
            dialOk: true,
            protocolSupported: true,
            reason: `STORAGE_ACK_DECLINE:${status.code}`,
          };
        case 'ack-validation':
          return {
            peerId,
            dialOk: true,
            protocolSupported: true,
            reason: status.reason,
          };
        case 'protocol-unsupported':
          return {
            peerId,
            dialOk: true,
            protocolSupported: false,
            reason: 'PROTOCOL_UNSUPPORTED',
          };
        case 'transport-error':
          return { peerId, dialOk: false, reason: 'TRANSPORT_ERROR' };
      }
    });
  }

  formatLegacyDetail(): string {
    const declineDetails: string[] = [];
    const terminalDetails: string[] = [];
    for (const [peerId, status] of this.statuses) {
      const tagPrefix = peerId.slice(-8);
      if (status.kind === 'storage-decline') {
        const tag = `${tagPrefix}→${status.code}`;
        declineDetails.push(status.message ? `${tag} (${status.message})` : tag);
      } else if (status.kind === 'protocol-unsupported' || status.kind === 'transport-error') {
        const code = status.kind === 'protocol-unsupported'
          ? 'PROTOCOL_UNSUPPORTED'
          : 'TRANSPORT_ERROR';
        const tag = `${tagPrefix}→${code}`;
        terminalDetails.push(status.message ? `${tag} (${status.message})` : tag);
      }
    }
    const formatted = [...declineDetails, ...terminalDetails].join('; ');
    return formatted ? ` Declines: ${formatted}.` : '';
  }
}
