import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseDeterministicKnowledgeAssetUal } from '../../packages/core/src/ka-content-scope.js';

export const RFC64_V2_SWM_POLICY_CELLS = Object.freeze([
  'public-open',
  'public-curated',
  'private-open',
  'private-curated',
] as const);

export type Rfc64V2SwmPolicyCell = typeof RFC64_V2_SWM_POLICY_CELLS[number];

export const RFC64_V2_REQUIRED_PRODUCT_CAPABILITIES = Object.freeze([
  'acceptRfc64CatalogAccessSnapshotV1',
  'publishAuthorCatalogGenesisV1',
  'publishAuthorCatalogExactSetSuccessorV1',
] as const);

/**
 * Deliberately not required by the immutable four-cell V2 matrix. Once the
 * product owns verified high-water policy/roster activation, the same rich
 * scenario can add open↔invite and roster-removal transitions without
 * pretending that repeated immutable snapshot acceptance is a transition.
 */
export const RFC64_V2_FUTURE_TRANSITION_CAPABILITY =
  'activateRfc64CatalogAccessTransitionV1' as const;

export type Rfc64V2RequiredProductCapability =
  typeof RFC64_V2_REQUIRED_PRODUCT_CAPABILITIES[number];

export interface Rfc64V2ProductCapabilityInspection {
  readonly futureTransitionCapability: boolean;
  readonly missing: readonly Rfc64V2RequiredProductCapability[];
  readonly observed: Readonly<Record<Rfc64V2RequiredProductCapability, boolean>>;
}

export interface Rfc64V2SwmReadObservation {
  readonly agentAddress: string;
  readonly bindingCount: number;
  readonly contentSha256: string | null;
  readonly httpStatus: number;
  readonly leakedMarker: boolean;
  readonly nodeNumber: number;
  readonly outcome: 'applied' | 'denied';
}

export interface Rfc64V2SwmCellObservation {
  readonly accessPolicy: 0 | 1;
  readonly assertionUri: string;
  readonly authorAgentAddress: string;
  readonly cell: Rfc64V2SwmPolicyCell;
  readonly contentSha256: string;
  readonly contextGraphId: string;
  readonly kaId: string;
  readonly memberRead: Rfc64V2SwmReadObservation;
  readonly merkleRoot: string;
  readonly outsiderRead: Rfc64V2SwmReadObservation;
  /** V2 proves four independent current snapshots, not live policy replacement. */
  readonly policyLifecycle: 'immutable-per-cell-snapshot';
  readonly publishPolicy: 0 | 1;
  readonly tripleCount: number;
  readonly txHash: string;
  readonly ual: string;
}

export interface Rfc64V2SwmBehaviorVector {
  readonly accessPolicy: 0 | 1;
  readonly memberBindingCount: number;
  readonly memberOutcome: 'applied';
  readonly outsiderBindingCount: number;
  readonly outsiderOutcome: 'applied' | 'denied';
}

export interface Rfc64V2SwmPublishPolicyParity {
  readonly behaviorDigest: string;
  readonly curatedCell: 'public-curated' | 'private-curated';
  readonly openCell: 'public-open' | 'private-open';
  readonly vector: Rfc64V2SwmBehaviorVector;
}

export interface VerifiedRfc64V2SwmPolicyMatrix {
  readonly cells: readonly Rfc64V2SwmCellObservation[];
  readonly policyLifecycle: 'four-independent-immutable-snapshots';
  readonly publishPolicyConsultedBySwm: false;
  readonly publishPolicyParity: readonly Rfc64V2SwmPublishPolicyParity[];
  readonly status: 'PASS';
}

const AXES: Readonly<
  Record<Rfc64V2SwmPolicyCell, readonly [accessPolicy: 0 | 1, publishPolicy: 0 | 1]>
> = Object.freeze({
  'public-open': [0, 1],
  'public-curated': [0, 0],
  'private-open': [1, 1],
  'private-curated': [1, 0],
});

const ADDRESS = /^0x[0-9a-f]{40}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const DIGEST = /^(?:0x|sha256:)[0-9a-f]{64}$/u;
const TX_HASH = /^0x[0-9a-f]{64}$/u;
const BEHAVIOR_DOMAIN = 'dkg-rfc64-v2-swm-behavior-v1\n';

export function inspectRfc64V2ProductCapabilities(
  value: unknown,
): Rfc64V2ProductCapabilityInspection {
  const candidate = value !== null && (typeof value === 'object' || typeof value === 'function')
    ? value as Record<string, unknown>
    : null;
  const observed = Object.freeze(Object.fromEntries(
    RFC64_V2_REQUIRED_PRODUCT_CAPABILITIES.map((name) => [
      name,
      candidate !== null && typeof candidate[name] === 'function',
    ]),
  )) as Readonly<Record<Rfc64V2RequiredProductCapability, boolean>>;
  const missing = Object.freeze(
    RFC64_V2_REQUIRED_PRODUCT_CAPABILITIES.filter((name) => !observed[name]),
  );
  return Object.freeze({
    futureTransitionCapability:
      candidate !== null
      && typeof candidate[RFC64_V2_FUTURE_TRANSITION_CAPABILITY] === 'function',
    missing,
    observed,
  });
}

