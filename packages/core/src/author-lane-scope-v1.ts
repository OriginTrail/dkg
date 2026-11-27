import {
  assertCanonicalChainId,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  parseCanonicalDecimalU64,
  type ChainIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
} from './sync-wire-scalars.js';
import {
  assertNetworkIdV1,
  type NetworkIdV1,
} from './sync-wire-identifiers.js';
import { assertExactKeys, isPlainRecord } from './sync-wire-objects.js';

declare const CONTEXT_GRAPH_ID_V1_BRAND: unique symbol;
declare const SUBGRAPH_NAME_V1_BRAND: unique symbol;

export type ContextGraphIdV1 = string & { readonly [CONTEXT_GRAPH_ID_V1_BRAND]: true };
export type SubGraphNameV1 = string & { readonly [SUBGRAPH_NAME_V1_BRAND]: true };

export const MAX_AUTHOR_LANE_IDENTIFIER_BYTES_V1 = 256;

const CONTEXT_GRAPH_ID_PATTERN = /^[A-Za-z0-9_:/\.@-]+$/;
const AUTHOR_LANE_IDENTIFIER_ASCII_FORBIDDEN = new Set([
  '<',
  '>',
  '"',
  '{',
  '}',
  '|',
  '^',
  '`',
  '\\',
]);
const RESERVED_SUBGRAPH_NAMES = new Set(['context', 'assertion', 'draft']);
const UTF8 = new TextEncoder();

export interface CatalogLaneV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName: SubGraphNameV1 | null;
}

/** Shared author lane governed by one exact public-CG policy era. */
export interface AuthorLaneScopeV1 extends CatalogLaneV1 {
  readonly networkId: NetworkIdV1;
  readonly governanceChainId: ChainIdV1 | null;
  readonly governanceContractAddress: EvmAddressV1 | null;
  readonly ownershipTransitionDigest: Digest32V1 | null;
  readonly authorAddress: EvmAddressV1;
  readonly era: DecimalU64V1;
}

export const AUTHOR_LANE_SCOPE_KEYS_V1 = Object.freeze([
  'authorAddress',
  'contextGraphId',
  'era',
  'governanceChainId',
  'governanceContractAddress',
  'networkId',
  'ownershipTransitionDigest',
  'subGraphName',
] as const);

export type AuthorLaneScopeErrorCodeV1 =
  | 'author-lane-schema'
  | 'author-lane-identifier'
  | 'author-lane-scalar'
  | 'author-lane-governance-tuple';

export class AuthorLaneScopeErrorV1 extends Error {
  constructor(
    readonly code: AuthorLaneScopeErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'AuthorLaneScopeErrorV1';
  }
}

export function assertAuthorLaneContextGraphIdV1(
  value: unknown,
  label = 'contextGraphId',
): asserts value is ContextGraphIdV1 {
  const identifier = assertNfcUtf8Identifier(value, label);
  if (!CONTEXT_GRAPH_ID_PATTERN.test(identifier)) {
    fail(
      'author-lane-identifier',
      `${label} contains a character outside the contextGraphId grammar`,
    );
  }
}

export function assertAuthorLaneSubGraphNameV1(
  value: unknown,
  label = 'subGraphName',
): asserts value is SubGraphNameV1 {
  const identifier = assertAuthorLaneIdentifier(value, label);
  if (identifier.startsWith('_')) {
    fail('author-lane-identifier', `${label} must not start with underscore`);
  }
  if (RESERVED_SUBGRAPH_NAMES.has(identifier)) {
    fail('author-lane-identifier', `${label} is a reserved subgraph name`);
  }
}

/** Validate the exact shared author-lane scope used by catalog and SWM commitments. */
export function assertAuthorLaneScopeV1(
  scope: unknown,
): asserts scope is AuthorLaneScopeV1 {
  if (!isPlainRecord(scope)) {
    fail('author-lane-schema', 'author lane scope must be a plain JSON object');
  }
  try {
    assertExactKeys(scope, AUTHOR_LANE_SCOPE_KEYS_V1, 'author lane scope');
  } catch (cause) {
    fail('author-lane-schema', 'author lane scope has an invalid field set', cause);
  }
  assertAuthorLaneScopeFieldsV1(scope);
}

