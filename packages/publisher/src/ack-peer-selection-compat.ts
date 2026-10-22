import { PROTOCOL_STORAGE_ACK_V2, PROTOCOL_STORAGE_UPDATE_ACK_V2, isStorageACKProtocol } from '@origintrail-official/dkg-core';
import {
  selectCanonicalACKCandidateUniverse,
  selectCanonicalACKCandidatePeersWithDiagnostics,
  type ACKCanonicalCandidatePeerSelectionInput,
  type ACKCanonicalCandidatePeerDiagnostic,
} from './ack-peer-selection.js';

type LegacyACKCandidatePeerSelectionInput = Omit<ACKCanonicalCandidatePeerSelectionInput, 'capability'> & {
  capability?: never;
  knownCorePeerIds?: ReadonlySet<string>;
  knownCorePeerIdsV2?: ReadonlySet<string>;
  /** Historical parameter; selection never truncates candidates to a quorum. */
  requiredACKs?: number;
};

type CapabilityACKCandidatePeerSelectionInput = ACKCanonicalCandidatePeerSelectionInput & {
  knownCorePeerIds?: never;
  knownCorePeerIdsV2?: never;
  /** Historical parameter; selection never truncates candidates to a quorum. */
  requiredACKs?: number;
};

/** @deprecated Use the canonical selector with `capability`. */
export type ACKCandidatePeerSelectionInput =
  | LegacyACKCandidatePeerSelectionInput
  | CapabilityACKCandidatePeerSelectionInput;

type WithoutRequiredACKs<T> = T extends unknown ? Omit<T, 'requiredACKs'> : never;

export interface ACKCandidatePeerDiagnostic extends Omit<ACKCanonicalCandidatePeerDiagnostic, 'tier'> {
  tier: ACKCanonicalCandidatePeerDiagnostic['tier'] | 'v2Advertised';
}

export interface ACKCandidatePeerSelectionResult {
  peers: string[];
  diagnostics: ACKCandidatePeerDiagnostic[];
}

function adaptLegacyInput(input: ACKCandidatePeerSelectionInput): {
  canonical: ACKCanonicalCandidatePeerSelectionInput;
  legacyV2Tier: boolean;
} {
  if (input.protocol !== undefined && !isStorageACKProtocol(input.protocol)) {
    throw new Error(`Unsupported StorageACK protocol: ${input.protocol}`);
  }
  if (input.capability && (input.knownCorePeerIds || input.knownCorePeerIdsV2)) {
    throw new TypeError('Use either capability or legacy knownCorePeerIds fields');
  }
  const {
    knownCorePeerIds: _knownCorePeerIds,
    knownCorePeerIdsV2: _knownCorePeerIdsV2,
    requiredACKs: _requiredACKs,
    ...rest
  } = input;
  if (input.capability) return { canonical: rest, legacyV2Tier: false };
  if (!input.knownCorePeerIds && !input.knownCorePeerIdsV2) {
    return { canonical: rest, legacyV2Tier: false };
  }
  const requestedProtocolPeers = input.protocol === PROTOCOL_STORAGE_ACK_V2
    || input.protocol === PROTOCOL_STORAGE_UPDATE_ACK_V2
    ? input.knownCorePeerIdsV2 ?? new Set<string>()
    : undefined;
  return {
    canonical: { ...rest, capability: { mode: 'rank', corePeers: input.knownCorePeerIds, requestedProtocolPeers } },
    legacyV2Tier: requestedProtocolPeers !== undefined,
  };
}

/** @deprecated Use selectCanonicalACKCandidateUniverse. */
export function selectACKCandidateUniverse(input: WithoutRequiredACKs<ACKCandidatePeerSelectionInput>): string[] {
  return selectCanonicalACKCandidateUniverse(adaptLegacyInput(input).canonical);
}

/** @deprecated Compatibility adapter for callers using knownCorePeerIds. */
export function selectACKCandidatePeersWithDiagnostics(
  input: ACKCandidatePeerSelectionInput,
): ACKCandidatePeerSelectionResult {
  const { canonical, legacyV2Tier } = adaptLegacyInput(input);
  const result = selectCanonicalACKCandidatePeersWithDiagnostics(canonical);
  if (!legacyV2Tier) return result;
  return {
    peers: result.peers,
    diagnostics: result.diagnostics.map((diagnostic) => diagnostic.tier === 'requestedProtocol'
      ? { ...diagnostic, tier: 'v2Advertised' }
      : diagnostic),
  };
}

/** @deprecated Use selectCanonicalACKCandidatePeersWithDiagnostics. */
export function selectACKCandidatePeers(input: ACKCandidatePeerSelectionInput): string[] {
  return selectACKCandidatePeersWithDiagnostics(input).peers;
}
