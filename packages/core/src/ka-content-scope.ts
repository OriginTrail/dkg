import {
  canonicalKnowledgeAssetAgentAddress,
  contextGraphLayerUri,
} from './constants.js';
import type { MemoryLayer } from './memory-model.js';
import { assertSafeIri, isSafeIri } from './sparql-safe.js';

/** Existing V10 KAs may be resolved through the quarantined read-only path. */
export const LEGACY_ROOT_CONTENT_SCOPE_VERSION = 1 as const;

/** All newly-created and mutated KAs use one exact per-KA graph. */
export const GRAPH_KA_CONTENT_SCOPE_VERSION = 2 as const;

export interface LegacyRootKnowledgeAssetReadScope {
  readonly version: typeof LEGACY_ROOT_CONTENT_SCOPE_VERSION;
  readonly kind: 'legacy-roots';
  readonly access: 'read-only';
  readonly rootEntities: readonly string[];
}

export interface GraphKnowledgeAssetScope {
  readonly version: typeof GRAPH_KA_CONTENT_SCOPE_VERSION;
  readonly kind: 'ka-graph';
  readonly access: 'read-write';
  /** Canonical deterministic KA identity. */
  readonly ual: string;
  /** Chain namespace embedded in the UAL (for example `base:8453`). */
  readonly chainId: string;
  /** Canonical lowercase EVM author address embedded in the UAL. */
  readonly agentAddress: string;
  /** Canonical base-10 per-author KA number embedded in the UAL. */
  readonly kaNumber: string;
  /** One-based on-chain assertion/Merkle-root index, encoded losslessly. */
  readonly assertionVersion: string;
}

/** A read can resolve either the current graph model or an immutable V10 KA. */
export type KnowledgeAssetReadScope =
  | LegacyRootKnowledgeAssetReadScope
  | GraphKnowledgeAssetScope;

/** Every state-changing path accepts only this shape. */
export type KnowledgeAssetWriteScope = GraphKnowledgeAssetScope;

export interface KnowledgeAssetContentScopeInput {
  /** Missing/zero/one is an existing V10 root-scoped KA; two is graph scope. */
  readonly contentScopeVersion?: number;
  /** Required for graph-scoped content. */
  readonly kaUal?: string;
  /** Required for graph-scoped content. Initial publish is version one. */
  readonly assertionVersion?: string | number | bigint;
  /** Required only to read existing V10 content. */
  readonly rootEntities?: readonly string[];
}

export interface DeterministicKnowledgeAssetUalParts {
  readonly ual: string;
  readonly chainId: string;
  readonly agentAddress: string;
  readonly kaNumber: string;
}

export class LegacyKnowledgeAssetReadOnlyError extends Error {
  readonly code = 'LEGACY_KA_READ_ONLY';

  constructor() {
    super('Legacy root-scoped Knowledge Assets are read-only');
    this.name = 'LegacyKnowledgeAssetReadOnlyError';
  }
}

const DETERMINISTIC_KA_UAL_RE = /^did:dkg:([^/]+)\/(0x[0-9a-fA-F]{40})\/([0-9]+)$/;
/**
 * The on-chain allocator packs `kaId = (uint160(author) << 96) | uint96(number)`.
 * A number at or above 2^96 would spill into the author bits, so two distinct
 * UALs could alias one packed kaId. Only numbers that round-trip losslessly
 * through the packed identity are valid graph identities.
 */
export const MAX_KNOWLEDGE_ASSET_NUMBER = (1n << 96n) - 1n;

/**
 * Parse and canonicalize the deterministic Option-1 UAL used as graph identity.
 * Physical graph IRIs never travel on the wire: every node derives its local
 * WM/SWM/VM graph from these validated identity parts.
 */
