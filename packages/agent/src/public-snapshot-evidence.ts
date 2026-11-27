import type { DurableRecoveryAuthority } from './durable-recovery-authority.js';
// SPDX-License-Identifier: Apache-2.0
import { overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1 } from "@origintrail-official/dkg-publisher";
import type { AcceptedPublicGraphSnapshot } from "@origintrail-official/dkg-chain";
import {
  parseDeterministicKnowledgeAssetUal,
  contextGraphDataUri,
  contextGraphMetaUri,
  sparqlString,
} from "@origintrail-official/dkg-core";
import { isWithheldGraphQueryError, type QueryEngine, type QueryOptions, type QueryResult } from "@origintrail-official/dkg-query";
import type { Quad, TripleStore } from "@origintrail-official/dkg-storage";
import type {
  VerifiedGraphScopedAsset,
  AuthenticatedGraphScopedAsset,
} from "./sync/requester/graph-scoped-materialization.js";

import { packKnowledgeAssetIdFromIdentity } from "./ka-identity.js";

import type { PublicSnapshotMode } from './public-snapshot-mode.js';
export type { PublicSnapshotMode } from './public-snapshot-mode.js';
export type PublicSnapshotObservation =
  | { readonly mode: "core-cache"; readonly snapshot: AcceptedPublicGraphSnapshot; readonly sourceCore: string }
  | { readonly mode: "rpc-only"; readonly snapshot: AcceptedPublicGraphSnapshot; readonly sourceCore: null };
export const SNAPSHOT_TRUST_GRAPH = "urn:dkg:local:public-snapshot-trust";
const DKG = "http://dkg.io/ontology/";
/** Query guard is durable and conservative across partial jobs, upgrades and process restarts. */
export async function markCoreTrustedGraph(
  store: TripleStore,
  contextGraphId: string,
): Promise<void> {
  await store.insert(coreTrustedGraphQuads(contextGraphId));
}
/** The same durable query restriction for live materialization and an empty checkpoint. */
export function coreTrustedGraphQuads(contextGraphId: string): Quad[] {
  return [
    {
      subject: contextGraphDataUri(contextGraphId),
      predicate: `${DKG}chainEvidenceMode`,
      object: '"core-cache"',
      graph: SNAPSHOT_TRUST_GRAPH,
    },
  ];
}
/** True when the caller accepted core-cache evidence, which needs an explicit context graph. */
function acceptsCoreCache(contextGraphId: string | undefined, accepted: PublicSnapshotMode | undefined): boolean {
  if (accepted === "core-cache") {
    if (!contextGraphId)
      throw new Error(
        "Core-cache query acceptance requires an explicit context graph",
      );
    return true;
  }
  if (accepted !== undefined && accepted !== "rpc-only")
    throw new Error("Unknown chain evidence mode");
  return false;
}
function coreCacheTrustRequired(message = "This graph contains core-trusted chain evidence. Explicitly accept core-cache evidence or use an independent profile.") {
  return Object.assign(new Error(message), { code: "CORE_CACHE_QUERY_TRUST_REQUIRED" });
}
/**
 * Refuse a read of a marked graph without explicit acceptance. Without a
 * context graph it refuses while any graph is marked: that is the check for a
 * caller that cannot leave marked graphs out of what it reads (remote UAL
 * lookups). Local unscoped queries use `queryWithPublicSnapshotTrust`, which
 * leaves the marked graphs out instead.
 */
