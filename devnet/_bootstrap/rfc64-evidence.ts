/**
 * Deterministic semantic evidence for RFC-64 devnet gates.
 *
 * This module deliberately owns evidence formatting only. It does not discover
 * peers, fetch Knowledge Assets, retry transfers, or make sync decisions.
 * Harnesses pass their observations in after those protocol-owned operations
 * finish, then persist the returned fail-closed comparison artifact.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalize } from '../../packages/core/src/crypto/canonicalize.js';
import { parseDeterministicKnowledgeAssetUal } from '../../packages/core/src/ka-content-scope.js';

export const RFC64_SEMANTIC_SNAPSHOT_SCHEMA =
  'rfc64-semantic-snapshot/v1' as const;
export const RFC64_DEVNET_EVIDENCE_SCHEMA =
  'rfc64-devnet-evidence/v1' as const;

const SEMANTIC_MANIFEST_DOMAIN =
  'rfc64-semantic-nquads-manifest/v1\n';
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

export type Sha256Digest = `sha256:${string}`;

export interface Rfc64KnowledgeAssetObservation {
  readonly ual: string;
  /** One N-Quads document or a list of N-Quads document fragments. */
  readonly semanticNQuads: string | readonly string[];
}

export interface CanonicalSemanticNQuads {
  /** RDFC-1.0 canonical, deduplicated, lexically sorted N-Quads lines. */
  readonly lines: readonly string[];
  /** Canonical lines joined with LF and one trailing LF when non-empty. */
  readonly text: string;
  readonly quadCount: number;
  /** SHA-256 of the UTF-8 bytes in {@link text}. */
  readonly sha256: Sha256Digest;
}

export interface Rfc64KnowledgeAssetEvidenceV1 {
  readonly ual: string;
  readonly quadCount: number;
  readonly semanticNQuadsSha256: Sha256Digest;
}

export interface Rfc64SemanticSnapshotV1 {
  readonly schemaVersion: typeof RFC64_SEMANTIC_SNAPSHOT_SCHEMA;
  readonly kaCount: number;
  readonly quadCount: number;
  /** SHA-256 of sorted canonical UALs, one UTF-8 UAL plus LF per entry. */
  readonly ualsSha256: Sha256Digest;
  /**
   * SHA-256 of the domain-separated, stable JSON manifest of per-KA UALs,
   * quad counts, and canonical N-Quads digests.
   */
  readonly semanticNQuadsSha256: Sha256Digest;
  readonly knowledgeAssets: readonly Rfc64KnowledgeAssetEvidenceV1[];
}

export type Rfc64SnapshotMismatchCode =
  | 'OBSERVED_SNAPSHOT_MISSING'
  | 'KA_MISSING'
  | 'KA_UNEXPECTED'
  | 'QUAD_COUNT_MISMATCH'
  | 'SEMANTIC_NQUADS_DIGEST_MISMATCH';

export interface Rfc64SnapshotMismatchV1 {
  readonly code: Rfc64SnapshotMismatchCode;
  readonly ual?: string;
  readonly expected?: number | string;
  readonly observed?: number | string | null;
}

export interface Rfc64SnapshotComparisonV1 {
  readonly passed: boolean;
  readonly mismatches: readonly Rfc64SnapshotMismatchV1[];
}

export interface Rfc64FailureV1 {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface Rfc64RetryFailureInput extends Rfc64FailureV1 {
  /** One-based attempt which failed before a later attempt ran. */
  readonly attempt: number;
}

export interface Rfc64RetryFailureV1 extends Rfc64FailureV1 {
  readonly attempt: number;
}

export interface Rfc64DevnetEvidenceInput {
  readonly gate: string;
  /** Stable harness label such as `receiver-node-2`, never a temp path. */
  readonly observer: string;
  /** Null when discovery failed before a source was selected. */
  readonly sourcePeerId: string | null;
  readonly startedAt: Date | string;
  readonly completedAt: Date | string;
  /** Total calls, including the first call and the terminal call. */
  readonly attemptCount: number;
  /** Failures which led to another attempt; the terminal failure is separate. */
  readonly retryFailures?: readonly Rfc64RetryFailureInput[];
  readonly terminalFailure?: Rfc64FailureV1 | null;
  readonly expected: Rfc64SemanticSnapshotV1;
  readonly observed: Rfc64SemanticSnapshotV1 | null;
}

export interface Rfc64DevnetEvidenceV1 {
  readonly schemaVersion: typeof RFC64_DEVNET_EVIDENCE_SCHEMA;
  readonly gate: string;
  readonly observer: string;
  readonly sourcePeerId: string | null;
  readonly timing: {
    readonly startedAt: string;
    readonly completedAt: string;
    readonly durationMs: number;
  };
  readonly attempts: {
    readonly total: number;
    readonly retries: number;
    readonly failures: readonly Rfc64RetryFailureV1[];
  };
  readonly expected: Rfc64SemanticSnapshotV1;
  readonly observed: Rfc64SemanticSnapshotV1 | null;
  readonly comparison: Rfc64SnapshotComparisonV1;
  readonly terminalFailure: Rfc64FailureV1 | null;
  readonly passed: boolean;
}

export interface WrittenStableJsonArtifact {
  readonly byteLength: number;
  readonly sha256: Sha256Digest;
}

export class Rfc64EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Rfc64EvidenceValidationError';
  }
}

