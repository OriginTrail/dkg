import type { CollectedACK } from './ack-collector.js';
import type { PeerOutcome } from './ack-errors.js';

type PeerStatus =
  | { kind: 'ack'; ack: CollectedACK }
  | { kind: 'storage-decline'; code: string; message: string }
  | { kind: 'ack-validation'; reason: string }
  | { kind: 'protocol-unsupported'; message: string }
  | { kind: 'transport-error'; message: string };

/**
 * Owns the terminal status for every peer participating in one ACK round.
 * Recording a new status replaces stale evidence from an earlier attempt, and
 * the two projections keep structured telemetry and legacy operator text in
 * sync as new status categories are added.
 */
export class PeerStatusLedger {
  private readonly statuses = new Map<string, PeerStatus>();

  recordACK(ack: CollectedACK): void {
    this.statuses.set(ack.peerId, { kind: 'ack', ack });
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