/** Inspect the same built DKGAgent class loaded by current-repo devnet nodes. */
export async function probeBuiltRfc64V2ProductCapabilities(
  repositoryRoot = resolve(import.meta.dirname, '../..'),
): Promise<Rfc64V2ProductCapabilityInspection> {
  const entry = join(repositoryRoot, 'packages/agent/dist/index.js');
  let loaded: Record<string, unknown>;
  try {
    loaded = await import(pathToFileURL(entry).href) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `RFC64_V2_PRODUCT_BUILD_UNAVAILABLE: ${entry}: ${errorMessage(cause)}`,
    );
  }
  const dkgAgent = loaded.DKGAgent;
  if (typeof dkgAgent !== 'function') {
    throw new Error(`RFC64_V2_PRODUCT_BUILD_UNAVAILABLE: ${entry} exports no DKGAgent class`);
  }
  return inspectRfc64V2ProductCapabilities(dkgAgent.prototype);
}

export function requireRfc64V2ProductCapabilities(
  inspection: Rfc64V2ProductCapabilityInspection,
): void {
  if (inspection.missing.length === 0) return;
  throw new Error(
    `RFC64_V2_PRODUCT_CAPABILITIES_UNAVAILABLE: ${inspection.missing.join(', ')}`,
  );
}

export function verifyRfc64V2SwmPolicyMatrix(
  observations: readonly Rfc64V2SwmCellObservation[],
): VerifiedRfc64V2SwmPolicyMatrix {
  if (!Array.isArray(observations) || observations.length !== 4) {
    fail('matrix', 'must contain exactly four policy-cell observations');
  }
  const cells = observations.map((input, index) => verifyCell(
    input,
    RFC64_V2_SWM_POLICY_CELLS[index]!,
    `matrix[${index}]`,
  ));
  if (new Set(cells.map((cell) => cell.contextGraphId)).size !== 4) {
    fail('matrix', 'contextGraphId values must be distinct');
  }
  if (new Set(cells.map((cell) => cell.ual)).size !== 4) {
    fail('matrix', 'UAL values must be distinct');
  }
  if (new Set(cells.map((cell) => cell.contentSha256)).size !== 4) {
    fail('matrix', 'content digests must be distinct');
  }

  const publishPolicyParity = Object.freeze([
    verifyParity(cells, 'public-open', 'public-curated'),
    verifyParity(cells, 'private-open', 'private-curated'),
  ]);
  return Object.freeze({
    cells: Object.freeze(cells),
    policyLifecycle: 'four-independent-immutable-snapshots',
    publishPolicyConsultedBySwm: false,
    publishPolicyParity,
    status: 'PASS',
  });
}

export function digestRfc64V2SwmBindings(
  bindings: readonly Record<string, unknown>[],
): string {
  const normalized = bindings.map((binding) => Object.freeze(Object.fromEntries(
    Object.entries(binding)
      .map(([key, value]) => [key, normalizeBindingCell(value)] as const)
      .sort(([left], [right]) => compareCodePoints(left, right)),
  ))).sort((left, right) => compareCodePoints(
    stableJson(left),
    stableJson(right),
  ));
  return `sha256:${createHash('sha256').update(stableJson(normalized)).digest('hex')}`;
}

function verifyCell(
  input: Rfc64V2SwmCellObservation,
  expectedCell: Rfc64V2SwmPolicyCell,
  path: string,
): Rfc64V2SwmCellObservation {
  if (!isPlainRecord(input)) fail(path, 'must be a plain observation object');
  exact(input.cell, expectedCell, `${path}.cell`);
  const [accessPolicy, publishPolicy] = AXES[expectedCell];
  exact(input.accessPolicy, accessPolicy, `${path}.accessPolicy`);
  exact(input.publishPolicy, publishPolicy, `${path}.publishPolicy`);
  exact(
    input.policyLifecycle,
    'immutable-per-cell-snapshot',
    `${path}.policyLifecycle`,
  );
  nonempty(input.contextGraphId, `${path}.contextGraphId`);
  match(input.authorAgentAddress, ADDRESS, `${path}.authorAgentAddress`);
  match(input.kaId, DECIMAL, `${path}.kaId`);
  match(input.merkleRoot, DIGEST, `${path}.merkleRoot`);
  match(input.contentSha256, /^sha256:[0-9a-f]{64}$/u, `${path}.contentSha256`);
  match(input.txHash, TX_HASH, `${path}.txHash`);
  nonempty(input.assertionUri, `${path}.assertionUri`);
  if (!Number.isSafeInteger(input.tripleCount) || input.tripleCount < 1) {
    fail(`${path}.tripleCount`, 'must be a positive safe integer');
  }
  const ual = parseDeterministicKnowledgeAssetUal(input.ual);
  exact(ual.ual, input.ual, `${path}.ual canonical form`);
  exact(ual.agentAddress, input.authorAgentAddress, `${path}.ual author`);
  const packedKaId = (BigInt(ual.agentAddress) << 96n) | BigInt(ual.kaNumber);
  exact(packedKaId.toString(), input.kaId, `${path}.kaId packed UAL identity`);

  verifyPositiveRead(input.memberRead, input, `${path}.memberRead`);
  if (accessPolicy === 0) {
    verifyPositiveRead(input.outsiderRead, input, `${path}.outsiderRead`);
  } else {
    verifyDeniedRead(input.outsiderRead, `${path}.outsiderRead`);
  }
  return Object.freeze({ ...input });
}

