/**
 * W2 — finalized update convergence: canonical value contracts.
 *
 * This module owns the package-neutral half of W2: scope identity, exact
 * finalized-event identity, the ordered raw-log commitment, page-assurance
 * proofs, the two-cursor model, the scoped KA candidate parser, and the closed
 * outcome vocabularies. It deliberately holds no chain client, no store, and no
 * I/O, so every rule below is testable without a node, an RPC endpoint, or a
 * database.
 *
 * Two conventions are load-bearing and are asserted rather than assumed:
 *
 * 1. **`scopeId` is derived from the four IDENTITY fields only** — never from
 *    `deploymentBlock`. The deployment anchor is scope *metadata*: proving a
 *    lower anchor must trigger a revision reset and replay *within the same
 *    scope*, which is impossible if lowering it silently mints a new scope id.
 * 2. **Every public input is canonicalized and frozen before it is returned.**
 *    W2's callers hand these values across `await` boundaries into SQLite
 *    transactions; a caller that mutates a page proof after validation would
 *    otherwise persist evidence that was never checked.
 */
import { sha256 } from '@noble/hashes/sha2.js';

import {
  assertCanonicalDigest,
  parseCanonicalDecimalU256,
  type Digest32V1,
  type EvmAddressV1,
} from './sync-wire-scalars.js';

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const CANONICAL_DIGEST_32 = /^0x[0-9a-f]{64}$/;
const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const LOWER_HEX_BYTES = /^0x(?:[0-9a-f]{2})*$/;
const ZERO_EVM_ADDRESS = `0x${'00'.repeat(20)}`;
const UTF8 = new TextEncoder();

/** `(1 << 96) - 1` — the rootless KA-number field width. */
export const MAX_ROOTLESS_KA_NUMBER = (1n << 96n) - 1n;
/** Bound on any single canonicalized string this module will hash or persist. */
const MAX_SCALAR_BYTES = 4_096;
/** Bound on one page's event count, mirroring the transport's own page bound. */
export const MAX_UPDATE_PAGE_EVENTS = 4_096;

// ── closed outcome vocabularies ───────────────────────────────────────────
// Closed unions, exported as value tuples so a consumer can iterate them and a
// verifier can prove the runtime set matches the type. A bare `type` union is
// invisible at runtime and cannot be checked for drift.

export const UPDATE_PAGE_ASSURANCES = ['unattested', 'dual-origin-corroborated'] as const;
export type UpdatePageAssuranceV1 = (typeof UPDATE_PAGE_ASSURANCES)[number];

export const VM_UPDATE_SCAN_OUTCOMES = [
  'corroborated',
  'unattested',
  'empty',
  'no_new_range',
  'rpc_error',
  'malformed',
  'reorg',
  'corroboration_disagreement',
  'oversized',
  'unsupported',
] as const;
export type VmUpdateScanOutcomeV1 = (typeof VM_UPDATE_SCAN_OUTCOMES)[number];

export const VM_UPDATE_EVENT_RESULTS = [
  'newer',
  'duplicate',
  'discarded_resume',
  'invalid',
  'unsupported',
  'unbound',
  'promoted',
] as const;
export type VmUpdateEventResultV1 = (typeof VM_UPDATE_EVENT_RESULTS)[number];

export const VM_UPDATE_COVERAGE_STATES = [
  'bootstrapping',
  'caught_up',
  'reorg_recovering',
  'unavailable',
] as const;
export type VmUpdateCoverageStateV1 = (typeof VM_UPDATE_COVERAGE_STATES)[number];

export const VM_UPDATE_ERROR_CODES = [
  'scope-drift',
  'noncanonical-scalar',
  'foreign-chain',
  'noncanonical-ual',
  'ka-number-overflow',
  'ual-round-trip-failed',
  'ambiguous-w2-identity',
  'page-malformed',
  'page-oversized',
  'assurance-insufficient',
  'origin-not-distinct',
  'commitment-mismatch',
  'cursor-regression',
  'coverage-invalid',
] as const;
export type VmUpdateErrorCodeV1 = (typeof VM_UPDATE_ERROR_CODES)[number];