export async function assertPublicSnapshotQueryTrust(
  store: TripleStore,
  contextGraphId?: string,
  accepted?: PublicSnapshotMode,
  queryOptions?: import("@origintrail-official/dkg-storage").QueryOptions,
): Promise<void> {
  if (acceptsCoreCache(contextGraphId, accepted)) return;
  // Storage partitions overlap in both directions: a parent can select a child's
  // partitions, and a descendant alias can select content imported by its parent.
  // Keep slash boundaries so similarly named, unrelated scopes remain readable.
  const graphUri = contextGraphId ? sparqlString(contextGraphDataUri(contextGraphId)) : "";
  // Earlier pre-release jobs persisted metadata-keyed markers. Derive their
  // possible ancestor keys from the requested ID; never decode stored partition names.
  const legacyAncestors = contextGraphId ? contextGraphId.split("/").map((_, index, parts) =>
    sparqlString(contextGraphMetaUri(parts.slice(0, index + 1).join("/")))).join(", ") : "";
  const scope = contextGraphId
    ? `FILTER(STR(?graph) = ${graphUri} ||
        STRSTARTS(STR(?graph), CONCAT(${graphUri}, "/")) ||
        STRSTARTS(${graphUri}, CONCAT(STR(?graph), "/")) ||
        STR(?graph) IN (${legacyAncestors}))`
    : "";
  const result = await store.query(
    `SELECT ?mode WHERE { GRAPH <${SNAPSHOT_TRUST_GRAPH}> { ?graph <${DKG}chainEvidenceMode> ?mode } ${scope} } LIMIT 1`,
    queryOptions,
  );
  if (result.type !== "bindings")
    throw new Error("Chain evidence metadata is unavailable");
  if (result.bindings.length) throw coreCacheTrustRequired();
}
const CONTEXT_GRAPH_IRI_PREFIX = "did:dkg:context-graph:";
/** More marked graphs than this and unscoped reads are refused, as they were before any were left out. */
const MAX_WITHHELD_GRAPH_ROOTS = 256;
/**
 * The graphs an unscoped read leaves out: each marked context graph's data
 * IRI, which covers its partitions and its descendants. A pre-release
 * metadata-keyed marker covers its whole graph. A marker that does not name a
 * context graph, or more markers than the bound, refuses the read instead.
 */
export async function readCoreCacheWithheldGraphRoots(
  store: TripleStore,
  queryOptions?: import("@origintrail-official/dkg-storage").QueryOptions,
): Promise<string[]> {
  const result = await store.query(
    `SELECT DISTINCT ?graph WHERE { GRAPH <${SNAPSHOT_TRUST_GRAPH}> { ?graph <${DKG}chainEvidenceMode> ?mode } } LIMIT ${MAX_WITHHELD_GRAPH_ROOTS + 1}`,
    queryOptions,
  );
  if (result.type !== "bindings")
    throw new Error("Chain evidence metadata is unavailable");
  if (result.bindings.length > MAX_WITHHELD_GRAPH_ROOTS) throw coreCacheTrustRequired();
  const roots = new Set<string>();
  for (const { graph } of result.bindings) {
    if (!graph?.startsWith(CONTEXT_GRAPH_IRI_PREFIX) || graph.length === CONTEXT_GRAPH_IRI_PREFIX.length)
      throw coreCacheTrustRequired();
    roots.add(graph.endsWith("/_meta") ? graph.slice(0, -"/_meta".length) : graph);
  }
  return [...roots].sort();
}
/** Owned by one explicit public job, never installed as a shared/global chain adapter. */
export class PublicSnapshotEvidence implements DurableRecoveryAuthority {
  admitVerifiedPage(page: Parameters<DurableRecoveryAuthority['admitVerifiedPage']>[0]): void {
    if (!this.isCurrent()) throw new Error('Snapshot job is no longer current');
    if (page.remainingData.length || page.remainingMeta.length) {
      throw Object.assign(new Error('Snapshot recovery requires authenticated graph-scoped rows'),
        { code: 'SNAPSHOT_UNAUTHENTICATED_ROWS' });
    }
  }
  readonly coalescing = 'owner-only' as const;
  private readonly assets: ReadonlyMap<string, AcceptedPublicGraphSnapshot["assets"][number]>;
  readonly observation: PublicSnapshotObservation;
  constructor(
    observation: PublicSnapshotObservation,
    readonly isCurrent: () => boolean,
  ) {
    const { snapshot } = observation;
    this.observation = Object.freeze({ ...observation });
    this.assets = new Map(snapshot.assets.map((a) => [a.id, a]));
  }
  get snapshot() { return this.observation.snapshot; }
  get mode() { return this.observation.mode; }
  get sourceCore() { return this.observation.sourceCore; }
  isRegisteredPublic(contextGraphId: string, signal?: AbortSignal): boolean {
    return contextGraphId === this.snapshot.contextGraphId && this.isCurrent() && !signal?.aborted;
  }
  authenticate(asset: VerifiedGraphScopedAsset, _deadline?: number, signal?: AbortSignal): AuthenticatedGraphScopedAsset {
    signal?.throwIfAborted();
    if (!this.isCurrent()) throw new Error("Snapshot job is no longer current");
    const s = this.snapshot;
    const identity = parseDeterministicKnowledgeAssetUal(asset.ual);
    const id = packKnowledgeAssetIdFromIdentity(identity).toString();
    const expected = this.assets.get(id);
    // Content digest and descriptor root were validated at preparation.
    const blockNumber = Number(s.blockNumber);
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0)
      throw new Error("Snapshot block exceeds materialization ordering range");
    if (
      asset.contextGraphId !== s.contextGraphId ||
      identity.chainId !== s.chainId ||
      !expected ||
      asset.assertionVersion.toString() !== expected.version ||
      `0x${asset.merkleRootHex}` !== expected.root
    ) {
      throw Object.assign(
        new Error("Payload does not match the pinned public snapshot"),
        { code: "PUBLIC_SNAPSHOT_ASSET_MISMATCH" },
      );
    }
    const discarded = new Set([
      "chainEvidenceMode",
      "chainEvidenceSource",
      "chainSnapshotDigest",
      "chainSnapshotBlock",
      "chainSnapshotObservedAt",
    ]);
    const metadata = asset.metadataQuads.filter(
      (q) =>
        !discarded.has(q.predicate.slice(DKG.length)) ||
        !q.predicate.startsWith(DKG),
    );
    const fields: Record<string, string> = {
      chainEvidenceMode: this.mode,
      chainEvidenceSource: this.sourceCore ?? "local-rpc",
      chainSnapshotDigest: s.snapshotDigest,
      chainSnapshotBlock: `${s.blockNumber}:${s.blockHash}`,
      chainSnapshotObservedAt: String(s.observedAt),
    };
    return {
      asset: {
        ...asset,
        metadataQuads: [
          ...overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1(metadata, {
            ual: asset.ual, metaGraph: asset.metaGraph, receivedAt: new Date(), subGraphName: asset.subGraphName,
          }, { status: "confirmed", confirmation: { kind: "finalized-materialization" },
            materializedVersion: { blockNumber, txIndex: 0 } }),
          ...Object.entries(fields).map(([key, value]) => ({
            subject: asset.ual,
            predicate: `${DKG}${key}`,
            object: JSON.stringify(value),
            graph: asset.metaGraph,
          })),
        ],
      },
      onChainContextGraphId: s.onChainId,
    };
  }
}

