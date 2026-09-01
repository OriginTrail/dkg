import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { canonicalizeJson, type CanonicalJsonValue } from './canonical-json.js';
import { encodeCanonicalIriComponentV1 } from './canonical-iri-component-v1.js';
import { contextGraphDataUri } from './constants.js';
import {
  assertAuthorLaneContextGraphIdV1,
  assertAuthorLaneSubGraphNameV1,
  type ContextGraphIdV1,
  type SubGraphNameV1,
} from './author-lane-scope-v1.js';
import {
  assertNetworkIdV1,
  type NetworkIdV1,
} from './sync-wire-identifiers.js';
import {
  assertCanonicalEvmAddress,
  type Digest32V1,
  type EvmAddressV1,
} from './sync-wire-scalars.js';
import { snapshotSelectedDataRecord } from './sync-wire-objects.js';

export const RFC64_SUBGRAPH_KEY_DOMAIN_V1 = 'dkg-subgraph-key-v1\n' as const;

const UTF8 = new TextEncoder();
const SUBGRAPH_KEY_DOMAIN_BYTES = UTF8.encode(RFC64_SUBGRAPH_KEY_DOMAIN_V1);

declare const RFC64_SYNC_GRAPH_IRI_V1_BRAND: unique symbol;
declare const RFC64_SYNC_SUBJECT_IRI_V1_BRAND: unique symbol;

export type Rfc64SyncGraphIriV1 = string & {
  readonly [RFC64_SYNC_GRAPH_IRI_V1_BRAND]: true;
};
export type Rfc64SyncSubjectIriV1 = string & {
  readonly [RFC64_SYNC_SUBJECT_IRI_V1_BRAND]: true;
};

export interface Rfc64SemanticAddressV1 {
  readonly graphUri: Rfc64SyncGraphIriV1;
  readonly subject: Rfc64SyncSubjectIriV1;
}

export interface Rfc64SemanticScopeV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
}

export interface Rfc64SubgraphSemanticScopeV1 extends Rfc64SemanticScopeV1 {
  readonly subGraphName: SubGraphNameV1 | null;
}

export interface Rfc64AuthorSemanticScopeV1 extends Rfc64SubgraphSemanticScopeV1 {
  readonly authorAddress: EvmAddressV1;
}

export interface Rfc64CurrentAuthorCatalogRefAddressV1 extends Rfc64SemanticAddressV1 {
  readonly subGraphKey: Digest32V1;
}

export interface Rfc64SubgraphSemanticAddressesV1 {
  readonly subGraphKey: Digest32V1;
  readonly appliedSeal: Rfc64SemanticAddressV1;
  readonly mutationGuard: Rfc64SemanticAddressV1;
  readonly reconcileTarget: Rfc64SemanticAddressV1;
}

export interface Rfc64ContextGraphSemanticAddressesV1 {
  readonly mutationGuard: Rfc64SemanticAddressV1;
  readonly appliedSetRef: Rfc64SemanticAddressV1;
  readonly appliedSeal: Rfc64SemanticAddressV1;
}

type Rfc64SemanticRouteV1 =
  | 'applied'
  | 'mutation'
  | 'reconcile-target'
  | 'mutation-cg'
  | 'applied-set'
  | 'applied-cg';

/**
 * True only for the RFC-64 control-graph family reserved directly below one
 * context graph. Legacy durable and changelog sync must never serve or import
 * these records; they move only through the signed RFC-64 manifest lane.
 */
export function isRfc64SemanticControlGraphV1(
  graphUri: string,
  contextGraphId: string,
): boolean {
  const base = `${contextGraphDataUri(contextGraphId)}/_sync`;
  return graphUri === base || graphUri.startsWith(`${base}/`);
}

/**
 * Collision-safe key shared by RFC-64 semantic graphs, signed subgraph indexes,
 * and the disposable SQL planner. The protocol-null root lane is hashed as a
 * literal JSON null and therefore cannot alias a named subgraph.
 */
export function computeRfc64SubGraphKeyV1(
  subGraphName: SubGraphNameV1 | null,
): Digest32V1 {
  if (subGraphName !== null) assertAuthorLaneSubGraphNameV1(subGraphName);
  const canonical = canonicalizeJson({ subGraphName } as CanonicalJsonValue, {
    maxBytes: 512,
    maxDepth: 1,
  });
  const payload = UTF8.encode(canonical);
  const preimage = new Uint8Array(SUBGRAPH_KEY_DOMAIN_BYTES.length + payload.length);
  preimage.set(SUBGRAPH_KEY_DOMAIN_BYTES);
  preimage.set(payload, SUBGRAPH_KEY_DOMAIN_BYTES.length);
  return `0x${bytesToHex(sha256(preimage))}` as Digest32V1;
}

/** Exact reserved current-author-catalog graph and fixed subject. */
export function deriveRfc64CurrentAuthorCatalogRefAddressV1(
  scope: Rfc64AuthorSemanticScopeV1,
): Rfc64CurrentAuthorCatalogRefAddressV1 {
  const snapshot = snapshotAuthorSemanticScope(scope);
  const base = semanticGraphBase(snapshot.contextGraphId);
  const subGraphKey = computeRfc64SubGraphKeyV1(snapshot.subGraphName);
  return Object.freeze({
    subGraphKey,
    graphUri: (
      `${base}/catalog/${subGraphKey}/${snapshot.authorAddress}/current`
    ) as Rfc64SyncGraphIriV1,
    subject: semanticSubject(
      'catalog',
      snapshot.networkId,
      snapshot.contextGraphId,
      subGraphKey,
      snapshot.authorAddress,
    ),
  });
}