/**
 * A bounded, redactable failure.
 *
 * `detail` is capped and carries only values this module itself canonicalized —
 * never raw RPC payloads, endpoint URLs, or peer identifiers. W2's structured
 * logs emit `code` and `detail`; anything unbounded belongs in neither.
 */
export class VmUpdateConvergenceError extends Error {
  readonly code: VmUpdateErrorCodeV1;
  readonly detail: string;

  constructor(code: VmUpdateErrorCodeV1, detail: string, options?: { cause?: unknown }) {
    const bounded = detail.length > 200 ? `${detail.slice(0, 197)}...` : detail;
    super(`vm-update: ${code}: ${bounded}`, options);
    this.name = 'VmUpdateConvergenceError';
    this.code = code;
    this.detail = bounded;
  }
}

function fail(code: VmUpdateErrorCodeV1, detail: string, cause?: unknown): never {
  throw new VmUpdateConvergenceError(code, detail, cause === undefined ? undefined : { cause });
}

// ── canonical scalars ─────────────────────────────────────────────────────

function boundedString(value: unknown, label: string): string {
  if (typeof value !== 'string') fail('noncanonical-scalar', `${label} must be a string`);
  if (value.length > MAX_SCALAR_BYTES || UTF8.encode(value).byteLength > MAX_SCALAR_BYTES) {
    fail('noncanonical-scalar', `${label} exceeds ${MAX_SCALAR_BYTES} bytes`);
  }
  return value;
}

/** Canonical lowercase 20-byte address; the zero address is REJECTED. */
export function canonicalEvmAddress(value: unknown, label = 'address'): EvmAddressV1 {
  const text = boundedString(value, label);
  if (!EVM_ADDRESS.test(text)) {
    fail('noncanonical-scalar', `${label} must be a lowercase 20-byte 0x EVM address`);
  }
  if (text === ZERO_EVM_ADDRESS) fail('noncanonical-scalar', `${label} must not be the zero address`);
  return text as EvmAddressV1;
}

/**
 * The zero-permitting address canonicalizer, written for exactly one field.
 *
 * `author` is legally `address(0)` on the admin path: `updateKnowledgeAsset` is
 * `onlyContracts`, which `HubDependent._checkHubContract()` also satisfies for
 * the Hub OWNER EOA, so the lifecycle's `AuthorRequired()` guard is bypassable
 * and `DKGKnowledgeAssets.sol` emits the zero author verbatim. Both shipped
 * helpers — `assertCanonicalNonzeroEvmAddress` and `assertCanonicalEvmAddress` —
 * reject zero, which would turn a legal on-chain event into an undecodable page.
 * A decode error is not a `blockingMutation` and therefore never latches, so the
 * indexer would wedge with no operator-visible reason.
 *
 * Use this for `author`. Use {@link canonicalEvmAddress} everywhere else.
 */
export function canonicalNullableAuthorAddress(
  value: unknown,
  label = 'author',
): EvmAddressV1 | null {
  if (value === null) return null;
  const text = boundedString(value, label);
  if (!EVM_ADDRESS.test(text)) {
    fail('noncanonical-scalar', `${label} must be a lowercase 20-byte 0x EVM address or null`);
  }
  return text === ZERO_EVM_ADDRESS ? null : (text as EvmAddressV1);
}

export function canonicalDigest32(value: unknown, label = 'digest'): Digest32V1 {
  const text = boundedString(value, label);
  if (!CANONICAL_DIGEST_32.test(text)) {
    fail('noncanonical-scalar', `${label} must be a lowercase 32-byte 0x digest`);
  }
  return text as Digest32V1;
}

/** A canonical unsigned decimal with no leading-zero alias. */
export function canonicalUnsignedDecimal(value: unknown, label = 'value'): bigint {
  const text = boundedString(value, label);
  if (!CANONICAL_UNSIGNED_DECIMAL.test(text)) {
    fail('noncanonical-scalar', `${label} must be a canonical unsigned decimal`);
  }
  return parseCanonicalDecimalU256(text, label);
}

