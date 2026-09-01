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
  MAX_KA_ID_V1,
  MAX_ROOTLESS_KA_NUMBER_V1,
  assertCanonicalUalChainIdV1,
  buildKnowledgeAssetUalFromOnChainIdV1,
} from './ka-ual-identity.js';
import {
  assertCanonicalDigest,
  assertNonNegativeSafeInteger,
  assertCanonicalEvmAddress,
  assertCanonicalHexBytes,
  parseCanonicalDecimalU256,
  type Digest32V1,
  type EvmAddressV1,
} from './sync-wire-scalars.js';
import {
  adapt,
  boundedString,
  fail,
} from './vm-update-errors.js';
import { type KnowledgeAssetRootMutationKindV1 } from './knowledge-asset-root-mutation-v1.js';
import {
  canonicalEventPositionV1,
  compareEventPosition,
  sameEventIdentity,
  type FinalizedEventPositionV1,
  type LooseEventPositionInputV1,
} from './finalized-event-position-v1.js';

// The error plumbing and the exact-event-position model were EXTRACTED to
// their own modules (PR #2436 review r16 — this file crossed the 1,000-line
// threshold). The public surface is unchanged: every moved public name is
// re-exported here, so the core index's star export serves the same API.
export {
  VM_UPDATE_ERROR_CODES,
  VmUpdateConvergenceError,
} from './vm-update-errors.js';
export type { VmUpdateErrorCodeV1 } from './vm-update-errors.js';
export {
  canonicalEventPositionV1,
  compareEventPosition,
  sameEventIdentity,
} from './finalized-event-position-v1.js';

export function canonicalDigest32(value: unknown, label = 'digest'): Digest32V1 {
  const text = boundedString(value, label);
  return adapt(label, () => {
    assertCanonicalDigest(text, label);
    return text;
  });
}

/** The ONE non-negative-safe-integer rule (r23), adapted into W2's typed code. */
export function canonicalBlockNumber(value: unknown, label = 'blockNumber'): number {
  return adapt(label, () => {
    assertNonNegativeSafeInteger(value, label);
    return value;
  });
}

/**
 * VM-typed adaptation of the NEUTRAL position validator (review r17): W2's
 * callers keep their `noncanonical-scalar` error contract while unrelated
 * consumers of `canonicalEventPositionV1` no longer receive VM terminology.
 */
function vmEventPosition(input: LooseEventPositionInputV1, label: string): FinalizedEventPositionV1 {
  return adapt(label, () => canonicalEventPositionV1(input, label));
}
export type {
  CanonicalEventPositionV1,
  FinalizedEventPositionV1,
  LooseEventPositionInputV1,
} from './finalized-event-position-v1.js';

/**
 * `sync-wire-scalars.ts` is the single source of truth for canonical EVM
 * addresses, digests, unsigned decimals and hex bytes. This module deliberately
 * holds NO copies of those regexes: a second transcription drifts silently, and
 * the drift would be two different canonical-scalar policies inside one package.
 * Everything below adapts those assertions into W2's typed error codes.
 *
 * The one constant that stays is the zero address, and only because W2 must
 * ACCEPT it for `author` where every shipped helper rejects it — see
 * {@link canonicalNullableAuthorAddress}. It is a literal, not a validator.
 */
const ZERO_EVM_ADDRESS = `0x${'00'.repeat(20)}`;
const UTF8 = new TextEncoder();


/** `(1 << 96) - 1` — the rootless KA-number field width. Re-exported from the owner. */
export const MAX_ROOTLESS_KA_NUMBER = MAX_ROOTLESS_KA_NUMBER_V1;
const MAX_UINT256 = MAX_KA_ID_V1;

/**
 * Aggregate bound on the raw topic+data hex a single page may carry.
 *
 * Enforced while walking the page, before the commitment input is assembled, so
 * an oversized page is refused rather than expanded. The transport answers this
 * with adaptive range halving.
 */
export const MAX_ENCODED_UPDATE_LOG_BYTES_PER_PAGE = 8 * 1024 * 1024;
/** Bound on one page's event count, mirroring the transport's own page bound. */
export const MAX_UPDATE_PAGE_EVENTS = 4_096;
/**
 * A valid EVM log carries 0..4 topics (LOG0..LOG4). The page-count bound alone
 * does not constrain this: ONE log with a million topics passes it, then
 * allocates and hashes a million entries. Since these logs come straight off an
 * untrusted RPC response, the per-log bound has to be here.
 */
export const MAX_LOG_TOPICS = 4;