export class Rfc64EvidenceMismatchError extends Error {
  readonly comparison: Rfc64SnapshotComparisonV1;

  constructor(comparison: Rfc64SnapshotComparisonV1) {
    super(
      `RFC-64 semantic snapshot mismatch: ${comparison.mismatches
        .map((entry) => `${entry.code}${entry.ual ? `:${entry.ual}` : ''}`)
        .join(', ')}`,
    );
    this.name = 'Rfc64EvidenceMismatchError';
    this.comparison = comparison;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Text(text: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function canonicalUal(rawUal: string): string {
  if (typeof rawUal !== 'string') {
    throw new Rfc64EvidenceValidationError('Knowledge Asset UAL must be a string');
  }
  try {
    return parseDeterministicKnowledgeAssetUal(rawUal).ual;
  } catch (error) {
    throw new Rfc64EvidenceValidationError(
      `Invalid RFC-64 Knowledge Asset UAL ${JSON.stringify(rawUal)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function nquadsInputText(input: string | readonly string[]): string {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) {
    throw new Rfc64EvidenceValidationError(
      'semanticNQuads must be a string or an array of strings',
    );
  }
  for (const [index, fragment] of input.entries()) {
    if (typeof fragment !== 'string') {
      throw new Rfc64EvidenceValidationError(
        `semanticNQuads[${index}] must be a string`,
      );
    }
  }
  return input.join('\n');
}

/**
 * Canonicalize a semantic RDF dataset with the protocol's RDFC-1.0 helper,
 * then explicitly deduplicate and sort its lines for byte-stable evidence.
 */
export async function canonicalizeSemanticNQuads(
  input: string | readonly string[],
): Promise<CanonicalSemanticNQuads> {
  let canonical: string;
  try {
    canonical = await canonicalize(nquadsInputText(input));
  } catch (error) {
    throw new Rfc64EvidenceValidationError(
      `Invalid semantic N-Quads: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const lines = [...new Set(
    canonical
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  )].sort(compareText);
  const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return {
    lines,
    text,
    quadCount: lines.length,
    sha256: sha256Text(text),
  };
}

function ualsDigest(assets: readonly Rfc64KnowledgeAssetEvidenceV1[]): Sha256Digest {
  const text = assets.length === 0
    ? ''
    : `${assets.map((asset) => asset.ual).join('\n')}\n`;
  return sha256Text(text);
}

function semanticManifestDigest(
  assets: readonly Rfc64KnowledgeAssetEvidenceV1[],
): Sha256Digest {
  const manifest = assets.map((asset) => ({
    quadCount: asset.quadCount,
    semanticNQuadsSha256: asset.semanticNQuadsSha256,
    ual: asset.ual,
  }));
  return sha256Text(
    `${SEMANTIC_MANIFEST_DOMAIN}${stableJsonStringify(manifest)}`,
  );
}

/** Build a compact, order-independent semantic snapshot from raw observations. */
export async function createRfc64SemanticSnapshot(
  observations: readonly Rfc64KnowledgeAssetObservation[],
): Promise<Rfc64SemanticSnapshotV1> {
  if (!Array.isArray(observations)) {
    throw new Rfc64EvidenceValidationError('observations must be an array');
  }

  const assets = await Promise.all(observations.map(async (observation, index) => {
    if (!observation || typeof observation !== 'object') {
      throw new Rfc64EvidenceValidationError(
        `observations[${index}] must be an object`,
      );
    }
    const ual = canonicalUal(observation.ual);
    const nquads = await canonicalizeSemanticNQuads(observation.semanticNQuads);
    return {
      ual,
      quadCount: nquads.quadCount,
      semanticNQuadsSha256: nquads.sha256,
    } satisfies Rfc64KnowledgeAssetEvidenceV1;
  }));

  assets.sort((left, right) => compareText(left.ual, right.ual));
  for (let index = 1; index < assets.length; index += 1) {
    if (assets[index - 1]!.ual === assets[index]!.ual) {
      throw new Rfc64EvidenceValidationError(
        `Duplicate canonical Knowledge Asset UAL: ${assets[index]!.ual}`,
      );
    }
  }

  const snapshot: Rfc64SemanticSnapshotV1 = {
    schemaVersion: RFC64_SEMANTIC_SNAPSHOT_SCHEMA,
    kaCount: assets.length,
    quadCount: assets.reduce((sum, asset) => sum + asset.quadCount, 0),
    ualsSha256: ualsDigest(assets),
    semanticNQuadsSha256: semanticManifestDigest(assets),
    knowledgeAssets: assets,
  };
  return validateRfc64SemanticSnapshot(snapshot);
}

function assertNonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Rfc64EvidenceValidationError(
      `${label} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function assertDigest(value: unknown, label: string): asserts value is Sha256Digest {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new Rfc64EvidenceValidationError(
      `${label} must be a lowercase sha256:<64-hex> digest`,
    );
  }
}

/**
 * Validate every redundant count/digest in a snapshot before it is compared.
 * A malformed or self-inconsistent snapshot is rejected, never treated as an
 * ordinary mismatch which a caller might accidentally ignore.
 */
export function validateRfc64SemanticSnapshot(
  snapshot: Rfc64SemanticSnapshotV1,
): Rfc64SemanticSnapshotV1 {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Rfc64EvidenceValidationError('snapshot must be an object');
  }
  if (snapshot.schemaVersion !== RFC64_SEMANTIC_SNAPSHOT_SCHEMA) {
    throw new Rfc64EvidenceValidationError(
      `Unsupported semantic snapshot schema: ${String(snapshot.schemaVersion)}`,
    );
  }
  const kaCount = assertNonNegativeSafeInteger(snapshot.kaCount, 'snapshot.kaCount');
  const quadCount = assertNonNegativeSafeInteger(
    snapshot.quadCount,
    'snapshot.quadCount',
  );
  assertDigest(snapshot.ualsSha256, 'snapshot.ualsSha256');
  assertDigest(
    snapshot.semanticNQuadsSha256,
    'snapshot.semanticNQuadsSha256',
  );
  if (!Array.isArray(snapshot.knowledgeAssets)) {
    throw new Rfc64EvidenceValidationError(
      'snapshot.knowledgeAssets must be an array',
    );
  }

  let previousUal: string | null = null;
  let actualQuadCount = 0;
  for (const [index, asset] of snapshot.knowledgeAssets.entries()) {
    if (!asset || typeof asset !== 'object') {
      throw new Rfc64EvidenceValidationError(
        `snapshot.knowledgeAssets[${index}] must be an object`,
      );
    }
    const ual = canonicalUal(asset.ual);
    if (ual !== asset.ual) {
      throw new Rfc64EvidenceValidationError(
        `snapshot.knowledgeAssets[${index}].ual is not canonical: ${asset.ual}`,
      );
    }
    if (previousUal !== null && compareText(previousUal, ual) >= 0) {
      throw new Rfc64EvidenceValidationError(
        'snapshot.knowledgeAssets must contain unique UALs in lexical order',
      );
    }
    previousUal = ual;
    actualQuadCount += assertNonNegativeSafeInteger(
      asset.quadCount,
      `snapshot.knowledgeAssets[${index}].quadCount`,
    );
    assertDigest(
      asset.semanticNQuadsSha256,
      `snapshot.knowledgeAssets[${index}].semanticNQuadsSha256`,
    );
  }

  if (kaCount !== snapshot.knowledgeAssets.length) {
    throw new Rfc64EvidenceValidationError(
      `snapshot.kaCount ${kaCount} does not equal knowledgeAssets.length ${snapshot.knowledgeAssets.length}`,
    );
  }
  if (quadCount !== actualQuadCount) {
    throw new Rfc64EvidenceValidationError(
      `snapshot.quadCount ${quadCount} does not equal per-KA total ${actualQuadCount}`,
    );
  }
  const actualUalsDigest = ualsDigest(snapshot.knowledgeAssets);
  if (snapshot.ualsSha256 !== actualUalsDigest) {
    throw new Rfc64EvidenceValidationError(
      `snapshot.ualsSha256 ${snapshot.ualsSha256} does not equal computed ${actualUalsDigest}`,
    );
  }
  const actualSemanticDigest = semanticManifestDigest(snapshot.knowledgeAssets);
  if (snapshot.semanticNQuadsSha256 !== actualSemanticDigest) {
    throw new Rfc64EvidenceValidationError(
      `snapshot.semanticNQuadsSha256 ${snapshot.semanticNQuadsSha256} does not equal computed ${actualSemanticDigest}`,
    );
  }
  return snapshot;
}

/** Compare two validated snapshots and return a stable, granular diff. */
export function compareRfc64SemanticSnapshots(
  expected: Rfc64SemanticSnapshotV1,
  observed: Rfc64SemanticSnapshotV1,
): Rfc64SnapshotComparisonV1 {
  validateRfc64SemanticSnapshot(expected);
  validateRfc64SemanticSnapshot(observed);

  const expectedByUal = new Map(
    expected.knowledgeAssets.map((asset) => [asset.ual, asset] as const),
  );
  const observedByUal = new Map(
    observed.knowledgeAssets.map((asset) => [asset.ual, asset] as const),
  );
  const allUals = [...new Set([
    ...expectedByUal.keys(),
    ...observedByUal.keys(),
  ])].sort(compareText);
  const mismatches: Rfc64SnapshotMismatchV1[] = [];

  for (const ual of allUals) {
    const expectedAsset = expectedByUal.get(ual);
    const observedAsset = observedByUal.get(ual);
    if (!observedAsset) {
      mismatches.push({ code: 'KA_MISSING', ual });
      continue;
    }
    if (!expectedAsset) {
      mismatches.push({ code: 'KA_UNEXPECTED', ual });
      continue;
    }
    if (expectedAsset.quadCount !== observedAsset.quadCount) {
      mismatches.push({
        code: 'QUAD_COUNT_MISMATCH',
        ual,
        expected: expectedAsset.quadCount,
        observed: observedAsset.quadCount,
      });
    }
    if (
      expectedAsset.semanticNQuadsSha256
      !== observedAsset.semanticNQuadsSha256
    ) {
      mismatches.push({
        code: 'SEMANTIC_NQUADS_DIGEST_MISMATCH',
        ual,
        expected: expectedAsset.semanticNQuadsSha256,
        observed: observedAsset.semanticNQuadsSha256,
      });
    }
  }

  return { passed: mismatches.length === 0, mismatches };
}

/** Compare and throw on any missing, unexpected, or content-mismatched KA. */
export function assertRfc64SemanticSnapshotsEqual(
  expected: Rfc64SemanticSnapshotV1,
  observed: Rfc64SemanticSnapshotV1,
): void {
  const comparison = compareRfc64SemanticSnapshots(expected, observed);
  if (!comparison.passed) throw new Rfc64EvidenceMismatchError(comparison);
}

function requiredLabel(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Rfc64EvidenceValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function canonicalFailure(value: Rfc64FailureV1, label: string): Rfc64FailureV1 {
  if (!value || typeof value !== 'object') {
    throw new Rfc64EvidenceValidationError(`${label} must be an object`);
  }
  if (typeof value.retryable !== 'boolean') {
    throw new Rfc64EvidenceValidationError(`${label}.retryable must be boolean`);
  }
  return {
    code: requiredLabel(value.code, `${label}.code`),
    message: requiredLabel(value.message, `${label}.message`),
    retryable: value.retryable,
  };
}

function canonicalInstant(value: Date | string, label: string): {
  readonly epochMs: number;
  readonly iso: string;
} {
  const date = value instanceof Date ? value : new Date(value);
  const epochMs = date.getTime();
  if (!Number.isFinite(epochMs)) {
    throw new Rfc64EvidenceValidationError(`${label} must be a valid timestamp`);
  }
  return { epochMs, iso: date.toISOString() };
}

/**
 * Combine deterministic expected/observed snapshots with transport evidence.
 * `passed` is derived: callers cannot mark a mismatch or terminal failure green.
 */
export function createRfc64DevnetEvidence(
  input: Rfc64DevnetEvidenceInput,
): Rfc64DevnetEvidenceV1 {
  const gate = requiredLabel(input.gate, 'gate');
  const observer = requiredLabel(input.observer, 'observer');
  const sourcePeerId = input.sourcePeerId === null
    ? null
    : requiredLabel(input.sourcePeerId, 'sourcePeerId');
  const startedAt = canonicalInstant(input.startedAt, 'startedAt');
  const completedAt = canonicalInstant(input.completedAt, 'completedAt');
  if (completedAt.epochMs < startedAt.epochMs) {
    throw new Rfc64EvidenceValidationError(
      'completedAt must not be before startedAt',
    );
  }
  const attemptCount = assertNonNegativeSafeInteger(
    input.attemptCount,
    'attemptCount',
  );
  if (attemptCount < 1) {
    throw new Rfc64EvidenceValidationError('attemptCount must be at least 1');
  }

  validateRfc64SemanticSnapshot(input.expected);
  if (input.observed !== null) validateRfc64SemanticSnapshot(input.observed);
  const terminalFailure = input.terminalFailure == null
    ? null
    : canonicalFailure(input.terminalFailure, 'terminalFailure');
  if (input.observed === null && terminalFailure === null) {
    throw new Rfc64EvidenceValidationError(
      'a missing observed snapshot requires terminalFailure evidence',
    );
  }

  const failures = (input.retryFailures ?? []).map((failure, index) => {
    const canonical = canonicalFailure(failure, `retryFailures[${index}]`);
    const attempt = assertNonNegativeSafeInteger(
      failure.attempt,
      `retryFailures[${index}].attempt`,
    );
    if (attempt < 1 || attempt >= attemptCount) {
      throw new Rfc64EvidenceValidationError(
        `retryFailures[${index}].attempt must be between 1 and attemptCount - 1`,
      );
    }
    return { attempt, ...canonical } satisfies Rfc64RetryFailureV1;
  }).sort((left, right) => left.attempt - right.attempt);
  for (let index = 1; index < failures.length; index += 1) {
    if (failures[index - 1]!.attempt === failures[index]!.attempt) {
      throw new Rfc64EvidenceValidationError(
        `retryFailures contains duplicate attempt ${failures[index]!.attempt}`,
      );
    }
  }
  if (failures.length !== attemptCount - 1) {
    throw new Rfc64EvidenceValidationError(
      `retryFailures must contain one failure for each of the ${attemptCount - 1} retried attempts`,
    );
  }

  const comparison: Rfc64SnapshotComparisonV1 = input.observed === null
    ? {
        passed: false,
        mismatches: [{
          code: 'OBSERVED_SNAPSHOT_MISSING',
          expected: input.expected.semanticNQuadsSha256,
          observed: null,
        }],
      }
    : compareRfc64SemanticSnapshots(input.expected, input.observed);

  return {
    schemaVersion: RFC64_DEVNET_EVIDENCE_SCHEMA,
    gate,
    observer,
    sourcePeerId,
    timing: {
      startedAt: startedAt.iso,
      completedAt: completedAt.iso,
      durationMs: completedAt.epochMs - startedAt.epochMs,
    },
    attempts: {
      total: attemptCount,
      retries: attemptCount - 1,
      failures,
    },
    expected: input.expected,
    observed: input.observed,
    comparison,
    terminalFailure,
    passed: comparison.passed && terminalFailure === null,
  };
}

function stableJsonValue(value: unknown, path: string, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Rfc64EvidenceValidationError(`${path} contains a non-finite number`);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new Rfc64EvidenceValidationError(`${path} contains a cycle`);
    }
    ancestors.add(value);
    const result = value.map((entry, index) =>
      stableJsonValue(entry, `${path}[${index}]`, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (typeof value === 'object' && value !== null) {
    if (ancestors.has(value)) {
      throw new Rfc64EvidenceValidationError(`${path} contains a cycle`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Rfc64EvidenceValidationError(
        `${path} must contain only plain JSON objects`,
      );
    }
    ancestors.add(value);
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareText)) {
      const entry = source[key];
      if (entry === undefined || typeof entry === 'bigint' || typeof entry === 'function') {
        throw new Rfc64EvidenceValidationError(
          `${path}.${key} is not a stable JSON value`,
        );
      }
      result[key] = stableJsonValue(entry, `${path}.${key}`, ancestors);
    }
    ancestors.delete(value);
    return result;
  }
  throw new Rfc64EvidenceValidationError(`${path} is not a stable JSON value`);
}

/** Recursively sort object keys and append exactly one LF. */
export function stableJsonStringify(value: unknown): string {
  return `${JSON.stringify(stableJsonValue(value, '$', new Set()), null, 2)}\n`;
}

/** Write a byte-stable JSON artifact and return its exact byte count/digest. */
export function writeStableJsonArtifact(
  path: string,
  value: unknown,
): WrittenStableJsonArtifact {
  const target = requiredLabel(path, 'path');
  const json = stableJsonStringify(value);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, json, { encoding: 'utf8', mode: 0o600 });
  return {
    byteLength: Buffer.byteLength(json, 'utf8'),
    sha256: sha256Text(json),
  };
}
