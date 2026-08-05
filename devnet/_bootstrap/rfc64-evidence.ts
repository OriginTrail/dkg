/**
 * Deterministic semantic evidence for RFC-64 devnet gates.
 *
 * This module deliberately owns evidence formatting only. It does not discover
 * peers, fetch Knowledge Assets, retry transfers, or make sync decisions.
 * Harnesses pass their observations in after those protocol-owned operations
 * finish, then persist the returned fail-closed comparison artifact.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import {
  basename,
  dirname,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from 'node:path';
import { types as utilTypes } from 'node:util';
import rdfCanonize from 'rdf-canonize';
import { parseDeterministicKnowledgeAssetUal } from '../../packages/core/src/ka-content-scope.js';

export const RFC64_SEMANTIC_SNAPSHOT_SCHEMA =
  'rfc64-semantic-snapshot/v1' as const;
export const RFC64_DEVNET_EVIDENCE_SCHEMA =
  'rfc64-devnet-evidence/v1' as const;

const SEMANTIC_MANIFEST_DOMAIN =
  'rfc64-semantic-nquads-manifest/v1\n';
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const RFC3339_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/u;

export const RFC64_ARTIFACT_POSIX_NAMESPACE_DURABILITY =
  'file-fsync-rename-directory-fsync' as const;
export const RFC64_ARTIFACT_WINDOWS_NAMESPACE_DURABILITY =
  'file-flush-rename-no-directory-flush' as const;
export const RFC64_ARTIFACT_POSIX_ACCESS_POLICY =
  'posix-owner-read-write-mode-0600' as const;
export const RFC64_ARTIFACT_WINDOWS_ACCESS_POLICY =
  'windows-inherited-acl' as const;

export type Sha256Digest = `sha256:${string}`;

export interface Rfc64KnowledgeAssetObservation {
  readonly ual: string;
  /** One N-Quads document or a list of N-Quads document fragments. */
  readonly semanticNQuads: string | readonly string[];
}

export interface CanonicalSemanticNQuads {
  /** RDFC-1.0 canonical, placement-neutral, lexically sorted S/P/O lines. */
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
  /** Windows Node.js cannot flush directory handles through fsync. */
  readonly namespaceDurability:
    | typeof RFC64_ARTIFACT_POSIX_NAMESPACE_DURABILITY
    | typeof RFC64_ARTIFACT_WINDOWS_NAMESPACE_DURABILITY;
  /** POSIX mode bits are not presented as an ACL guarantee on Windows. */
  readonly accessPolicy:
    | typeof RFC64_ARTIFACT_POSIX_ACCESS_POLICY
    | typeof RFC64_ARTIFACT_WINDOWS_ACCESS_POLICY;
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
  const captured = stableJsonValue(input, 'semanticNQuads', new Set());
  if (typeof captured === 'string') return captured;
  if (!Array.isArray(captured)) {
    throw new Rfc64EvidenceValidationError(
      'semanticNQuads must be a string or an array of strings',
    );
  }
  const fragments = new Array<string>(captured.length);
  for (let index = 0; index < captured.length; index += 1) {
    const fragment = captured[index];
    if (typeof fragment !== 'string') {
      throw new Rfc64EvidenceValidationError(
        `semanticNQuads[${index}] must be a string`,
      );
    }
    fragments[index] = fragment;
  }
  return fragments.join('\n');
}

const DEFAULT_GRAPH_TERM = Object.freeze({
  termType: 'DefaultGraph' as const,
  value: '',
});

/**
 * Parse the received rows and project away their physical graph placement.
 * RFC-64 semantic equality is defined over S/P/O. A repeated projected triple
 * is rejected at this boundary; silently turning a duplicate-bearing response
 * into a set would hide responder/store faults and corrupt the recorded count.
 */