/** Exact reserved per-subgraph graphs and fixed subjects. */
export function deriveRfc64SubgraphSemanticAddressesV1(
  scope: Rfc64SubgraphSemanticScopeV1,
): Rfc64SubgraphSemanticAddressesV1 {
  const snapshot = snapshotSubgraphSemanticScope(scope);
  const subGraphKey = computeRfc64SubGraphKeyV1(snapshot.subGraphName);
  const base = semanticGraphBase(snapshot.contextGraphId);
  return Object.freeze({
    subGraphKey,
    appliedSeal: semanticAddress(
      base,
      'applied',
      snapshot,
      subGraphKey,
    ),
    mutationGuard: semanticAddress(
      base,
      'mutation',
      snapshot,
      subGraphKey,
    ),
    reconcileTarget: semanticAddress(
      base,
      'reconcile-target',
      snapshot,
      subGraphKey,
    ),
  });
}

/** Exact reserved context-graph-wide graphs and fixed subjects. */
export function deriveRfc64ContextGraphSemanticAddressesV1(
  scope: Rfc64SemanticScopeV1,
): Rfc64ContextGraphSemanticAddressesV1 {
  const snapshot = snapshotSemanticScope(scope);
  const base = semanticGraphBase(snapshot.contextGraphId);
  return Object.freeze({
    mutationGuard: semanticAddress(base, 'mutation-cg', snapshot),
    appliedSetRef: semanticAddress(base, 'applied-set', snapshot),
    appliedSeal: semanticAddress(base, 'applied-cg', snapshot),
  });
}

function snapshotSemanticScope(scope: Rfc64SemanticScopeV1): Readonly<Rfc64SemanticScopeV1> {
  const snapshot = snapshotSelectedDataRecord(
    scope,
    ['networkId', 'contextGraphId'] as const,
    'RFC-64 semantic scope',
  );
  const networkId = snapshot.networkId;
  const contextGraphId = snapshot.contextGraphId;
  assertNetworkIdV1(networkId);
  assertAuthorLaneContextGraphIdV1(contextGraphId);
  return Object.freeze({ networkId, contextGraphId });
}

function snapshotSubgraphSemanticScope(
  scope: Rfc64SubgraphSemanticScopeV1,
): Readonly<Rfc64SubgraphSemanticScopeV1> {
  const snapshot = snapshotSelectedDataRecord(
    scope,
    ['networkId', 'contextGraphId', 'subGraphName'] as const,
    'RFC-64 subgraph semantic scope',
  );
  const { networkId, contextGraphId, subGraphName } = snapshot;
  assertNetworkIdV1(networkId);
  assertAuthorLaneContextGraphIdV1(contextGraphId);
  if (subGraphName !== null) assertAuthorLaneSubGraphNameV1(subGraphName);
  return Object.freeze({ networkId, contextGraphId, subGraphName });
}

function snapshotAuthorSemanticScope(
  scope: Rfc64AuthorSemanticScopeV1,
): Readonly<Rfc64AuthorSemanticScopeV1> {
  const snapshot = snapshotSelectedDataRecord(
    scope,
    ['networkId', 'contextGraphId', 'subGraphName', 'authorAddress'] as const,
    'RFC-64 author semantic scope',
  );
  const {
    networkId,
    contextGraphId,
    subGraphName,
    authorAddress,
  } = snapshot;
  assertNetworkIdV1(networkId);
  assertAuthorLaneContextGraphIdV1(contextGraphId);
  if (subGraphName !== null) assertAuthorLaneSubGraphNameV1(subGraphName);
  assertCanonicalEvmAddress(authorAddress, 'authorAddress');
  return Object.freeze({ networkId, contextGraphId, subGraphName, authorAddress });
}

function semanticGraphBase(contextGraphId: ContextGraphIdV1): string {
  return `${contextGraphDataUri(contextGraphId)}/_sync`;
}

function semanticAddress(
  base: string,
  route: Rfc64SemanticRouteV1,
  scope: Rfc64SemanticScopeV1,
  ...suffixes: readonly string[]
): Rfc64SemanticAddressV1 {
  const path = [base, route, ...suffixes].join('/');
  return Object.freeze({
    graphUri: path as Rfc64SyncGraphIriV1,
    subject: semanticSubject(route, scope.networkId, scope.contextGraphId, ...suffixes),
  });
}

function semanticSubject(
  role: string,
  networkId: NetworkIdV1,
  contextGraphId: ContextGraphIdV1,
  ...suffixes: readonly string[]
): Rfc64SyncSubjectIriV1 {
  const components = [
    role,
    encodeCanonicalIriComponentV1(networkId),
    encodeCanonicalIriComponentV1(contextGraphId),
  ];
  components.push(...suffixes);
  return `urn:dkg:sync:${components.join(':')}` as Rfc64SyncSubjectIriV1;
}