export function parseDeterministicKnowledgeAssetUal(
  rawUal: string,
): DeterministicKnowledgeAssetUalParts {
  const input = String(rawUal ?? '').trim();
  if (!isSafeIri(input)) {
    throw new Error(`Invalid graph-scoped KA UAL: ${input || '(empty)'}`);
  }
  const match = DETERMINISTIC_KA_UAL_RE.exec(input);
  if (!match) {
    throw new Error(
      `Graph-scoped KA UAL must match did:dkg:<chain>/<0x-author>/<number>: ${input}`,
    );
  }

  const [, chainId, rawAgentAddress, rawKaNumber] = match;
  const agentAddress = canonicalKnowledgeAssetAgentAddress(rawAgentAddress);
  // BigInt canonicalisation prevents leading-zero aliases for one graph.
  const kaNumberValue = BigInt(rawKaNumber);
  if (kaNumberValue > MAX_KNOWLEDGE_ASSET_NUMBER) {
    throw new Error(
      `Graph-scoped KA number exceeds the packed uint96 identity domain (max ${MAX_KNOWLEDGE_ASSET_NUMBER}): ${input}`,
    );
  }
  const kaNumber = kaNumberValue.toString();
  return {
    ual: `did:dkg:${chainId}/${agentAddress}/${kaNumber}`,
    chainId,
    agentAddress,
    kaNumber,
  };
}

export function canonicalAssertionVersion(
  rawVersion: string | number | bigint,
): string {
  let version: bigint;
  try {
    if (typeof rawVersion === 'number' && !Number.isSafeInteger(rawVersion)) {
      throw new Error('unsafe number');
    }
    version = BigInt(rawVersion);
  } catch {
    throw new Error(`Invalid KA assertion version: ${String(rawVersion)}`);
  }
  if (version < 1n) {
    throw new Error(`KA assertion version must be at least 1, got ${version}`);
  }
  return version.toString();
}

export function createGraphKnowledgeAssetScope(
  kaUal: string,
  assertionVersion: string | number | bigint,
): GraphKnowledgeAssetScope {
  const parsed = parseDeterministicKnowledgeAssetUal(kaUal);
  return {
    version: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kind: 'ka-graph',
    access: 'read-write',
    ...parsed,
    assertionVersion: canonicalAssertionVersion(assertionVersion),
  };
}

/**
 * Resolve persisted content for query/export only. Legacy roots are deliberately
 * confined to this API and never become a valid mutation scope.
 */
export function resolveKnowledgeAssetReadScope(
  input: KnowledgeAssetContentScopeInput,
): KnowledgeAssetReadScope {
  const version = input.contentScopeVersion ?? 0;
  if (version === GRAPH_KA_CONTENT_SCOPE_VERSION) {
    if (input.assertionVersion === undefined) {
      throw new Error('Graph-scoped KA requires assertionVersion');
    }
    return createGraphKnowledgeAssetScope(
      input.kaUal ?? '',
      input.assertionVersion,
    );
  }
  if (version !== 0 && version !== LEGACY_ROOT_CONTENT_SCOPE_VERSION) {
    throw new Error(`Unsupported KA content scope version: ${version}`);
  }

  const roots: string[] = [];
  const seen = new Set<string>();
  for (const rawRoot of input.rootEntities ?? []) {
    const root = String(rawRoot ?? '').trim();
    if (!isSafeIri(root)) {
      throw new Error(`Invalid legacy root entity IRI: ${root || '(empty)'}`);
    }
    assertSafeIri(root);
    if (!seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  }
  if (roots.length === 0) {
    throw new Error('Legacy KA read scope requires at least one root entity');
  }
  return {
    version: LEGACY_ROOT_CONTENT_SCOPE_VERSION,
    kind: 'legacy-roots',
    access: 'read-only',
    rootEntities: roots,
  };
}

/** Resolve a create/update/share/finalize scope and reject legacy mutation. */
export function resolveKnowledgeAssetWriteScope(
  input: KnowledgeAssetContentScopeInput,
): KnowledgeAssetWriteScope {
  const scope = resolveKnowledgeAssetReadScope(input);
  if (scope.kind !== 'ka-graph') {
    throw new LegacyKnowledgeAssetReadOnlyError();
  }
  return scope;
}

/** Derive the exact local graph containing the scope's current assertion. */
export function knowledgeAssetLayerGraphUri(
  contextGraphId: string,
  layer: MemoryLayer,
  scope: GraphKnowledgeAssetScope,
  subGraphName?: string,
): string {
  assertSafeIri(`did:dkg:context-graph:${contextGraphId}`);
  return contextGraphLayerUri(
    contextGraphId,
    layer,
    scope.agentAddress,
    scope.kaNumber,
    subGraphName,
  );
}