function receivedSemanticProjection(
  input: string | readonly string[],
): string {
  // rdf-canonize parses into an RDF dataset and therefore legitimately folds
  // exact duplicate lines. Parse each received row independently so evidence
  // can reject duplicates before dataset set-semantics erase that signal.
  const received = nquadsInputText(input)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line, index) => {
      const parsed = rdfCanonize.NQuads.parse(`${line}\n`);
      if (parsed.length !== 1) {
        throw new Rfc64EvidenceValidationError(
          `semantic N-Quads row ${index} did not decode to exactly one quad`,
        );
      }
      return parsed;
    });
  const projected = received.map((quad) => ({
    ...quad,
    graph: DEFAULT_GRAPH_TERM,
  }));
  const seen = new Set<string>();
  for (const quad of projected) {
    const line = rdfCanonize.NQuads.serialize([quad]).trimEnd();
    if (seen.has(line)) {
      throw new Rfc64EvidenceValidationError(
        `Duplicate received semantic S/P/O projection: ${line}`,
      );
    }
    seen.add(line);
  }
  return rdfCanonize.NQuads.serialize(projected);
}

/**
 * Project physical N-Quads to semantic S/P/O, reject duplicate projected rows,
 * and canonicalize blank nodes with the protocol's RDFC-1.0 helper.
 */