/** Validate the shared fields on a structural superset such as a catalog scope. */
export function assertAuthorLaneScopeFieldsV1(scope: Record<string, unknown>): void {
  scalar(() => assertNetworkIdV1(scope.networkId, 'networkId'), 'networkId');
  assertAuthorLaneContextGraphIdV1(scope.contextGraphId);
  if (scope.subGraphName !== null) assertAuthorLaneSubGraphNameV1(scope.subGraphName);
  scalar(() => assertCanonicalEvmAddress(scope.authorAddress, 'authorAddress'), 'authorAddress');
  scalar(() => parseCanonicalDecimalU64(scope.era, 'era'), 'era');

  const chainIsNull = scope.governanceChainId === null;
  const contractIsNull = scope.governanceContractAddress === null;
  if (chainIsNull !== contractIsNull) {
    fail(
      'author-lane-governance-tuple',
      'governanceChainId and governanceContractAddress must both be null or both be non-null',
    );
  }
  if (!chainIsNull) {
    scalar(
      () => assertCanonicalChainId(scope.governanceChainId, 'governanceChainId'),
      'governanceChainId',
    );
    scalar(
      () => assertCanonicalEvmAddress(
        scope.governanceContractAddress,
        'governanceContractAddress',
      ),
      'governanceContractAddress',
    );
  }
  if (scope.ownershipTransitionDigest !== null) {
    scalar(
      () => assertCanonicalDigest(scope.ownershipTransitionDigest, 'ownershipTransitionDigest'),
      'ownershipTransitionDigest',
    );
  }
}

/** Copy a validated structural superset into one exact immutable author-lane scope. */
export function snapshotAuthorLaneScopeV1(scope: AuthorLaneScopeV1): AuthorLaneScopeV1 {
  const snapshot = {
    authorAddress: scope.authorAddress,
    contextGraphId: scope.contextGraphId,
    era: scope.era,
    governanceChainId: scope.governanceChainId,
    governanceContractAddress: scope.governanceContractAddress,
    networkId: scope.networkId,
    ownershipTransitionDigest: scope.ownershipTransitionDigest,
    subGraphName: scope.subGraphName,
  };
  assertAuthorLaneScopeV1(snapshot);
  return Object.freeze(snapshot);
}

function assertAuthorLaneIdentifier(value: unknown, label: string): string {
  const identifier = assertNfcUtf8Identifier(value, label);
  for (const character of identifier) {
    const codePoint = character.codePointAt(0) as number;
    if (
      character === '/'
      || AUTHOR_LANE_IDENTIFIER_ASCII_FORBIDDEN.has(character)
      || isAuthorLaneForbiddenCodePointV1(codePoint)
    ) {
      fail(
        'author-lane-identifier',
        `${label} contains a forbidden character or code point`,
      );
    }
  }
  return identifier;
}

function assertNfcUtf8Identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('author-lane-identifier', `${label} must be a non-empty string`);
  }
  if (value.length > MAX_AUTHOR_LANE_IDENTIFIER_BYTES_V1) {
    fail(
      'author-lane-identifier',
      `${label} exceeds ${MAX_AUTHOR_LANE_IDENTIFIER_BYTES_V1} UTF-8 bytes`,
    );
  }
  assertWellFormedUnicode(value, label);
  if (value.normalize('NFC') !== value) {
    fail('author-lane-identifier', `${label} must already be NFC-normalized`);
  }
  if (UTF8.encode(value).byteLength > MAX_AUTHOR_LANE_IDENTIFIER_BYTES_V1) {
    fail(
      'author-lane-identifier',
      `${label} exceeds ${MAX_AUTHOR_LANE_IDENTIFIER_BYTES_V1} UTF-8 bytes`,
    );
  }
  return value;
}

function isAuthorLaneForbiddenCodePointV1(codePoint: number): boolean {
  return (
    (codePoint >= 0x0000 && codePoint <= 0x001f)
    || (codePoint >= 0x007f && codePoint <= 0x009f)
    || codePoint === 0x00a0
    || codePoint === 0x1680
    || (codePoint >= 0x2000 && codePoint <= 0x200b)
    || codePoint === 0x2028
    || codePoint === 0x2029
    || codePoint === 0x202f
    || codePoint === 0x205f
    || codePoint === 0x3000
    || codePoint === 0xfeff
  );
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail('author-lane-identifier', `${label} contains an unpaired UTF-16 surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail('author-lane-identifier', `${label} contains an unpaired UTF-16 surrogate`);
    }
  }
}

function scalar(operation: () => void, label: string): void {
  try {
    operation();
  } catch (cause) {
    fail('author-lane-scalar', `${label} is not canonical`, cause);
  }
}

function fail(
  code: AuthorLaneScopeErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new AuthorLaneScopeErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
