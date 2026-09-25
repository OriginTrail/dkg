import { PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';
import { isStorageACKProtocol, type StorageACKProtocol } from './storage-ack-protocols.js';
import { ACKCapabilityRegistry, type ACKCapabilitySnapshot } from './ack-capability.js';
import {
  selectACKCandidateUniverse,
  selectACKCandidatePeersWithDiagnostics,
  type ACKCandidatePeerSelectionInput,
  type ACKCandidatePeerSelectionResult,
} from '@origintrail-official/dkg-publisher';

export interface LocalACKCandidate {
  peerId: string;
  available: boolean;
}

export interface ACKRoundPorts {
  connectedPeers: readonly string[];
  ackCandidatePeerIds?: readonly string[];
  preferredACKPeerIds?: readonly string[];
  requiredACKs: number;
  protocol: string;
  localCandidate: LocalACKCandidate;
  verifiedSameNetworkPeerIds(): ReadonlySet<string> | undefined;
  getPeerProtocols(peerId: string): Promise<string[]>;
  preflight(peerIds: string[]): Promise<void>;
  isAcceptedPeer(peerId: string): boolean;
  probeProtocol?(peerId: string, protocol: string): Promise<'supported' | 'unsupported' | 'unavailable'>;
}

function rotated<T>(items: readonly T[], cursor: number): T[] {
  if (items.length === 0) return [];
  const offset = cursor % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

interface ACKRoundCandidatePlan {
  readonly raw: readonly string[];
  readonly confirmed: readonly string[];
  readonly unconfirmed: readonly string[];
  readonly admitted: readonly string[];
  readonly localAvailable: boolean;
}

/** One round universe, partitioned from a single capability snapshot. */
function planRoundCandidates(input: {
  raw: readonly string[];
  snapshot: ACKCapabilitySnapshot;
  protocol: StorageACKProtocol;
  accepted: ReadonlySet<string>;
  localAvailable: boolean;
}): ACKRoundCandidatePlan {
  const supported = input.snapshot.supportByProtocol.get(input.protocol) ?? new Set<string>();
  return {
    raw: input.raw,
    confirmed: input.raw.filter((peerId) => input.snapshot.corePeerIds.has(peerId)),
    unconfirmed: input.raw.filter((peerId) => !supported.has(peerId)),
    admitted: input.raw.filter((peerId) => supported.has(peerId) && input.accepted.has(peerId)),
    localAvailable: input.localAvailable,
  };
}

/** Rotate preferred and other probes while reserving slots for other peers. */
function scheduleProbeWindow(input: {
  unconfirmed: readonly string[];
  preferred: ReadonlySet<string>;
  protocol: StorageACKProtocol;
  preferredCursor: number;
  otherCursor: number;
}): string[] {
  const preferred = input.unconfirmed.filter((peerId) => input.preferred.has(peerId));
  const other = input.unconfirmed.filter((peerId) => !input.preferred.has(peerId));
  // A non-base probe may need a second core-role negotiation: 16 peers keep
  // the total at 32 protocol probes. Base rounds may probe 32 peers.
  const peerLimit = input.protocol === PROTOCOL_STORAGE_ACK ? 32 : 16;
  const preferredBudget = other.length > 0 && preferred.length >= peerLimit
    ? peerLimit - 8 : peerLimit;
  return [
    ...rotated(preferred, input.preferredCursor).slice(0, preferredBudget),
    ...rotated(other, input.otherCursor).slice(0, peerLimit - Math.min(preferred.length, preferredBudget)),
  ];
}

/** Bounded ACK discovery and final candidate planning for publish rounds. */
export class ACKCandidateDiscoveryCoordinator {
  private preferredProbeCursor = 0;
  private otherProbeCursor = 0;

  constructor(private readonly registry: ACKCapabilityRegistry) {}

  selectCandidates(
    input: Omit<ACKCandidatePeerSelectionInput, 'capability' | 'selfPeerId' | 'localCandidate'>,
    localCandidate: LocalACKCandidate,
    snapshot: ACKCapabilitySnapshot = this.registry.snapshot(),
  ): ACKCandidatePeerSelectionResult {
    const requestedProtocolPeers = input.protocol && input.protocol !== PROTOCOL_STORAGE_ACK && isStorageACKProtocol(input.protocol)
      ? snapshot.supportByProtocol.get(input.protocol)
      : undefined;
    return selectACKCandidatePeersWithDiagnostics({
      ...input,
      localCandidate,
      capability: { mode: 'require', corePeers: snapshot.corePeerIds, requestedProtocolPeers },
    });
  }

  async resolveRound(ports: ACKRoundPorts): Promise<ACKCandidatePeerSelectionResult> {
    if (!isStorageACKProtocol(ports.protocol)) throw new Error(`Unsupported ACK protocol: ${ports.protocol}`);
    const requestedProtocol = ports.protocol;
    await Promise.all(ports.connectedPeers.map(async (peerId) => {
      this.registry.observeIdentify(peerId, await ports.getPeerProtocols(peerId));
    }));
    // Keep preflight and final selection on this round's snapshot even if
    // peer:update changes the registry while the round is in progress.
    const round = this.registry.beginRound();
    const raw = Object.freeze(selectACKCandidateUniverse({
      connectedPeers: ports.connectedPeers,
      ackCandidatePeerIds: ports.ackCandidatePeerIds,
      selfPeerId: ports.localCandidate.peerId,
    }));
    const plan = (): ACKRoundCandidatePlan => planRoundCandidates({
      raw,
      snapshot: round.snapshot(),
      protocol: requestedProtocol,
      accepted: new Set(raw.filter((peerId) => ports.isAcceptedPeer(peerId))),
      localAvailable: ports.localCandidate.available,
    });
    await ports.preflight([...plan().confirmed]);

    // One spare beyond bare quorum lets the collector survive one candidate
    // decline or timeout without another discovery round.
    const target = ports.requiredACKs + 1;
    if (ports.probeProtocol) {
      const preferredIds = new Set(ports.preferredACKPeerIds ?? []);
      const chosen = scheduleProbeWindow({
        unconfirmed: plan().unconfirmed,
        preferred: preferredIds,
        protocol: requestedProtocol,
        preferredCursor: this.preferredProbeCursor,
        otherCursor: this.otherProbeCursor,
      });
      for (let offset = 0; offset < chosen.length; offset += 4) {
        const batch = chosen.slice(offset, offset + 4);
        // ACK preflight may bypass an automatic admission retry cooldown.
        // Without it, the router gate rejects an unknown peer before the
        // capability negotiation can discover a late StorageACK handler.
        await ports.preflight(batch);
        const discovered = (await Promise.all(batch.map(async (peerId) => {
          if (await ports.probeProtocol!(peerId, requestedProtocol) !== 'supported') return null;
          if (!round.supports(peerId, PROTOCOL_STORAGE_ACK)) {
            if (requestedProtocol !== PROTOCOL_STORAGE_ACK &&
                await ports.probeProtocol!(peerId, PROTOCOL_STORAGE_ACK) !== 'supported') return null;
            round.observeNegotiated(peerId, PROTOCOL_STORAGE_ACK);
          }
          round.observeNegotiated(peerId, requestedProtocol);
          return peerId;
        }))).filter((peerId): peerId is string => peerId !== null);
        this.preferredProbeCursor += batch.filter((peerId) => preferredIds.has(peerId)).length;
        this.otherProbeCursor += batch.filter((peerId) => !preferredIds.has(peerId)).length;
        if (discovered.length > 0) await ports.preflight(discovered);
        // Always sample at least one batch, even when advertised peers meet
        // target: advertisements do not prove valid independent ACK signers.
        const current = plan();
        if (current.admitted.length + Number(current.localAvailable) >= target) break;
      }
    }
    return this.selectCandidates({
      connectedPeers: ports.connectedPeers,
      ackCandidatePeerIds: ports.ackCandidatePeerIds,
      preferredACKPeerIds: ports.preferredACKPeerIds,
      verifiedSameNetworkPeerIds: ports.verifiedSameNetworkPeerIds(),
      requiredACKs: ports.requiredACKs,
      protocol: requestedProtocol,
    }, ports.localCandidate, round.snapshot());
  }
}