export async function canonicalizeSemanticNQuads(
  input: string | readonly string[],
): Promise<CanonicalSemanticNQuads> {
  let canonical: string;
  try {
    canonical = await rdfCanonize.canonize(receivedSemanticProjection(input), {
      algorithm: 'RDFC-1.0',
      inputFormat: 'application/n-quads',
      format: 'application/n-quads',
      maxWorkFactor: 1,
    });
  } catch (error) {
    throw new Rfc64EvidenceValidationError(
      `Invalid semantic N-Quads: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const lines = canonical
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort(compareText);
  if (new Set(lines).size !== lines.length) {
    throw new Rfc64EvidenceValidationError(
      'RDFC-1.0 emitted duplicate semantic projection rows',
    );
  }
  const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return Object.freeze({
    lines: Object.freeze(lines),
    text,
    quadCount: lines.length,
    sha256: sha256Text(text),
  });
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

function closeSemanticSnapshot(
  snapshot: Rfc64SemanticSnapshotV1,
): Rfc64SemanticSnapshotV1 {
  const knowledgeAssets = Object.freeze(snapshot.knowledgeAssets.map((asset) =>
    Object.freeze({
      ual: asset.ual,
      quadCount: asset.quadCount,
      semanticNQuadsSha256: asset.semanticNQuadsSha256,
    })));
  return Object.freeze({
    schemaVersion: RFC64_SEMANTIC_SNAPSHOT_SCHEMA,
    kaCount: snapshot.kaCount,
    quadCount: snapshot.quadCount,
    ualsSha256: snapshot.ualsSha256,
    semanticNQuadsSha256: snapshot.semanticNQuadsSha256,
    knowledgeAssets,
  });
}

function closeComparison(
  comparison: Rfc64SnapshotComparisonV1,
): Rfc64SnapshotComparisonV1 {
  return Object.freeze({
    passed: comparison.passed,
    mismatches: Object.freeze(comparison.mismatches.map((mismatch) =>
      Object.freeze({ ...mismatch }))),
  });
}

/** Build a compact, order-independent semantic snapshot from raw observations. */
export async function createRfc64SemanticSnapshot(
  observations: readonly Rfc64KnowledgeAssetObservation[],
): Promise<Rfc64SemanticSnapshotV1> {
  // Capture the complete caller-owned tree before doing any asynchronous work.
  // The capture reads data descriptors once, rejects proxies/accessors and
  // exotic containers, and gives the rest of this function ordinary arrays it
  // owns. In particular, never dispatch through a caller-provided `map` method.
  const captured = stableJsonValue(
    observations,
    'observations',
    new Set(),
  );
  if (!Array.isArray(captured)) {
    throw new Rfc64EvidenceValidationError('observations must be an array');
  }

  const pendingAssets: Promise<Rfc64KnowledgeAssetEvidenceV1>[] = [];
  for (let index = 0; index < captured.length; index += 1) {
    const observation = captured[index];
    if (!observation || typeof observation !== 'object') {
      throw new Rfc64EvidenceValidationError(
        `observations[${index}] must be an object`,
      );
    }
    const record = observation as Record<string, unknown>;
    pendingAssets[index] = (async () => {
      const ual = canonicalUal(record.ual as string);
      const nquads = await canonicalizeSemanticNQuads(
        record.semanticNQuads as string | readonly string[],
      );
      return {
        ual,
        quadCount: nquads.quadCount,
        semanticNQuadsSha256: nquads.sha256,
      } satisfies Rfc64KnowledgeAssetEvidenceV1;
    })();
  }
  const assets = await Promise.all(pendingAssets);

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
  // Capture each own data property exactly once before validation. This keeps
  // accessors, proxies, sparse/custom arrays, and other exotic containers from
  // changing the value between a successful check and the frozen result.
  const captured = stableJsonValue(
    snapshot,
    'snapshot',
    new Set(),
  ) as unknown as Rfc64SemanticSnapshotV1;
  if (captured.schemaVersion !== RFC64_SEMANTIC_SNAPSHOT_SCHEMA) {
    throw new Rfc64EvidenceValidationError(
      `Unsupported semantic snapshot schema: ${String(captured.schemaVersion)}`,
    );
  }
  const kaCount = assertNonNegativeSafeInteger(captured.kaCount, 'snapshot.kaCount');
  const quadCount = assertNonNegativeSafeInteger(
    captured.quadCount,
    'snapshot.quadCount',
  );
  assertDigest(captured.ualsSha256, 'snapshot.ualsSha256');
  assertDigest(
    captured.semanticNQuadsSha256,
    'snapshot.semanticNQuadsSha256',
  );
  if (!Array.isArray(captured.knowledgeAssets)) {
    throw new Rfc64EvidenceValidationError(
      'snapshot.knowledgeAssets must be an array',
    );
  }

  let previousUal: string | null = null;
  let actualQuadCount = 0;
  for (const [index, asset] of captured.knowledgeAssets.entries()) {
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

  if (kaCount !== captured.knowledgeAssets.length) {
    throw new Rfc64EvidenceValidationError(
      `snapshot.kaCount ${kaCount} does not equal knowledgeAssets.length ${captured.knowledgeAssets.length}`,
    );
  }
  if (quadCount !== actualQuadCount) {
    throw new Rfc64EvidenceValidationError(
      `snapshot.quadCount ${quadCount} does not equal per-KA total ${actualQuadCount}`,
    );
  }
  const actualUalsDigest = ualsDigest(captured.knowledgeAssets);
  if (captured.ualsSha256 !== actualUalsDigest) {
    throw new Rfc64EvidenceValidationError(
      `snapshot.ualsSha256 ${captured.ualsSha256} does not equal computed ${actualUalsDigest}`,
    );
  }
  const actualSemanticDigest = semanticManifestDigest(captured.knowledgeAssets);
  if (captured.semanticNQuadsSha256 !== actualSemanticDigest) {
    throw new Rfc64EvidenceValidationError(
      `snapshot.semanticNQuadsSha256 ${captured.semanticNQuadsSha256} does not equal computed ${actualSemanticDigest}`,
    );
  }
  return closeSemanticSnapshot(captured);
}

/** Compare two validated snapshots and return a stable, granular diff. */
export function compareRfc64SemanticSnapshots(
  expected: Rfc64SemanticSnapshotV1,
  observed: Rfc64SemanticSnapshotV1,
): Rfc64SnapshotComparisonV1 {
  const closedExpected = validateRfc64SemanticSnapshot(expected);
  const closedObserved = validateRfc64SemanticSnapshot(observed);

  const expectedByUal = new Map(
    closedExpected.knowledgeAssets.map((asset) => [asset.ual, asset] as const),
  );
  const observedByUal = new Map(
    closedObserved.knowledgeAssets.map((asset) => [asset.ual, asset] as const),
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

  return closeComparison({ passed: mismatches.length === 0, mismatches });
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

/**
 * Capture an API input record without recursively interpreting its values.
 * Dates need specialized handling, while snapshots and failure records are
 * captured by their own validators. Every own field is nevertheless resolved
 * from one data descriptor before any field-level validation starts.
 */
function capturePlainDataRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && utilTypes.isProxy(value)
  ) {
    throw new Rfc64EvidenceValidationError(`${label} must not be a proxy`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Rfc64EvidenceValidationError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Rfc64EvidenceValidationError(
      `${label} must be a plain data object`,
    );
  }
  const source = value as Record<string, unknown>;
  const ownKeys = Reflect.ownKeys(source);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new Rfc64EvidenceValidationError(`${label} must not contain symbol keys`);
  }
  const captured: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of (ownKeys as string[]).sort(compareText)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key)!;
    if (!('value' in descriptor)) {
      throw new Rfc64EvidenceValidationError(
        `${label}.${key} must not be an accessor property`,
      );
    }
    if (!descriptor.enumerable) {
      throw new Rfc64EvidenceValidationError(
        `${label}.${key} must not be a hidden non-enumerable property`,
      );
    }
    captured[key] = descriptor.value;
  }
  return captured;
}

function captureFailureRecord(
  value: Rfc64FailureV1,
  label: string,
): Record<string, unknown> {
  const captured = stableJsonValue(value, label, new Set());
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) {
    throw new Rfc64EvidenceValidationError(`${label} must be an object`);
  }
  return captured as Record<string, unknown>;
}

function canonicalFailureFromCaptured(
  captured: Record<string, unknown>,
  label: string,
): Rfc64FailureV1 {
  const retryable = captured.retryable;
  if (typeof retryable !== 'boolean') {
    throw new Rfc64EvidenceValidationError(`${label}.retryable must be boolean`);
  }
  return Object.freeze({
    code: requiredLabel(captured.code, `${label}.code`),
    message: requiredLabel(captured.message, `${label}.message`),
    retryable,
  });
}

function canonicalFailure(value: Rfc64FailureV1, label: string): Rfc64FailureV1 {
  return canonicalFailureFromCaptured(captureFailureRecord(value, label), label);
}

function isGregorianLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function gregorianMonthLength(year: number, month: number): number {
  if (month === 2) return isGregorianLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function canonicalInstant(value: unknown, label: string): {
  readonly epochMs: number;
  readonly iso: string;
} {
  let epochMs: number;
  if (typeof value === 'string') {
    const match = RFC3339_INSTANT_RE.exec(value);
    if (match === null) {
      throw new Rfc64EvidenceValidationError(
        `${label} must be an ISO timestamp with Z or an explicit UTC offset`,
      );
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const fractionalSecondDigits = match[7]?.length ?? 0;
    const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
    const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
    const unknownLocalOffset = match[8] === '-00:00';
    if (
      month < 1
      || month > 12
      || day < 1
      || day > gregorianMonthLength(year, month)
      || hour > 23
      || minute > 59
      || second > 59
      || fractionalSecondDigits > 3
      || offsetHour > 23
      || offsetMinute > 59
      || unknownLocalOffset
    ) {
      throw new Rfc64EvidenceValidationError(
        `${label} must be a valid, representable RFC 3339 timestamp`,
      );
    }
    epochMs = Date.prototype.getTime.call(new Date(value));
  } else {
    if (
      value === null
      || typeof value !== 'object'
      || utilTypes.isProxy(value)
      || !utilTypes.isDate(value)
    ) {
      throw new Rfc64EvidenceValidationError(
        `${label} must be a primitive timestamp string or a non-proxy Date`,
      );
    }
    // Ignore subclass overrides and read only the genuine Date internal slot.
    epochMs = Date.prototype.getTime.call(value);
  }
  if (!Number.isFinite(epochMs) || !Number.isInteger(epochMs)) {
    throw new Rfc64EvidenceValidationError(`${label} must be a valid timestamp`);
  }
  return { epochMs, iso: new Date(epochMs).toISOString() };
}

/**
 * Combine deterministic expected/observed snapshots with transport evidence.
 * `passed` is derived: callers cannot mark a mismatch or terminal failure green.
 */
export function createRfc64DevnetEvidence(
  input: Rfc64DevnetEvidenceInput,
): Rfc64DevnetEvidenceV1 {
  const capturedInput = capturePlainDataRecord(input, 'input');
  const gate = requiredLabel(capturedInput.gate, 'gate');
  const observer = requiredLabel(capturedInput.observer, 'observer');
  const sourcePeerIdInput = capturedInput.sourcePeerId;
  const sourcePeerId = sourcePeerIdInput === null
    ? null
    : requiredLabel(sourcePeerIdInput, 'sourcePeerId');
  const startedAt = canonicalInstant(capturedInput.startedAt, 'startedAt');
  const completedAt = canonicalInstant(capturedInput.completedAt, 'completedAt');
  if (completedAt.epochMs < startedAt.epochMs) {
    throw new Rfc64EvidenceValidationError(
      'completedAt must not be before startedAt',
    );
  }
  const durationMs = completedAt.epochMs - startedAt.epochMs;
  if (!Number.isSafeInteger(durationMs)) {
    throw new Rfc64EvidenceValidationError(
      'timing.durationMs must be a non-negative safe integer',
    );
  }
  const attemptCount = assertNonNegativeSafeInteger(
    capturedInput.attemptCount,
    'attemptCount',
  );
  if (attemptCount < 1) {
    throw new Rfc64EvidenceValidationError('attemptCount must be at least 1');
  }

  const expected = validateRfc64SemanticSnapshot(
    capturedInput.expected as Rfc64SemanticSnapshotV1,
  );
  const observedInput = capturedInput.observed;
  const observed = observedInput === null
    ? null
    : validateRfc64SemanticSnapshot(observedInput as Rfc64SemanticSnapshotV1);
  const terminalFailureInput = capturedInput.terminalFailure;
  const terminalFailure = terminalFailureInput == null
    ? null
    : canonicalFailure(terminalFailureInput as Rfc64FailureV1, 'terminalFailure');
  if (observedInput === null && terminalFailure === null) {
    throw new Rfc64EvidenceValidationError(
      'a missing observed snapshot requires terminalFailure evidence',
    );
  }

  const capturedRetryFailures = stableJsonValue(
    capturedInput.retryFailures ?? [],
    'retryFailures',
    new Set(),
  );
  if (!Array.isArray(capturedRetryFailures)) {
    throw new Rfc64EvidenceValidationError('retryFailures must be an array');
  }
  const failures: Rfc64RetryFailureV1[] = [];
  for (let index = 0; index < capturedRetryFailures.length; index += 1) {
    const label = `retryFailures[${index}]`;
    const failure = capturedRetryFailures[index];
    if (!failure || typeof failure !== 'object' || Array.isArray(failure)) {
      throw new Rfc64EvidenceValidationError(`${label} must be an object`);
    }
    const captured = failure as Record<string, unknown>;
    const canonical = canonicalFailureFromCaptured(captured, label);
    const attempt = assertNonNegativeSafeInteger(
      captured.attempt,
      `${label}.attempt`,
    );
    if (attempt < 1 || attempt >= attemptCount) {
      throw new Rfc64EvidenceValidationError(
        `retryFailures[${index}].attempt must be between 1 and attemptCount - 1`,
      );
    }
    failures[index] = Object.freeze({
      attempt,
      ...canonical,
    }) satisfies Rfc64RetryFailureV1;
  }
  failures.sort((left, right) => left.attempt - right.attempt);
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

  const comparison: Rfc64SnapshotComparisonV1 = observed === null
    ? closeComparison({
        passed: false,
        mismatches: [{
          code: 'OBSERVED_SNAPSHOT_MISSING',
          expected: expected.semanticNQuadsSha256,
          observed: null,
        }],
      })
    : compareRfc64SemanticSnapshots(expected, observed);

  return Object.freeze({
    schemaVersion: RFC64_DEVNET_EVIDENCE_SCHEMA,
    gate,
    observer,
    sourcePeerId,
    timing: Object.freeze({
      startedAt: startedAt.iso,
      completedAt: completedAt.iso,
      durationMs,
    }),
    attempts: Object.freeze({
      total: attemptCount,
      retries: attemptCount - 1,
      failures: Object.freeze(failures),
    }),
    expected,
    observed,
    comparison,
    terminalFailure,
    passed: comparison.passed && terminalFailure === null,
  });
}

function stableJsonValue(value: unknown, path: string, ancestors: Set<object>): unknown {
  if (
    value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && utilTypes.isProxy(value)
  ) {
    throw new Rfc64EvidenceValidationError(`${path} must not be a proxy`);
  }
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
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Rfc64EvidenceValidationError(
        `${path} must not use a custom array prototype`,
      );
    }
    if (ancestors.has(value)) {
      throw new Rfc64EvidenceValidationError(`${path} contains a cycle`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new Rfc64EvidenceValidationError(`${path} must not contain symbol keys`);
    }
    const allowedKeys = new Set<string>(['length']);
    for (let index = 0; index < value.length; index += 1) {
      allowedKeys.add(String(index));
      if (!Object.hasOwn(value, index)) {
        throw new Rfc64EvidenceValidationError(`${path} must not be a sparse array`);
      }
    }
    for (const key of ownKeys as string[]) {
      if (!allowedKeys.has(key)) {
        throw new Rfc64EvidenceValidationError(
          `${path} must not contain custom array property ${JSON.stringify(key)}`,
        );
      }
      if (key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) {
        throw new Rfc64EvidenceValidationError(
          `${path}[${key}] must be an enumerable data property`,
        );
      }
    }
    ancestors.add(value);
    const result = Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))!;
      return stableJsonValue(descriptor.value, `${path}[${index}]`, ancestors);
    });
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
    const ownKeys = Reflect.ownKeys(source);
    if (ownKeys.some((key) => typeof key === 'symbol')) {
      throw new Rfc64EvidenceValidationError(`${path} must not contain symbol keys`);
    }
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of (ownKeys as string[]).sort(compareText)) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key)!;
      if (!('value' in descriptor)) {
        throw new Rfc64EvidenceValidationError(
          `${path}.${key} must not be an accessor property`,
        );
      }
      if (!descriptor.enumerable) {
        throw new Rfc64EvidenceValidationError(
          `${path}.${key} must not be a hidden non-enumerable property`,
        );
      }
      const entry = descriptor.value;
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

interface DirectoryTopologyEntry {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

function lstatOptional(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertDirectory(path: string, stat: Stats): void {
  if (stat.isSymbolicLink()) {
    throw new Rfc64EvidenceValidationError(
      `artifact directory topology contains a symbolic link: ${path}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Rfc64EvidenceValidationError(
      `artifact directory topology contains a non-directory: ${path}`,
    );
  }
}

function ensureArtifactDirectoryTopology(
  directory: string,
): readonly DirectoryTopologyEntry[] {
  const root = parsePath(directory).root;
  const relativeDirectory = relative(root, directory);
  const components = relativeDirectory.length === 0
    ? []
    : relativeDirectory.split(sep);
  const entries: DirectoryTopologyEntry[] = [];
  let current = root;

  const rootStat = lstatSync(root);
  assertDirectory(root, rootStat);
  entries.push({ path: root, dev: rootStat.dev, ino: rootStat.ino });

  for (const component of components) {
    current = join(current, component);
    let stat = lstatOptional(current);
    let observedMissing = false;
    if (stat === null) {
      observedMissing = true;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      stat = lstatSync(current);
    }
    assertDirectory(current, stat);
    if (observedMissing) {
      // Persist the new directory entry before relying on it as the parent of
      // another directory or of the artifact itself. Also issue this barrier
      // when a concurrent creator won the ENOENT-to-mkdir EEXIST race.
      fsyncArtifactDirectory(dirname(current), entries);
    }
    entries.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return Object.freeze(entries.map((entry) => Object.freeze(entry)));
}

function assertArtifactDirectoryTopology(
  entries: readonly DirectoryTopologyEntry[],
): void {
  for (const expected of entries) {
    const actual = lstatOptional(expected.path);
    if (actual === null) {
      throw new Rfc64EvidenceValidationError(
        `artifact directory disappeared during publication: ${expected.path}`,
      );
    }
    assertDirectory(expected.path, actual);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Rfc64EvidenceValidationError(
        `artifact directory topology changed during publication: ${expected.path}`,
      );
    }
  }
}

function assertArtifactTargetReplaceable(target: string): void {
  const stat = lstatOptional(target);
  if (stat === null) return;
  if (stat.isSymbolicLink()) {
    throw new Rfc64EvidenceValidationError(
      `artifact target must not be a symbolic link: ${target}`,
    );
  }
  if (!stat.isFile()) {
    throw new Rfc64EvidenceValidationError(
      `artifact target must be a regular file: ${target}`,
    );
  }
}

function verifyPublishedArtifact(target: string, expectedJson: string): void {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const fd = openSync(target, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Rfc64EvidenceValidationError(
        `published artifact is not a regular file: ${target}`,
      );
    }
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
      throw new Rfc64EvidenceValidationError(
        `published artifact mode must be 0600, got 0${(stat.mode & 0o777).toString(8)}`,
      );
    }
    if (readFileSync(fd, 'utf8') !== expectedJson) {
      throw new Rfc64EvidenceValidationError(
        `published artifact bytes changed during publication: ${target}`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

function fsyncArtifactDirectory(
  directory: string,
  topology: readonly DirectoryTopologyEntry[],
): void {
  // Node/libuv opens this directory with read access, but Windows implements
  // fsync with FlushFileBuffers, which requires a writable handle. Report the
  // weaker namespace policy instead of publishing successfully and then
  // throwing a false failure from an unsupported durability operation.
  if (process.platform === 'win32') return;
  const expected = topology[topology.length - 1]!;
  if (expected.path !== directory) {
    throw new Rfc64EvidenceValidationError(
      `artifact directory barrier does not match checked topology: ${directory}`,
    );
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const directoryOnly = fsConstants.O_DIRECTORY ?? 0;
  const fd = openSync(
    directory,
    fsConstants.O_RDONLY | noFollow | directoryOnly,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      throw new Rfc64EvidenceValidationError(
        `artifact directory handle does not match checked topology: ${directory}`,
      );
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function cleanupTemporaryArtifact(
  temporaryPath: string,
  topology: readonly DirectoryTopologyEntry[],
): void {
  try {
    assertArtifactDirectoryTopology(topology);
  } catch {
    // Do not traverse a directory topology which changed under us.
    return;
  }
  try {
    unlinkSync(temporaryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Atomically publish byte-stable JSON through a same-directory temporary file.
 * POSIX publication enforces mode 0600 and directory-fsync namespace barriers;
 * Windows flushes the file and reports rename-only namespace durability plus
 * inherited ACL protection. The caller must keep the parent directory topology
 * trusted and static for the duration of this call: Node exposes no portable
 * directory-handle-relative rename/open API with which to close path TOCTOU.
 * The checks below reject pre-existing symlinks and detect many concurrent
 * changes, but a post-rename error can still leave publication side effects.
 */
export function writeStableJsonArtifact(
  path: string,
  value: unknown,
): WrittenStableJsonArtifact {
  const requestedTarget = requiredLabel(path, 'path');
  const target = resolve(requestedTarget);
  const targetName = basename(target);
  if (targetName.length === 0) {
    throw new Rfc64EvidenceValidationError('path must identify an artifact file');
  }
  const json = stableJsonStringify(value);
  const directory = dirname(target);
  const topology = ensureArtifactDirectoryTopology(directory);
  assertArtifactDirectoryTopology(topology);
  assertArtifactTargetReplaceable(target);

  const temporaryPath = join(
    directory,
    `.${targetName}.${process.pid}.${randomUUID()}.tmp`,
  );
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let temporaryFd: number | null = null;
  let renamed = false;
  try {
    temporaryFd = openSync(
      temporaryPath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | noFollow,
      0o600,
    );
    const opened = fstatSync(temporaryFd);
    if (!opened.isFile()) {
      throw new Rfc64EvidenceValidationError(
        `temporary artifact is not a regular file: ${temporaryPath}`,
      );
    }
    if (process.platform !== 'win32') fchmodSync(temporaryFd, 0o600);
    writeFileSync(temporaryFd, json, { encoding: 'utf8' });
    fsyncSync(temporaryFd);
    closeSync(temporaryFd);
    temporaryFd = null;

    assertArtifactDirectoryTopology(topology);
    assertArtifactTargetReplaceable(target);
    renameSync(temporaryPath, target);
    renamed = true;

    assertArtifactDirectoryTopology(topology);
    verifyPublishedArtifact(target, json);
    fsyncArtifactDirectory(directory, topology);
    assertArtifactDirectoryTopology(topology);
  } catch (error) {
    if (temporaryFd !== null) {
      try {
        closeSync(temporaryFd);
      } catch {
        // Preserve the primary publication error.
      }
    }
    if (!renamed) cleanupTemporaryArtifact(temporaryPath, topology);
    throw error;
  }
  return {
    byteLength: Buffer.byteLength(json, 'utf8'),
    sha256: sha256Text(json),
    namespaceDurability: process.platform === 'win32'
      ? RFC64_ARTIFACT_WINDOWS_NAMESPACE_DURABILITY
      : RFC64_ARTIFACT_POSIX_NAMESPACE_DURABILITY,
    accessPolicy: process.platform === 'win32'
      ? RFC64_ARTIFACT_WINDOWS_ACCESS_POLICY
      : RFC64_ARTIFACT_POSIX_ACCESS_POLICY,
  };
}