/** A non-negative safe integer; block numbers and log indices are numbers on this wire. */
export function canonicalBlockNumber(value: unknown, label = 'blockNumber'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail('noncanonical-scalar', `${label} must be a non-negative safe integer`);
  }
  return value;
}

// ── scope identity ────────────────────────────────────────────────────────

export interface VmUpdateScopeIdentityV1 {
  chainId: string;
  deploymentId: string;
  knowledgeAssetStorageAddress: string;
  contextGraphStorageAddress: string;
}

export type DeploymentBlockSourceV1 = 'shipped' | 'configured' | 'historical';

export interface VmUpdateScopeV1 extends VmUpdateScopeIdentityV1 {
  scopeId: string;
  /** Scope METADATA. It never changes `scopeId` (see invariant 11). */
  deploymentBlock: number;
  deploymentBlockSource: DeploymentBlockSourceV1;
  deploymentBlockHistoricallyValidated: boolean;
}

const SCOPE_ID_DOMAIN = UTF8.encode('dkg:w2:vm-update-scope:v1');

function digestWithDomain(domain: Uint8Array, canonicalBytes: Uint8Array): Digest32V1 {
  const hasher = sha256.create();
  hasher.update(domain);
  hasher.update(canonicalBytes);
  let result = '0x';
  for (const byte of hasher.digest()) result += byte.toString(16).padStart(2, '0');
  assertCanonicalDigest(result, 'computed vm-update digest');
  return result;
}

/**
 * Length-prefixed join. Concatenating with a separator would let two distinct
 * field tuples hash identically whenever a field can contain the separator.
 */
