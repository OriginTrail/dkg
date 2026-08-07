import { bytesToHex, compareBytes, equalBytes } from './bytes.js';
import type { ReconciliationUsage } from './budget.js';
import { RatelessIbltDecoder, type DecodeSnapshot } from './decoder.js';
import { RatelessIbltEncoder } from './encoder.js';
import { ReconciliationError, isReconciliationError, type ReconciliationErrorCode } from './errors.js';
import { createFallbackPages, verifyFallbackPages, type IdFallbackPage } from './fallback.js';
import type { ReconciliationHead } from './head.js';
import { verifySetAgainstHead } from './head.js';
import { walObjectId, type ReconciliationSeed, type SetCommitmentRoot, type WalObjectId } from './ids.js';
import {
  PAPER_BASELINE_V0,
  validateReconciliationConfiguration,
  type ReconciliationConfiguration
} from './configuration.js';
import { setCommitment } from './set-commitment.js';

export type ReconciliationPath = 'equal' | 'iblt' | 'fallback';

export interface ReconciliationResult {
  path: ReconciliationPath;
  symbolsReceived: number;
  providerOnly: WalObjectId[];
  receiverOnly: WalObjectId[];
  providerRoot: SetCommitmentRoot;
  providerHead: ReconciliationHead;
  fallbackReason?: ReconciliationErrorCode | 'EMPTY_RECEIVER' | 'OVERHEAD_POLICY';
  fallbackPages?: IdFallbackPage[];
  decode?: DecodeSnapshot;
  encoderUsage?: ReconciliationUsage;
  decoderUsage?: ReconciliationUsage;
}

export interface ReconciliationOptions {
  configuration?: ReconciliationConfiguration;
  forceIbltForEmptyReceiver?: boolean;
  fallbackPageSize?: number;
}

const RESOURCE_LIMIT_CODES = new Set<ReconciliationErrorCode>([
  'SYMBOL_LIMIT',
  'OPERATION_LIMIT',
  'MEMORY_LIMIT',
  'ELAPSED_TIME_LIMIT',
  'DECODED_DIFFERENCE_LIMIT'
]);

function uniqueIdMap(ids: readonly WalObjectId[], label: string): Map<string, WalObjectId> {
  const output = new Map<string, WalObjectId>();
  for (const id of ids) {
    const copy = walObjectId(id);
    const key = bytesToHex(copy);
    if (output.has(key)) {
      throw new ReconciliationError('DUPLICATE_WAL_OBJECT_ID', `${label} contains duplicate WalObjectId: ${key}`);
    }
    output.set(key, copy);
  }
  return output;
}

export function applyDecodedDifference(
  receiverIds: readonly WalObjectId[],
  providerOnly: readonly WalObjectId[],
  receiverOnly: readonly WalObjectId[]
): WalObjectId[] {
  const reconstructed = uniqueIdMap(receiverIds, 'receiver set');
  for (const id of receiverOnly) {
    const key = bytesToHex(id);
    if (!reconstructed.delete(key)) {
      throw new ReconciliationError('ROOT_MISMATCH', `decoded receiver-only ID is absent: ${key}`);
    }
  }
  for (const id of providerOnly) {
    const key = bytesToHex(id);
    if (reconstructed.has(key)) {
      throw new ReconciliationError('ROOT_MISMATCH', `decoded provider-only ID already exists: ${key}`);
    }
    reconstructed.set(key, walObjectId(id));
  }
  return [...reconstructed.values()].sort(compareBytes);
}

export function verifyDecodedDifference(
  receiverIds: readonly WalObjectId[],
  decoded: DecodeSnapshot,
  providerHead: ReconciliationHead
): void {
  if (!decoded.complete) {
    throw new ReconciliationError('INCOMPLETE_DECODE', 'cannot accept an incomplete IBLT decode');
  }
  const reconstructed = applyDecodedDifference(receiverIds, decoded.providerOnly, decoded.receiverOnly);
  verifySetAgainstHead(reconstructed, providerHead);
}