// ── closed outcome vocabularies ───────────────────────────────────────────
// Closed unions, exported as value tuples so a consumer can iterate them and a
// verifier can prove the runtime set matches the type. A bare `type` union is
// invisible at runtime and cannot be checked for drift.

export const UPDATE_PAGE_ASSURANCES = Object.freeze(['unattested', 'dual-origin-corroborated'] as const);
export type UpdatePageAssuranceV1 = (typeof UPDATE_PAGE_ASSURANCES)[number];

export const VM_UPDATE_SCAN_OUTCOMES = Object.freeze([
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
] as const);
export type VmUpdateScanOutcomeV1 = (typeof VM_UPDATE_SCAN_OUTCOMES)[number];

export const VM_UPDATE_EVENT_RESULTS = Object.freeze([
  'newer',
  'duplicate',
  'discarded_resume',
  'invalid',
  'unsupported',
  'unbound',
  'promoted',
] as const);
export type VmUpdateEventResultV1 = (typeof VM_UPDATE_EVENT_RESULTS)[number];

export const VM_UPDATE_COVERAGE_STATES = Object.freeze([
  'bootstrapping',
  'caught_up',
  'reorg_recovering',
  'unavailable',
] as const);
export type VmUpdateCoverageStateV1 = (typeof VM_UPDATE_COVERAGE_STATES)[number];



/**
 * Snapshot an array as dense, own, enumerable DATA properties — or fail.
 *
 * `Array.isArray` plus `.map()` is not enough, and the gap is exploitable:
 * `map` skips holes while `new Set(sparse)` observes them as `undefined`, so
 * `['https://a', <hole>]` has length 2 AND set size 2 and was accepted as two
 * distinct corroborating origins. The frozen proof then serialized as one URL
 * and a `null`.
 *
 * Descriptors are read with `getOwnPropertyDescriptor`, which does NOT invoke
 * getters, so an accessor-backed element is refused without running caller code.
 * Holes and inherited indices have no own descriptor and are refused the same
 * way.
 *
 * `Array.from` is not a substitute: it materializes holes as `undefined` and can
 * invoke an iterator and getters. `Object.isFrozen` is not a substitute either —
 * a caller can freeze a malformed object itself.
 */
function denseDataArray(
  value: unknown,
  label: string,
  maxLength: number,
): readonly unknown[] {
  if (!Array.isArray(value)) fail('page-malformed', `${label} must be an array`);
  // Length is checked BEFORE any iteration, so an absurd length cannot cost a
  // walk before it is refused.
  if (value.length > maxLength) {
    fail('page-oversized', `${label} carries ${value.length} entries, above ${maxLength}`);
  }
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined) {
      fail('page-malformed', `${label}[${index}] is a hole or inherited, not own data`);
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('page-malformed', `${label}[${index}] is an accessor, not a data property`);
    }
    if (!descriptor.enumerable) {
      fail('page-malformed', `${label}[${index}] is not enumerable`);
    }
    out.push(descriptor.value);
  }
  return out;
}

// ── canonical scalars ─────────────────────────────────────────────────────


/** Canonical lowercase 20-byte address; the zero address is REJECTED. */
export function canonicalEvmAddress(value: unknown, label = 'address'): EvmAddressV1 {
  const text = boundedString(value, label);
  return adapt(label, () => {
    assertCanonicalEvmAddress(text, label);
    return text;
  });
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
  // Only the CANONICAL zero spelling short-circuits. A noncanonical zero such as
  // `0X00…` misses this equality and falls through to the shipped assertion,
  // which rejects it — so permitting zero does not also permit sloppy zero.
  if (text === ZERO_EVM_ADDRESS) return null;
  return canonicalEvmAddress(text, label);
}


/**
 * A canonical UAL chain id.
 *
 * This is NOT the numeric EVM chain id. `ChainAdapter.chainId` is **namespaced**
 * — `base:84532`, `otp:20430`, `evm:31337` — and its own doc comment says it is
 * "not directly parseable with `BigInt()`"; `getEvmChainId()` is the numeric
 * one. UALs are built from the namespaced form
 * (`chain-adapter.ts:960,1534-1540`), so a scope validated as a bare decimal
 * would reject every real mainnet and testnet UAL while passing a test suite
 * that only used `31337`.
 *
 * Accepted: an optional lowercase namespace, then a canonical decimal with no
 * leading-zero alias. The decimal tail is canonicalized so `base:084532` cannot
 * become a second spelling of one chain.
 */
export function canonicalUalChainId(value: unknown, label = 'chainId'): string {
  const text = boundedString(value, label);
  // The rule itself is owned by `ka-ual-identity.ts`; this adapts its error into
  // W2's typed code rather than restating the rule.
  return adapt(label, () => assertCanonicalUalChainIdV1(text, label));
}