function lengthPrefixed(parts: readonly string[]): Uint8Array {
  const encoded = parts.map((part) => UTF8.encode(part));
  const total = encoded.reduce((sum, part) => sum + 4 + part.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of encoded) {
    view.setUint32(offset, part.byteLength, false);
    offset += 4;
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * THE scope-id helper. It is not hand-concatenated at call sites, and it does
 * not include `deploymentBlock` — see the module header.
 */
export function deriveVmUpdateScopeId(identity: VmUpdateScopeIdentityV1): string {
  const chainId = canonicalUnsignedDecimal(identity.chainId, 'scope.chainId').toString();
  const deploymentId = boundedString(identity.deploymentId, 'scope.deploymentId');
  if (deploymentId.length === 0) fail('noncanonical-scalar', 'scope.deploymentId must not be empty');
  const kaStorage = canonicalEvmAddress(
    identity.knowledgeAssetStorageAddress,
    'scope.knowledgeAssetStorageAddress',
  );
  const cgStorage = canonicalEvmAddress(
    identity.contextGraphStorageAddress,
    'scope.contextGraphStorageAddress',
  );
  return digestWithDomain(
    SCOPE_ID_DOMAIN,
    lengthPrefixed([chainId, deploymentId, kaStorage, cgStorage]),
  );
}

/** Canonicalize a scope and recompute its `scopeId`; a supplied mismatch fails closed. */
export function canonicalVmUpdateScope(input: VmUpdateScopeV1): Readonly<VmUpdateScopeV1> {
  const identity: VmUpdateScopeIdentityV1 = {
    chainId: canonicalUnsignedDecimal(input.chainId, 'scope.chainId').toString(),
    deploymentId: boundedString(input.deploymentId, 'scope.deploymentId'),
    knowledgeAssetStorageAddress: canonicalEvmAddress(
      input.knowledgeAssetStorageAddress,
      'scope.knowledgeAssetStorageAddress',
    ),
    contextGraphStorageAddress: canonicalEvmAddress(
      input.contextGraphStorageAddress,
      'scope.contextGraphStorageAddress',
    ),
  };
  const scopeId = deriveVmUpdateScopeId(identity);
  if (typeof input.scopeId === 'string' && input.scopeId !== scopeId) {
    fail('scope-drift', 'supplied scopeId does not match its identity fields');
  }
  if (
    input.deploymentBlockSource !== 'shipped' &&
    input.deploymentBlockSource !== 'configured' &&
    input.deploymentBlockSource !== 'historical'
  ) {
    fail('noncanonical-scalar', 'scope.deploymentBlockSource is not a known source');
  }
  if (typeof input.deploymentBlockHistoricallyValidated !== 'boolean') {
    fail('noncanonical-scalar', 'scope.deploymentBlockHistoricallyValidated must be a boolean');
  }
  return Object.freeze({
    ...identity,
    scopeId,
    deploymentBlock: canonicalBlockNumber(input.deploymentBlock, 'scope.deploymentBlock'),
    deploymentBlockSource: input.deploymentBlockSource,
    deploymentBlockHistoricallyValidated: input.deploymentBlockHistoricallyValidated,
  });
}

// ── exact event identity ──────────────────────────────────────────────────

export interface FinalizedEventPositionV1 {
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  logIndex: number;
}

export interface FinalizedKnowledgeAssetUpdateV1 extends FinalizedEventPositionV1 {
  kind: 'lifecycle-update' | 'root-added';
  kaId: string;
  author: string | null;
  merkleRoot: string;
}

export interface FinalizedUnsupportedKnowledgeAssetRootMutationV1 extends FinalizedEventPositionV1 {
  kind: 'roots-replaced' | 'root-removed';
  kaId: string;
}

function canonicalPosition(input: FinalizedEventPositionV1, label: string): FinalizedEventPositionV1 {
  return {
    blockNumber: canonicalBlockNumber(input.blockNumber, `${label}.blockNumber`),
    blockHash: canonicalDigest32(input.blockHash, `${label}.blockHash`),
    transactionHash: canonicalDigest32(input.transactionHash, `${label}.transactionHash`),
    transactionIndex: canonicalBlockNumber(input.transactionIndex, `${label}.transactionIndex`),
    logIndex: canonicalBlockNumber(input.logIndex, `${label}.logIndex`),
  };
}

export function canonicalFinalizedUpdate(
  input: FinalizedKnowledgeAssetUpdateV1,
): Readonly<FinalizedKnowledgeAssetUpdateV1> {
  if (input.kind !== 'lifecycle-update' && input.kind !== 'root-added') {
    fail('page-malformed', 'update.kind is not a supported v1 repair event');
  }
  // `root-added` carries no author field at all; a non-null author on one is a
  // decode bug, not a legal event, and silently dropping it would let a faulty
  // decoder attribute an update to the wrong address.
  if (input.kind === 'root-added' && input.author !== null) {
    fail('page-malformed', 'root-added carries no author field; author must be null');
  }
  return Object.freeze({
    kind: input.kind,
    kaId: canonicalUnsignedDecimal(input.kaId, 'update.kaId').toString(),
    author: canonicalNullableAuthorAddress(input.author, 'update.author'),
    merkleRoot: canonicalDigest32(input.merkleRoot, 'update.merkleRoot'),
    ...canonicalPosition(input, 'update'),
  });
}

/**
 * Lexicographic order over `(blockNumber, transactionIndex, logIndex)`.
 *
 * `transactionHash` is an identity/equality check, NOT an ordering dimension:
 * ordering by it would make the reducer's resume point depend on hash bytes,
 * which carry no chain order.
 */
export function compareEventPosition(a: FinalizedEventPositionV1, b: FinalizedEventPositionV1): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  if (a.transactionIndex !== b.transactionIndex) return a.transactionIndex < b.transactionIndex ? -1 : 1;
  if (a.logIndex !== b.logIndex) return a.logIndex < b.logIndex ? -1 : 1;
  return 0;
}

export function sameEventIdentity(a: FinalizedEventPositionV1, b: FinalizedEventPositionV1): boolean {
  return (
    compareEventPosition(a, b) === 0 &&
    a.blockHash === b.blockHash &&
    a.transactionHash === b.transactionHash
  );
}

// ── ordered raw-log commitment ────────────────────────────────────────────

export interface RawLogV1 {
  address: string;
  topics: readonly string[];
  data: string;
  position: FinalizedEventPositionV1;
}

const LOG_COMMITMENT_DOMAIN = UTF8.encode('dkg:w2:ordered-log-commitment:v1');

/**
 * Ordered commitment over address, topics, data AND exact identity.
 *
 * Committing to identity alone would let a faulty endpoint return altered
 * payload bytes at the same positions and still corroborate — which is the
 * exact failure the two-origin comparison exists to catch.
 */
export function orderedLogCommitment(logs: readonly RawLogV1[]): Digest32V1 {
  if (logs.length > MAX_UPDATE_PAGE_EVENTS) {
    fail('page-oversized', `page carries ${logs.length} logs, above ${MAX_UPDATE_PAGE_EVENTS}`);
  }
  const parts: string[] = [];
  let previous: FinalizedEventPositionV1 | undefined;
  for (const log of logs) {
    const position = canonicalPosition(log.position, 'log');
    if (previous !== undefined) {
      const order = compareEventPosition(previous, position);
      if (order > 0) fail('page-malformed', 'logs are not in ascending chain order');
      if (order === 0) fail('page-malformed', 'two logs occupy one ordering position');
    }
    previous = position;
    const data = boundedString(log.data, 'log.data');
    if (!LOWER_HEX_BYTES.test(data)) fail('noncanonical-scalar', 'log.data must be lowercase 0x bytes');
    parts.push(
      canonicalEvmAddress(log.address, 'log.address'),
      String(log.topics.length),
      ...log.topics.map((topic, index) => canonicalDigest32(topic, `log.topics[${index}]`)),
      data,
      String(position.blockNumber),
      position.blockHash,
      position.transactionHash,
      String(position.transactionIndex),
      String(position.logIndex),
    );
  }
  return digestWithDomain(LOG_COMMITMENT_DOMAIN, lengthPrefixed(parts));
}

// ── page assurance proof ──────────────────────────────────────────────────

export interface BlockRefV1 {
  blockNumber: number;
  blockHash: string;
}

export interface FinalizedUpdatePageProofV1 {
  assurance: UpdatePageAssuranceV1;
  normalizedOrigins: readonly string[];
  from: BlockRefV1;
  through: BlockRefV1;
  finalizedAnchor: BlockRefV1;
  orderedLogCommitment: string;
}

function canonicalBlockRef(input: BlockRefV1, label: string): Readonly<BlockRefV1> {
  return Object.freeze({
    blockNumber: canonicalBlockNumber(input.blockNumber, `${label}.blockNumber`),
    blockHash: canonicalDigest32(input.blockHash, `${label}.blockHash`),
  });
}

/**
 * Normalize an endpoint origin for the distinctness test.
 *
 * Distinctness is by ORIGIN, not by URL: two URLs differing only in path or
 * query are one provider and corroborate nothing. The normalized form is
 * lowercase `scheme://host:port` with no credentials, path, query, or fragment,
 * so a credentialed and an uncredentialed URL for one host collapse together
 * rather than counting as two origins.
 */
export function normalizeEndpointOrigin(value: unknown, label = 'origin'): string {
  const text = boundedString(value, label);
  let url: URL;
  try {
    url = new URL(text);
  } catch (cause) {
    fail('origin-not-distinct', `${label} is not a valid absolute URL`, cause);
  }
  const port = url.port === '' ? '' : `:${url.port}`;
  return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${port}`;
}

/**
 * Validate a page proof.
 *
 * `dual-origin-corroborated` requires exactly two DISTINCT normalized origins.
 * One origin, or two spellings of one origin, is `unattested` — it may move
 * observation but never authorizes the reducer, `caught-up`, target resolution,
 * or W2b.
 */
export function canonicalPageProof(
  input: FinalizedUpdatePageProofV1,
): Readonly<FinalizedUpdatePageProofV1> {
  if (input.assurance !== 'unattested' && input.assurance !== 'dual-origin-corroborated') {
    fail('assurance-insufficient', 'proof.assurance is not a known assurance level');
  }
  if (!Array.isArray(input.normalizedOrigins) || input.normalizedOrigins.length === 0) {
    fail('origin-not-distinct', 'proof.normalizedOrigins must carry at least one origin');
  }
  const origins = input.normalizedOrigins.map((origin, index) =>
    normalizeEndpointOrigin(origin, `proof.normalizedOrigins[${index}]`),
  );
  const distinct = new Set(origins);
  if (distinct.size !== origins.length) {
    fail('origin-not-distinct', 'proof.normalizedOrigins repeats one normalized origin');
  }
  if (input.assurance === 'dual-origin-corroborated' && distinct.size !== 2) {
    fail(
      'origin-not-distinct',
      `dual-origin-corroborated requires exactly two distinct origins, got ${distinct.size}`,
    );
  }
  if (input.assurance === 'unattested' && distinct.size > 2) {
    fail('origin-not-distinct', 'a proof carries at most two origins');
  }
  const from = canonicalBlockRef(input.from, 'proof.from');
  const through = canonicalBlockRef(input.through, 'proof.through');
  const finalizedAnchor = canonicalBlockRef(input.finalizedAnchor, 'proof.finalizedAnchor');
  if (through.blockNumber < from.blockNumber) {
    fail('page-malformed', 'proof.through is below proof.from');
  }
  // A page above the finalized anchor is not finalized evidence, whatever the
  // endpoint claimed.
  if (through.blockNumber > finalizedAnchor.blockNumber) {
    fail('page-malformed', 'proof.through is above the finalized anchor');
  }
  return Object.freeze({
    assurance: input.assurance,
    normalizedOrigins: Object.freeze([...origins]),
    from,
    through,
    finalizedAnchor,
    orderedLogCommitment: canonicalDigest32(
      input.orderedLogCommitment,
      'proof.orderedLogCommitment',
    ),
  });
}

/** Only a corroborated page may move authoritative coverage or feed the reducer. */
export function isAuthoritativePage(proof: FinalizedUpdatePageProofV1): boolean {
  return proof.assurance === 'dual-origin-corroborated';
}

// ── two-cursor model ──────────────────────────────────────────────────────

export interface UnattestedObservationV1 extends BlockRefV1 {
  normalizedOrigin: string;
}

export interface UpdateCoverageCursorV1 {
  scannedThroughUnattested?: UnattestedObservationV1;
  coveredThrough: null | BlockRefV1;
  resumeAfter?: FinalizedEventPositionV1;
}

export function canonicalCoverageCursor(
  input: UpdateCoverageCursorV1,
): Readonly<UpdateCoverageCursorV1> {
  const coveredThrough =
    input.coveredThrough === null || input.coveredThrough === undefined
      ? null
      : canonicalBlockRef(input.coveredThrough, 'cursor.coveredThrough');
  const resumeAfter =
    input.resumeAfter === undefined
      ? undefined
      : Object.freeze(canonicalPosition(input.resumeAfter, 'cursor.resumeAfter'));
  const scanned =
    input.scannedThroughUnattested === undefined
      ? undefined
      : Object.freeze({
          ...canonicalBlockRef(input.scannedThroughUnattested, 'cursor.scannedThroughUnattested'),
          normalizedOrigin: normalizeEndpointOrigin(
            input.scannedThroughUnattested.normalizedOrigin,
            'cursor.scannedThroughUnattested.normalizedOrigin',
          ),
        });
  // A resume point below covered coverage would re-reduce settled events; one
  // far above it would skip a range that was never corroborated.
  if (coveredThrough !== null && resumeAfter !== undefined) {
    if (resumeAfter.blockNumber <= coveredThrough.blockNumber) {
      fail('cursor-regression', 'resumeAfter is at or below coveredThrough');
    }
  }
  return Object.freeze({
    ...(scanned === undefined ? {} : { scannedThroughUnattested: scanned }),
    coveredThrough,
    ...(resumeAfter === undefined ? {} : { resumeAfter }),
  });
}

/**
 * The next block to scan.
 *
 * With a partial page the scan RESTARTS at `resumeAfter.blockNumber` — it does
 * not skip to the next block — because the reducer must re-validate that
 * block's hash and discard only identities at or below `resumeAfter`. Starting
 * one block later would silently drop the rest of a partially reduced block.
 */
export function nextScanFromBlock(
  cursor: UpdateCoverageCursorV1,
  deploymentBlock: number,
): number {
  if (cursor.resumeAfter !== undefined) return cursor.resumeAfter.blockNumber;
  if (cursor.coveredThrough === null) return deploymentBlock;
  return cursor.coveredThrough.blockNumber + 1;
}

/** True when this identity was already reduced under the current resume point. */
export function isDiscardedByResume(
  event: FinalizedEventPositionV1,
  resumeAfter: FinalizedEventPositionV1 | undefined,
): boolean {
  if (resumeAfter === undefined) return false;
  return compareEventPosition(event, resumeAfter) <= 0;
}

// ── scoped KA candidate parser ────────────────────────────────────────────

export type CanonicalScopedKaCandidateKindV1 = 'legacy-sequential' | 'rootless-packed';

export interface CanonicalScopedKaCandidateV1 {
  kind: CanonicalScopedKaCandidateKindV1;
  kaId: string;
}

export interface CanonicalScopedKaCandidateSetV1 {
  scopeId: string;
  ual: string;
  candidates: readonly CanonicalScopedKaCandidateV1[];
}

const UAL_PATTERN = /^did:dkg:([^/]+)\/([^/]+)\/([^/]+)$/;

/**
 * Build the canonical UAL for a resolved on-chain KA id.
 *
 * Mirrors `buildReconciledKnowledgeAssetUal` in `packages/agent/src/ka-identity.ts`.
 * It cannot import it — `agent` depends on `core`, not the reverse — so
 * `packages/agent/test/w2-ual-parity.test.ts` asserts the two produce
 * byte-identical output across the legacy/rootless boundary. That parity test is
 * the external anchor: without it this is a transcription that can drift
 * silently, and the drift would make W2's fence select the wrong KA.
 */
export function buildScopedKnowledgeAssetUal(
  chainId: string,
  legacyStorageAddress: string,
  kaId: bigint,
): string {
  if (kaId >> 96n === 0n) {
    return `did:dkg:${chainId}/${legacyStorageAddress.toLowerCase()}/${kaId.toString()}`;
  }
  const agentAddress = `0x${(kaId >> 96n).toString(16).padStart(40, '0')}`;
  const kaNumber = kaId & MAX_ROOTLESS_KA_NUMBER;
  return `did:dkg:${chainId}/${agentAddress.toLowerCase()}/${kaNumber.toString()}`;
}

/**
 * Parse a verified UAL into the one or two on-chain ids it could denote.
 *
 * The two RESOLVED domains are disjoint by authenticated on-chain semantics —
 * legacy has `kaId >> 96 === 0`, rootless has `kaId >> 96 !== 0` — but the UAL
 * SYNTAX is not: for `did:dkg:<chain>/<KA-storage>/7` both candidates round-trip
 * byte-for-byte. This function therefore refuses to guess. It returns both, and
 * the store resolves which is live by intersecting them with that exact
 * scope/revision's chain-derived provenance. Two live matches is
 * `ambiguous-w2-identity` and fails the graph mutation closed; picking either
 * would silently attribute a write to the wrong KA.
 */
export function canonicalScopedKaCandidatesFromVerifiedUal(
  scope: VmUpdateScopeV1,
  verifiedUal: string,
): Readonly<CanonicalScopedKaCandidateSetV1> {
  const canonicalScope = canonicalVmUpdateScope(scope);
  const ual = boundedString(verifiedUal, 'ual');
  const match = UAL_PATTERN.exec(ual);
  if (match === null) {
    fail('noncanonical-ual', 'ual is not the canonical did:dkg:<chain>/<address>/<number> form');
  }
  const [, chainSegment, addressSegment, numberSegment] = match;

  if (chainSegment !== canonicalScope.chainId) {
    fail('foreign-chain', 'ual chain id is not this scope chain id');
  }
  // Round-trip, not `toLowerCase()`: accepting a mixed-case address here and
  // normalizing it would make two distinct UAL spellings denote one KA, so a
  // caller could address the same fence row two ways.
  if (!EVM_ADDRESS.test(addressSegment)) {
    fail('noncanonical-ual', 'ual address segment is not a lowercase 20-byte 0x address');
  }
  if (!CANONICAL_UNSIGNED_DECIMAL.test(numberSegment)) {
    fail('noncanonical-ual', 'ual number segment is not a canonical decimal (leading-zero alias?)');
  }
  const number = BigInt(numberSegment);
  if (number > MAX_ROOTLESS_KA_NUMBER) {
    fail('ka-number-overflow', 'ual number segment exceeds the uint96 KA-number field');
  }

  const candidates: CanonicalScopedKaCandidateV1[] = [];

  // The bounded rootless candidate always exists — including number zero, which
  // is a legal per-author KA number.
  const packed = (BigInt(addressSegment) << 96n) | number;
  candidates.push({ kind: 'rootless-packed', kaId: packed.toString() });

  // The sequential candidate exists only when the UAL addresses the scope's own
  // KA storage contract with a nonzero id. `number` is already known to be
  // below 2^96 from the overflow check above, so it cannot itself be a packed
  // id — restating that here would be a condition that can never be false.
  if (addressSegment === canonicalScope.knowledgeAssetStorageAddress && number !== 0n) {
    candidates.push({ kind: 'legacy-sequential', kaId: number.toString() });
  }

  for (const candidate of candidates) {
    const roundTrip = buildScopedKnowledgeAssetUal(
      canonicalScope.chainId,
      canonicalScope.knowledgeAssetStorageAddress,
      BigInt(candidate.kaId),
    );
    if (roundTrip !== ual) {
      fail(
        'ual-round-trip-failed',
        `${candidate.kind} candidate does not round-trip to the supplied ual`,
      );
    }
  }

  const distinct = new Set(candidates.map((candidate) => candidate.kaId));
  if (distinct.size !== candidates.length) {
    fail('noncanonical-ual', 'candidate set is not distinct');
  }

  return Object.freeze({
    scopeId: canonicalScope.scopeId,
    ual,
    candidates: Object.freeze(candidates.map((candidate) => Object.freeze(candidate))),
  });
}

// ── store interface ───────────────────────────────────────────────────────

export interface FinalizedKaTargetV1 {
  scopeId: string;
  coverageRevision: number;
  generation: number;
  orphanGeneration?: number;
  anchor: BlockRefV1;
  localCgId: string;
  onChainCgId: string;
  kaId: string;
  ual: string;
  root: string;
  rootCount: string;
  publisher: string | null;
  latestUpdate?: FinalizedKnowledgeAssetUpdateV1;
  materializedVersion: { blockNumber: number; txIndex: number };
}

/**
 * The durable surface W2a needs. Implemented by the node-UI SQLite store; kept
 * here so the reducer's rules can be tested against an in-memory fake without
 * the store package.
 */
export interface VmUpdateConvergenceStoreV1 {
  loadScope(scopeId: string): Promise<Readonly<VmUpdateScopeV1> | null>;
  loadCursor(scopeId: string): Promise<Readonly<UpdateCoverageCursorV1> | null>;
  /** Reducing a chunk advances only `resumeAfter`, atomically with the events. */
  reduceChunk(input: {
    scopeId: string;
    coverageRevision: number;
    events: readonly Readonly<FinalizedKnowledgeAssetUpdateV1>[];
    resumeAfter: FinalizedEventPositionV1;
  }): Promise<void>;
  /** Completing a page advances `coveredThrough` and clears `resumeAfter`. */
  completePage(input: {
    scopeId: string;
    coverageRevision: number;
    coveredThrough: BlockRefV1;
  }): Promise<void>;
  /** An unattested page moves observation only; it never touches coverage. */
  recordUnattestedObservation(input: {
    scopeId: string;
    observation: UnattestedObservationV1;
  }): Promise<void>;
}
