import { DEFAULT_RECONCILIATION_LIMITS, validateReconciliationLimits, type ReconciliationLimits } from './budget.js';
import { ReconciliationError } from './errors.js';

export interface RatelessMappingParameters {
  multiplier: bigint;
  indexOffset: number;
  inverseSqrtNumerator: number;
  arithmetic?: 'binary64' | 'integer-v1';
}

export interface ProtocolV1IbltReconciliationAlgorithm {
  readonly name: 'ProtocolV1IbltReconciliationAlgorithm';
  readonly version: 1;
  readonly mapping: Readonly<RatelessMappingParameters>;
  readonly idLength: 32;
  readonly checksumLength: 32;
  readonly countEncoding: 'signed-i64';
  readonly symbolEncoding: 'deterministic-cbor-tuple-v1';
  readonly peelOrder: 'lowest-symbol-index-first';
}

export interface ReconciliationStreamPolicy {
  initialWindowSymbols: number;
  windowGrowthNumerator: number;
  windowGrowthDenominator: number;
}

export interface ReconciliationFallbackPolicy {
  preferEnumerationWhenReceiverCountIsZero: boolean;
  maximumOverheadRatio: number;
}

export interface ReconciliationConfiguration {
  candidateName: string;
  algorithm: ProtocolV1IbltReconciliationAlgorithm;
  stream: Readonly<ReconciliationStreamPolicy>;
  fallback: Readonly<ReconciliationFallbackPolicy>;
  limits: Readonly<ReconciliationLimits>;
}

export const PROTOCOL_V1_IBLT_RECONCILIATION_ALGORITHM: ProtocolV1IbltReconciliationAlgorithm = Object.freeze({
  name: 'ProtocolV1IbltReconciliationAlgorithm',
  version: 1,
  mapping: Object.freeze({
    multiplier: 0xda94_2042_e4dd_58b5n,
    indexOffset: 1.5,
    inverseSqrtNumerator: 2 ** 32
  }),
  idLength: 32,
  checksumLength: 32,
  countEncoding: 'signed-i64',
  symbolEncoding: 'deterministic-cbor-tuple-v1',
  peelOrder: 'lowest-symbol-index-first'
});

export const PAPER_BASELINE_V0: ReconciliationConfiguration = Object.freeze({
  candidateName: 'paper-baseline-v0',
  algorithm: PROTOCOL_V1_IBLT_RECONCILIATION_ALGORITHM,
  stream: Object.freeze({
    initialWindowSymbols: 32,
    windowGrowthNumerator: 2,
    windowGrowthDenominator: 1
  }),
  fallback: Object.freeze({
    preferEnumerationWhenReceiverCountIsZero: true,
    maximumOverheadRatio: 2.5
  }),
  limits: DEFAULT_RECONCILIATION_LIMITS
});

export const INTEGER_ONLY_V1_CANDIDATE: ReconciliationConfiguration = Object.freeze({
  ...PAPER_BASELINE_V0,
  candidateName: 'integer-only-v1-candidate',
  algorithm: Object.freeze({
    ...PAPER_BASELINE_V0.algorithm,
    mapping: Object.freeze({
      ...PAPER_BASELINE_V0.algorithm.mapping,
      arithmetic: 'integer-v1' as const
    })
  })
});

export function validateReconciliationConfiguration(configuration: ReconciliationConfiguration): void {
  const { algorithm, stream, fallback } = configuration;
  if (configuration.candidateName.trim().length === 0) {
    throw new ReconciliationError('INVALID_CONFIGURATION', 'candidateName must not be empty');
  }
  if (algorithm.name !== 'ProtocolV1IbltReconciliationAlgorithm' || algorithm.version !== 1) {
    throw new ReconciliationError('INVALID_CONFIGURATION', 'unsupported reconciliation algorithm');
  }
  if (
    algorithm.idLength !== 32 ||
    algorithm.checksumLength !== 32 ||
    algorithm.countEncoding !== 'signed-i64' ||
    algorithm.symbolEncoding !== 'deterministic-cbor-tuple-v1' ||
    algorithm.peelOrder !== 'lowest-symbol-index-first'
  ) {
    throw new ReconciliationError('INVALID_CONFIGURATION', 'invalid ProtocolV1 IBLT wire invariant');
  }
  const mapping = algorithm.mapping;
  if (mapping.multiplier <= 0n || mapping.multiplier > 0xffff_ffff_ffff_ffffn || mapping.multiplier % 2n === 0n) {
    throw new ReconciliationError('INVALID_CONFIGURATION', 'mapping multiplier must be an odd unsigned 64-bit integer');
  }
  if (!Number.isFinite(mapping.indexOffset) || mapping.indexOffset <= 0) {
    throw new ReconciliationError('INVALID_CONFIGURATION', 'mapping indexOffset must be finite and positive');
  }
  if (!Number.isFinite(mapping.inverseSqrtNumerator) || mapping.inverseSqrtNumerator <= 0) {
    throw new ReconciliationError('INVALID_CONFIGURATION', 'mapping inverseSqrtNumerator must be finite and positive');
  }
  if (
    mapping.arithmetic !== undefined &&
    mapping.arithmetic !== 'binary64' &&
    mapping.arithmetic !== 'integer-v1'
  ) {
    throw new ReconciliationError('INVALID_CONFIGURATION', 'mapping arithmetic must be binary64 or integer-v1');
  }
  for (const [name, value] of Object.entries(stream)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ReconciliationError('INVALID_CONFIGURATION', `${name} must be a positive safe integer`);
    }
  }
  if (!Number.isFinite(fallback.maximumOverheadRatio) || fallback.maximumOverheadRatio <= 1) {
    throw new ReconciliationError('INVALID_CONFIGURATION', 'maximumOverheadRatio must be finite and greater than one');
  }
  if (typeof fallback.preferEnumerationWhenReceiverCountIsZero !== 'boolean') {
    throw new ReconciliationError(
      'INVALID_CONFIGURATION',
      'preferEnumerationWhenReceiverCountIsZero must be boolean'
    );
  }
  validateReconciliationLimits(configuration.limits);
}

validateReconciliationConfiguration(PAPER_BASELINE_V0);
validateReconciliationConfiguration(INTEGER_ONLY_V1_CANDIDATE);
