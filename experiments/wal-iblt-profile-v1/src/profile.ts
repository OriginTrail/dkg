export interface MappingProfile {
  multiplier: bigint;
  indexOffset: number;
  inverseSqrtNumerator: number;
}

export interface StreamProfile {
  initialWindowSymbols: number;
  windowGrowthNumerator: number;
  windowGrowthDenominator: number;
  maximumSymbols: number;
}

export interface FallbackProfile {
  preferEnumerationWhenReceiverCountIsZero: boolean;
  maximumDecodedDifference: number;
  maximumOverheadRatio: number;
}

export interface IbltCandidateProfile {
  profileName: string;
  mapping: MappingProfile;
  stream: StreamProfile;
  fallback: FallbackProfile;
}

export const PAPER_BASELINE_V0: IbltCandidateProfile = Object.freeze({
  profileName: 'paper-baseline-v0',
  mapping: Object.freeze({
    multiplier: 0xda94_2042_e4dd_58b5n,
    indexOffset: 1.5,
    inverseSqrtNumerator: 2 ** 32
  }),
  stream: Object.freeze({
    initialWindowSymbols: 32,
    windowGrowthNumerator: 2,
    windowGrowthDenominator: 1,
    maximumSymbols: 1_048_576
  }),
  fallback: Object.freeze({
    preferEnumerationWhenReceiverCountIsZero: true,
    maximumDecodedDifference: 250_000,
    maximumOverheadRatio: 2.5
  })
});

export function validateCandidateProfile(profile: IbltCandidateProfile): void {
  const { mapping, stream, fallback } = profile;
  if (mapping.multiplier <= 0n || mapping.multiplier > 0xffff_ffff_ffff_ffffn || mapping.multiplier % 2n === 0n) {
    throw new RangeError('mapping multiplier must be an odd unsigned 64-bit integer');
  }
  if (!Number.isFinite(mapping.indexOffset) || mapping.indexOffset <= 0) {
    throw new RangeError('mapping indexOffset must be finite and positive');
  }
  if (!Number.isFinite(mapping.inverseSqrtNumerator) || mapping.inverseSqrtNumerator <= 0) {
    throw new RangeError('mapping inverseSqrtNumerator must be finite and positive');
  }
  for (const [name, value] of Object.entries({
    initialWindowSymbols: stream.initialWindowSymbols,
    windowGrowthNumerator: stream.windowGrowthNumerator,
    windowGrowthDenominator: stream.windowGrowthDenominator,
    maximumSymbols: stream.maximumSymbols,
    maximumDecodedDifference: fallback.maximumDecodedDifference
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  }
  if (!Number.isFinite(fallback.maximumOverheadRatio) || fallback.maximumOverheadRatio <= 1) {
    throw new RangeError('maximumOverheadRatio must be finite and greater than one');
  }
}

validateCandidateProfile(PAPER_BASELINE_V0);