function fallbackResult(
  providerIds: readonly WalObjectId[],
  providerHead: ReconciliationHead,
  symbolsReceived: number,
  pageSize: number,
  reason: ReconciliationResult['fallbackReason'],
  encoderUsage?: ReconciliationUsage,
  decoderUsage?: ReconciliationUsage
): ReconciliationResult {
  const fallbackPages = createFallbackPages(providerIds, providerHead, pageSize);
  verifyFallbackPages(fallbackPages, providerHead);
  return {
    path: 'fallback',
    symbolsReceived,
    providerOnly: [],
    receiverOnly: [],
    providerRoot: providerHead.objectSetRoot,
    providerHead,
    fallbackReason: reason,
    fallbackPages,
    encoderUsage,
    decoderUsage
  };
}

export function reconcileSets(
  providerIds: readonly WalObjectId[],
  receiverIds: readonly WalObjectId[],
  reconciliationSeed: ReconciliationSeed,
  providerHead: ReconciliationHead,
  options: ReconciliationOptions = {}
): ReconciliationResult {
  const configuration = options.configuration ?? PAPER_BASELINE_V0;
  const pageSize = options.fallbackPageSize ?? 1024;
  validateReconciliationConfiguration(configuration);
  verifySetAgainstHead(providerIds, providerHead);
  const receiverRoot = setCommitment(receiverIds);
  if (providerIds.length === receiverIds.length && equalBytes(providerHead.objectSetRoot, receiverRoot)) {
    return {
      path: 'equal',
      symbolsReceived: 0,
      providerOnly: [],
      receiverOnly: [],
      providerRoot: providerHead.objectSetRoot,
      providerHead
    };
  }
  if (
    receiverIds.length === 0 &&
    configuration.fallback.preferEnumerationWhenReceiverCountIsZero &&
    options.forceIbltForEmptyReceiver !== true
  ) {
    return fallbackResult(providerIds, providerHead, 0, pageSize, 'EMPTY_RECEIVER');
  }

  let encoder: RatelessIbltEncoder | undefined;
  let decoder: RatelessIbltDecoder | undefined;
  try {
    encoder = new RatelessIbltEncoder({
      ids: providerIds,
      reconciliationSeed,
      algorithm: configuration.algorithm,
      limits: configuration.limits
    });
    decoder = new RatelessIbltDecoder({
      receiverIds,
      reconciliationSeed,
      algorithm: configuration.algorithm,
      limits: configuration.limits
    });
    let nextWindow = configuration.stream.initialWindowSymbols;
    while (decoder.receivedSymbols < configuration.limits.maximumSymbols) {
      const remaining = configuration.limits.maximumSymbols - decoder.receivedSymbols;
      decoder.addProviderWindow(encoder.produceWindow(Math.min(nextWindow, remaining)));
      if (decoder.complete) {
        const decoded = decoder.snapshot();
        verifyDecodedDifference(receiverIds, decoded, providerHead);
        return {
          path: 'iblt',
          symbolsReceived: decoder.receivedSymbols,
          providerOnly: decoded.providerOnly,
          receiverOnly: decoded.receiverOnly,
          providerRoot: providerHead.objectSetRoot,
          providerHead,
          decode: decoded,
          encoderUsage: encoder.usage,
          decoderUsage: decoder.usage
        };
      }
      const decodedIds = decoder.decodedDifferenceSize;
      if (
        decodedIds > 0 &&
        decoder.receivedSymbols > decodedIds * configuration.fallback.maximumOverheadRatio
      ) {
        return fallbackResult(
          providerIds,
          providerHead,
          decoder.receivedSymbols,
          pageSize,
          'OVERHEAD_POLICY',
          encoder.usage,
          decoder.usage
        );
      }
      nextWindow = Math.max(
        1,
        Math.ceil(
          nextWindow * configuration.stream.windowGrowthNumerator /
          configuration.stream.windowGrowthDenominator
        )
      );
    }
    return fallbackResult(
      providerIds,
      providerHead,
      decoder.receivedSymbols,
      pageSize,
      'SYMBOL_LIMIT',
      encoder.usage,
      decoder.usage
    );
  } catch (error) {
    if (isReconciliationError(error) && RESOURCE_LIMIT_CODES.has(error.code)) {
      return fallbackResult(
        providerIds,
        providerHead,
        decoder?.receivedSymbols ?? 0,
        pageSize,
        error.code,
        encoder?.usage,
        decoder?.usage
      );
    }
    throw error;
  }
}