/** Share scoped evidence and cancellation checks across SPARQL and typed reads. */
export async function withScopedPublicSnapshotTrust<T>(
  store: TripleStore,
  contextGraphId: string,
  mode: PublicSnapshotMode | undefined,
  read: () => Promise<T>,
  readOptions?: import("@origintrail-official/dkg-storage").QueryOptions,
): Promise<T> {
  readOptions?.signal?.throwIfAborted();
  await assertPublicSnapshotQueryTrust(store, contextGraphId, mode, readOptions);
  const result = await read();
  await assertPublicSnapshotQueryTrust(store, contextGraphId, mode, readOptions);
  readOptions?.signal?.throwIfAborted();
  return result;
}

/**
 * Run one local query under the chain evidence policy, after the normal
 * read-authority gate. Evidence is rechecked before the result is released,
 * which closes a race with an import that starts during the query.
 *
 * A scoped query of a marked graph needs explicit acceptance. A query without
 * a context graph never fails only because some graph is marked: it runs over
 * the store's dataset without the marked graphs, which this function hands to
 * the engine itself, so no core-cache evidence reaches a caller that did not
 * accept it. Acceptance stays per graph and needs a context graph.
 */
export async function queryWithPublicSnapshotTrust(
  store: TripleStore,
  engine: Pick<QueryEngine, "query">,
  sparql: string,
  options: QueryOptions,
  mode: PublicSnapshotMode | undefined,
  readOptions?: import("@origintrail-official/dkg-storage").QueryOptions,
): Promise<QueryResult> {
  const { contextGraphId } = options;
  if (contextGraphId) {
    return withScopedPublicSnapshotTrust(store, contextGraphId, mode,
      () => engine.query(sparql, options), readOptions);
  }
  acceptsCoreCache(contextGraphId, mode);
  const withheldGraphRoots = await readCoreCacheWithheldGraphRoots(store, readOptions);
  const result = await engine.query(sparql, { ...options, withheldGraphRoots }).catch((error: unknown) => {
    if (!isWithheldGraphQueryError(error)) throw error;
    throw coreCacheTrustRequired("While graphs hold core-trusted chain evidence, a query without a context graph cannot name its own dataset. Scope the query to a context graph.");
  });
  // A graph marked while the query ran was not left out of it.
  const after = await readCoreCacheWithheldGraphRoots(store, readOptions);
  if (after.some(root => !withheldGraphRoots.includes(root))) throw coreCacheTrustRequired();
  return result;
}