function verifyPositiveRead(
  read: Rfc64V2SwmReadObservation,
  cell: Rfc64V2SwmCellObservation,
  path: string,
): void {
  verifyReadBase(read, path);
  exact(read.outcome, 'applied', `${path}.outcome`);
  exact(read.httpStatus, 200, `${path}.httpStatus`);
  exact(read.bindingCount, cell.tripleCount, `${path}.bindingCount`);
  exact(read.contentSha256, cell.contentSha256, `${path}.contentSha256`);
  exact(read.leakedMarker, false, `${path}.leakedMarker`);
}

function verifyDeniedRead(read: Rfc64V2SwmReadObservation, path: string): void {
  verifyReadBase(read, path);
  exact(read.outcome, 'denied', `${path}.outcome`);
  if (read.httpStatus !== 200 && read.httpStatus !== 403 && read.httpStatus !== 404) {
    fail(`${path}.httpStatus`, 'private denial must be empty-200, 403, or 404');
  }
  exact(read.bindingCount, 0, `${path}.bindingCount`);
  exact(read.contentSha256, null, `${path}.contentSha256`);
  exact(read.leakedMarker, false, `${path}.leakedMarker`);
}

function verifyReadBase(read: Rfc64V2SwmReadObservation, path: string): void {
  if (!isPlainRecord(read)) fail(path, 'must be a plain read observation');
  match(read.agentAddress, ADDRESS, `${path}.agentAddress`);
  if (!Number.isSafeInteger(read.nodeNumber) || read.nodeNumber < 1) {
    fail(`${path}.nodeNumber`, 'must be a positive safe integer');
  }
  if (!Number.isSafeInteger(read.httpStatus) || read.httpStatus < 100 || read.httpStatus > 599) {
    fail(`${path}.httpStatus`, 'must be an HTTP status');
  }
  if (!Number.isSafeInteger(read.bindingCount) || read.bindingCount < 0) {
    fail(`${path}.bindingCount`, 'must be a nonnegative safe integer');
  }
}

function verifyParity(
  cells: readonly Rfc64V2SwmCellObservation[],
  openCell: 'public-open' | 'private-open',
  curatedCell: 'public-curated' | 'private-curated',
): Rfc64V2SwmPublishPolicyParity {
  const open = cells.find((cell) => cell.cell === openCell)!;
  const curated = cells.find((cell) => cell.cell === curatedCell)!;
  const openVector = behaviorVector(open);
  const curatedVector = behaviorVector(curated);
  exact(
    stableJson(openVector),
    stableJson(curatedVector),
    `${openCell}/${curatedCell} SWM behavior`,
  );
  return Object.freeze({
    behaviorDigest: `sha256:${createHash('sha256')
      .update(BEHAVIOR_DOMAIN)
      .update(stableJson(openVector))
      .digest('hex')}`,
    curatedCell,
    openCell,
    vector: openVector,
  });
}

function behaviorVector(cell: Rfc64V2SwmCellObservation): Rfc64V2SwmBehaviorVector {
  return Object.freeze({
    accessPolicy: cell.accessPolicy,
    memberBindingCount: cell.memberRead.bindingCount,
    memberOutcome: 'applied',
    outsiderBindingCount: cell.outsiderRead.bindingCount,
    outsiderOutcome: cell.outsiderRead.outcome,
  });
}

function normalizeBindingCell(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isPlainRecord(value) && typeof value.value === 'string') return value.value;
  throw new TypeError(`SPARQL binding cell must be a string or {value}: ${String(value)}`);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (!isPlainRecord(value)) throw new TypeError('stable JSON input must be plain data');
  return `{${Object.keys(value).sort(compareCodePoints).map(
    (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
  ).join(',')}}`;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonempty(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    fail(path, 'must be a bounded nonempty string');
  }
}

function match(value: unknown, pattern: RegExp, path: string): asserts value is string {
  nonempty(value, path);
  if (!pattern.test(value)) fail(path, `must match ${pattern}`);
}

function exact(actual: unknown, expected: unknown, path: string): void {
  if (!Object.is(actual, expected)) {
    fail(path, `must equal ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function fail(path: string, message: string): never {
  throw new Error(`RFC64_V2_SWM_POLICY_MATRIX_INVALID at ${path}: ${message}`);
}
