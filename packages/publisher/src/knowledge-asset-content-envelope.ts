import type { KnowledgeAssetVmPublishRequest, LiftJobHex } from './lift-job-types.js';

const CONTENT_ENVELOPE_FIELDS = [
  'contentScopeVersion',
  'kaUal',
  'assertionVersion',
  'publicTripleCount',
  'privateMerkleRoot',
  'privateTripleCount',
] as const;

type KnowledgeAssetContentEnvelopeSource = Pick<
  KnowledgeAssetVmPublishRequest,
  (typeof CONTENT_ENVELOPE_FIELDS)[number]
>;

export type GraphKnowledgeAssetContentEnvelope = {
  readonly contentScopeVersion: 2;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly publicTripleCount: number;
  readonly privateMerkleRoot?: LiftJobHex;
  readonly privateTripleCount: number;
};

type LegacyKnowledgeAssetContentEnvelope = {
  readonly contentScopeVersion?: 1;
};

/** Either a descriptor-less legacy response or one complete graph-scoped v2 contract. */
export type KnowledgeAssetContentEnvelope =
  | LegacyKnowledgeAssetContentEnvelope
  | GraphKnowledgeAssetContentEnvelope;

export function serializeKnowledgeAssetContentEnvelope(
  envelope: KnowledgeAssetContentEnvelopeSource,
): KnowledgeAssetContentEnvelope {
  return decodeKnowledgeAssetContentEnvelope(envelope);
}

export function decodeKnowledgeAssetContentEnvelope(value: unknown): KnowledgeAssetContentEnvelope {
  if (!isRecord(value)) return {};

  const contentScopeVersion = optionalPositiveInteger(value, 'contentScopeVersion');
  if (contentScopeVersion === undefined) return {};
  if (contentScopeVersion === 1) return { contentScopeVersion };
  if (contentScopeVersion !== 2) {
    throw new Error(`Knowledge Asset content envelope has unsupported contentScopeVersion ${contentScopeVersion}`);
  }

  const kaUal = optionalNonEmptyString(value, 'kaUal');
  const assertionVersion = optionalNonEmptyString(value, 'assertionVersion');
  const publicTripleCount = optionalCount(value, 'publicTripleCount');
  const privateMerkleRoot = optionalPrivateMerkleRoot(value);
  const privateTripleCount = optionalCount(value, 'privateTripleCount');

  requireEnvelopeField(kaUal, 'kaUal');
  requireEnvelopeField(assertionVersion, 'assertionVersion');
  requireEnvelopeField(publicTripleCount, 'publicTripleCount');
  requireEnvelopeField(privateTripleCount, 'privateTripleCount');

  if (publicTripleCount === 0 && privateTripleCount === 0) {
    throw new Error('Graph-scoped Knowledge Asset content envelope cannot describe an empty asset');
  }
  if (privateTripleCount > 0 && privateMerkleRoot === undefined) {
    throw new Error('Graph-scoped Knowledge Asset private content requires one 32-byte privateMerkleRoot');
  }
  if (privateTripleCount === 0 && privateMerkleRoot !== undefined) {
    throw new Error('Graph-scoped Knowledge Asset privateMerkleRoot requires private content');
  }

  return {
    contentScopeVersion,
    kaUal,
    assertionVersion,
    publicTripleCount,
    ...(privateMerkleRoot !== undefined ? { privateMerkleRoot } : {}),
    privateTripleCount,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function optionalNonEmptyString(
  value: Record<string, unknown>,
  field: string,
): string | undefined {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string' || candidate.length === 0) {
    throw new Error(`Knowledge Asset content envelope ${field} must be a non-empty string`);
  }
  return candidate;
}

function optionalPositiveInteger(
  value: Record<string, unknown>,
  field: string,
): number | undefined {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
    throw new Error(`Knowledge Asset content envelope ${field} must be a positive integer`);
  }
  return candidate as number;
}

function optionalCount(
  value: Record<string, unknown>,
  field: string,
): number | undefined {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
    throw new Error(`Knowledge Asset content envelope ${field} must be a non-negative integer`);
  }
  return candidate as number;
}

function optionalPrivateMerkleRoot(value: Record<string, unknown>): LiftJobHex | undefined {
  const candidate = value.privateMerkleRoot;
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string' || !/^0x[0-9a-f]{64}$/i.test(candidate)) {
    throw new Error('Knowledge Asset content envelope privateMerkleRoot must be exactly 32 bytes');
  }
  return candidate as LiftJobHex;
}

function requireEnvelopeField<T>(value: T | undefined, field: string): asserts value is T {
  if (value === undefined) {
    throw new Error(`Graph-scoped Knowledge Asset content envelope requires ${field}`);
  }
}