/** A canonical unsigned decimal with no leading-zero alias. */
export function canonicalUnsignedDecimal(value: unknown, label = 'value'): bigint {
  const text = boundedString(value, label);
  return adapt(label, () => parseCanonicalDecimalU256(text, label));
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
  const chainId = canonicalUalChainId(identity.chainId, 'scope.chainId');
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
    chainId: canonicalUalChainId(input.chainId, 'scope.chainId'),
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


export interface FinalizedKnowledgeAssetUpdateV1 extends FinalizedEventPositionV1 {
  kind: Extract<KnowledgeAssetRootMutationKindV1, 'lifecycle-update' | 'root-added'>;
  kaId: string;
  author: string | null;
  merkleRoot: string;
}

export interface FinalizedUnsupportedKnowledgeAssetRootMutationV1 extends FinalizedEventPositionV1 {
  kind: Extract<KnowledgeAssetRootMutationKindV1, 'roots-replaced' | 'root-removed'>;
  kaId: string;
}

// The kind vocabulary is NEUTRAL and owned by the event model (review r24):
// VM convergence derives its supported/unsupported SUBSETS from it (the
// record shapes above use Extract<...>), so adding a kind for delivery does
// not require choosing a VM disposition first. Re-exported for consumers
// that reached it through this module.
export {
  KNOWLEDGE_ASSET_ROOT_MUTATION_KINDS_V1,
} from './knowledge-asset-root-mutation-v1.js';
export type { KnowledgeAssetRootMutationKindV1 } from './knowledge-asset-root-mutation-v1.js';



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
    ...vmEventPosition(input, 'update'),
  });
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
  // The page itself must be dense own data before anything is read from it: a
  // hole here would reach the loop as `undefined` and blow up inside a
  // canonicalizer with an untyped error instead of a typed malformed page.
  const dense = denseDataArray(logs, 'page logs', MAX_UPDATE_PAGE_EVENTS);

  const parts: string[] = [];
  let previous: FinalizedEventPositionV1 | undefined;
  // Aggregate raw-bytes budget for the whole page, charged as we walk so an
  // oversized page is refused before its commitment input is assembled.
  let encodedBytes = 0;
  const charge = (hex: string, label: string) => {
    encodedBytes += hex.length;
    if (encodedBytes > MAX_ENCODED_UPDATE_LOG_BYTES_PER_PAGE) {
      fail(
        'page-oversized',
        `page raw log bytes exceed ${MAX_ENCODED_UPDATE_LOG_BYTES_PER_PAGE} at ${label}`,
      );
    }
  };

  for (const entry of dense) {
    const log = entry as RawLogV1;
    const position = vmEventPosition(log.position, 'log');
    if (previous !== undefined) {
      const order = compareEventPosition(previous, position);
      if (order > 0) fail('page-malformed', 'logs are not in ascending chain order');
      if (order === 0) fail('page-malformed', 'two logs occupy one ordering position');
    }
    previous = position;

    // Topics: dense own data, bounded at the EVM's own LOG0..LOG4 limit, and
    // bounded BEFORE expansion.
    const topics = denseDataArray(log.topics, 'log.topics', MAX_LOG_TOPICS);

    if (typeof log.data !== 'string') fail('page-malformed', 'log.data must be a string');
    charge(log.data, 'log.data');
    // Raw event data is bounded by the PAGE budget, not the identity-scalar cap.
    adapt('log.data', () => assertCanonicalHexBytes(
      log.data,
      'log.data',
      0,
      MAX_ENCODED_UPDATE_LOG_BYTES_PER_PAGE,
    ));

    const canonicalTopics = topics.map((topic, index) => {
      const digest = canonicalDigest32(topic, `log.topics[${index}]`);
      charge(digest, `log.topics[${index}]`);
      return digest;
    });

    parts.push(
      canonicalEvmAddress(log.address, 'log.address'),
      String(canonicalTopics.length),
      ...canonicalTopics,
      log.data,
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
  // Dense own data BEFORE mapping. `map` skips holes while `new Set` observes
  // them as `undefined`, so `['https://a', <hole>]` previously had length 2 and
  // set size 2 and minted a false `dual-origin-corroborated` proof.
  const rawOrigins = denseDataArray(input.normalizedOrigins, 'proof.normalizedOrigins', 2);
  if (rawOrigins.length === 0) {
    fail('origin-not-distinct', 'proof.normalizedOrigins must carry at least one origin');
  }
  const origins = rawOrigins.map((origin, index) =>
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
  // One block cannot have two hashes. A single-block page has `from === through`,
  // and a page that reaches the anchor has `through === finalizedAnchor`; without
  // this, such a proof could claim three different hashes at one height and still
  // be marked corroborated. Empty and sparse pages are exactly where no log
  // position would expose the contradiction.
  for (const [left, right] of [
    [from, through],
    [from, finalizedAnchor],
    [through, finalizedAnchor],
  ] as const) {
    if (left.blockNumber === right.blockNumber && left.blockHash !== right.blockHash) {
      fail(
        'page-malformed',
        `proof references block ${left.blockNumber} with two different hashes`,
      );
    }
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

/**
 * Only a corroborated page may move authoritative coverage or feed the reducer.
 *
 * This CANONICALIZES rather than reading `proof.assurance` off whatever it was
 * handed. Reading the string alone made authority a declaration: any object
 * literal carrying `assurance: 'dual-origin-corroborated'` — including one whose
 * origin list was sparse or accessor-backed — answered true. It throws a typed
 * error on malformed evidence rather than quietly answering `false`, because a
 * page that cannot be canonicalized is a defect to surface, not an unattested
 * page to skip.
 */
export function isAuthoritativePage(proof: FinalizedUpdatePageProofV1): boolean {
  return canonicalPageProof(proof).assurance === 'dual-origin-corroborated';
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
      : Object.freeze(vmEventPosition(input.resumeAfter, 'cursor.resumeAfter'));
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
  const order = compareEventPosition(event, resumeAfter);
  if (order < 0) return true;
  if (order > 0) return false;
  // Equal ORDER is not equal IDENTITY. `(block, txIndex, logIndex)` is the chain
  // order; `blockHash` and `transactionHash` are part of the event's identity.
  // A different event at the same numeric position means the page is malformed
  // or the chain reorganised exactly at the resume boundary — treating it as
  // "already reduced" silently drops that event AND destroys the only signal
  // that would have caught the reorg.
  //
  // The hashes are deliberately NOT added to `compareEventPosition`:
  // lexicographic hash ordering would invent a position the chain never assigned.
  if (!sameEventIdentity(event, resumeAfter)) {
    fail(
      'resume-identity-conflict',
      'a different event occupies the resume position; page is malformed or reorged',
    );
  }
  return true;
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
 * Build the canonical UAL for a resolved on-chain KA id, as a W2-typed wrapper.
 *
 * The rule has ONE owner: `ka-ual-identity.ts`. `buildReconciledKnowledgeAssetUal`
 * in the agent package delegates to the same function, so there is no second
 * production implementation to keep in step — an earlier revision restated the
 * rule here and guarded the copy with a cross-package parity test, which detects
 * drift only after it exists.
 */
export function buildScopedKnowledgeAssetUal(
  chainId: string,
  legacyStorageAddress: string,
  kaId: bigint,
): string {
  // Delegates: `ka-ual-identity.ts` is the single owner of this rule, and
  // `buildReconciledKnowledgeAssetUal` in the agent package delegates to the
  // same function. This wrapper only re-raises as a W2 typed error.
  try {
    return buildKnowledgeAssetUalFromOnChainIdV1(chainId, legacyStorageAddress, kaId);
  } catch (cause) {
    const message = (cause as Error)?.message ?? String(cause);
    if (message.includes('exceeds uint256')) fail('ka-number-overflow', message, cause);
    fail('noncanonical-scalar', message, cause);
  }
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
  adapt(
    'ual address segment',
    () => assertCanonicalEvmAddress(addressSegment, 'ual address segment'),
    'noncanonical-ual',
  );
  // The shipped decimal parser owns the leading-zero-alias rule; restating it
  // here would be a second canonical-scalar policy.
  const number = adapt(
    'ual number segment',
    () => parseCanonicalDecimalU256(numberSegment, 'ual number segment'),
    'noncanonical-ual',
  );
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
 * The durable store contract is intentionally NOT exported from this PR.
 *
 * An earlier revision published `VmUpdateConvergenceStoreV1` with five broad
 * operations. It had no in-repository implementation or consumer, and its shape
 * could not express the contract the plan actually requires: every cursor
 * mutation is an expected-revision PLUS expected-prior-cursor CAS, with the
 * canonical proof supplied to the atomic boundary. Two stale callers can
 * legitimately hold the same revision, so a bare `expectedRevision` does not
 * make the operations safe, and accepting an assurance string would re-open the
 * forgeable-evidence hole this module closes.
 *
 * Publishing that shape as `V1` would turn a placeholder into an API promise and
 * force a breaking change later. It lands with the SQLite store slice (plan
 * §10.4), where its operations and CAS predicates can be defined and tested
 * together.
 */
