import { bytesToHex, compareBytes, copyBytes, equalBytes } from './bytes.js';
import { RatelessIbltDecoder, type DecodeSnapshot } from './decoder.js';
import { RatelessIbltEncoder } from './encoder.js';
import { createFallbackPages, verifyFallbackPages, type IdFallbackPage } from './fallback.js';
import { PAPER_BASELINE_V0, validateCandidateProfile, type IbltCandidateProfile } from './profile.js';
import { setCommitment } from './set-commitment.js';

export type ReconciliationPath = 'equal' | 'iblt' | 'fallback';

export interface ReconciliationResult {
  path: ReconciliationPath;
  symbolsReceived: number;
  providerOnly: Uint8Array[];
  receiverOnly: Uint8Array[];
  providerRoot: Uint8Array;
  fallbackPages?: IdFallbackPage[];
  decode?: DecodeSnapshot;
}

export interface ReconciliationOptions {
  profile?: IbltCandidateProfile;
  forceIbltForEmptyReceiver?: boolean;
  fallbackPageSize?: number;
}

export function applyDecodedDifference(
  receiverIds: readonly Uint8Array[],
  providerOnly: readonly Uint8Array[],
  receiverOnly: readonly Uint8Array[]
): Uint8Array[] {
  const reconstructed = new Map(receiverIds.map((id) => [bytesToHex(id), copyBytes(id)]));
  if (reconstructed.size !== receiverIds.length) throw new RangeError('receiver set contains duplicate IDs');
  for (const id of receiverOnly) {
    const key = bytesToHex(id);
    if (!reconstructed.delete(key)) throw new RangeError(`decoded receiver-only ID is absent: ${key}`);
  }
  for (const id of providerOnly) {
    const key = bytesToHex(id);
    if (reconstructed.has(key)) throw new RangeError(`decoded provider-only ID already exists: ${key}`);
    reconstructed.set(key, copyBytes(id));
  }
  return [...reconstructed.values()].sort(compareBytes);
}

export function verifyDecodedDifference(
  receiverIds: readonly Uint8Array[],
  decoded: DecodeSnapshot,
  providerCount: number,
  providerRoot: Uint8Array
): void {
  if (!decoded.complete) throw new RangeError('cannot accept an incomplete IBLT decode');
  const reconstructed = applyDecodedDifference(receiverIds, decoded.providerOnly, decoded.receiverOnly);
  if (reconstructed.length !== providerCount) throw new RangeError('reconstructed provider count mismatch');
  if (!equalBytes(setCommitment(reconstructed), providerRoot)) {
    throw new RangeError('reconstructed provider root mismatch');
  }
}

function fallbackResult(
  providerIds: readonly Uint8Array[],
  providerRoot: Uint8Array,
  symbolsReceived: number,
  pageSize: number
): ReconciliationResult {
  const fallbackPages = createFallbackPages(providerIds, pageSize);
  verifyFallbackPages(fallbackPages, providerIds.length, providerRoot);
  return {
    path: 'fallback',
    symbolsReceived,
    providerOnly: [],
    receiverOnly: [],
    providerRoot,
    fallbackPages
  };
}

export function reconcileSets(
  providerIds: readonly Uint8Array[],
  receiverIds: readonly Uint8Array[],
  reconciliationSeed: Uint8Array,
  options: ReconciliationOptions = {}
): ReconciliationResult {
  const profile = options.profile ?? PAPER_BASELINE_V0;
  const pageSize = options.fallbackPageSize ?? 1024;
  validateCandidateProfile(profile);
  const providerRoot = setCommitment(providerIds);
  const receiverRoot = setCommitment(receiverIds);
  if (providerIds.length === receiverIds.length && equalBytes(providerRoot, receiverRoot)) {
    return {
      path: 'equal',
      symbolsReceived: 0,
      providerOnly: [],
      receiverOnly: [],
      providerRoot
    };
  }
  if (
    receiverIds.length === 0 &&
    profile.fallback.preferEnumerationWhenReceiverCountIsZero &&
    options.forceIbltForEmptyReceiver !== true
  ) {
    return fallbackResult(providerIds, providerRoot, 0, pageSize);
  }

  const encoder = new RatelessIbltEncoder(providerIds, reconciliationSeed, profile.mapping);
  const decoder = new RatelessIbltDecoder(
    receiverIds,
    reconciliationSeed,
    profile.mapping,
    profile.fallback.maximumDecodedDifference
  );
  let nextWindow = profile.stream.initialWindowSymbols;
  while (decoder.receivedSymbols < profile.stream.maximumSymbols) {
    const remaining = profile.stream.maximumSymbols - decoder.receivedSymbols;
    decoder.addProviderWindow(encoder.produceWindow(Math.min(nextWindow, remaining)));
    if (decoder.complete) {
      const decoded = decoder.snapshot();
      verifyDecodedDifference(receiverIds, decoded, providerIds.length, providerRoot);
      return {
        path: 'iblt',
        symbolsReceived: decoder.receivedSymbols,
        providerOnly: decoded.providerOnly,
        receiverOnly: decoded.receiverOnly,
        providerRoot,
        decode: decoded
      };
    }
    nextWindow = Math.max(
      1,
      Math.ceil(nextWindow * profile.stream.windowGrowthNumerator / profile.stream.windowGrowthDenominator)
    );
  }
  return fallbackResult(providerIds, providerRoot, decoder.receivedSymbols, pageSize);
}
