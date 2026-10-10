// SPDX-License-Identifier: Apache-2.0
import { overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1 } from "@origintrail-official/dkg-publisher";
import type { PublicGraphSnapshot } from "@origintrail-official/dkg-chain";
import {
  parseDeterministicKnowledgeAssetUal,
  contextGraphMetaUri,
  sparqlIri,
} from "@origintrail-official/dkg-core";
import type { TripleStore } from "@origintrail-official/dkg-storage";
import type {
  VerifiedGraphScopedAsset,
  AuthenticatedGraphScopedAsset,
} from "./sync/requester/graph-scoped-materialization.js";

export type PublicSnapshotMode = "core-cache" | "rpc-only";
export const SNAPSHOT_TRUST_GRAPH = "urn:dkg:local:public-snapshot-trust";
const DKG = "http://dkg.io/ontology/";
/** Query guard is durable and conservative across partial jobs, upgrades and process restarts. */
export async function markCoreTrustedGraph(
  store: TripleStore,
  contextGraphId: string,
): Promise<void> {
  await store.insert([
    {
      subject: contextGraphMetaUri(contextGraphId),
      predicate: `${DKG}chainEvidenceMode`,
      object: '"core-cache"',
      graph: SNAPSHOT_TRUST_GRAPH,
    },
  ]);
}
export async function assertPublicSnapshotQueryTrust(
  store: TripleStore,
  contextGraphId?: string,
  accepted?: PublicSnapshotMode,
  queryOptions?: import("@origintrail-official/dkg-storage").QueryOptions,
): Promise<void> {
  if (accepted === "core-cache") {
    if (!contextGraphId)
      throw new Error(
        "Core-cache query acceptance requires an explicit context graph",
      );
    return;
  }
  if (accepted !== undefined && accepted !== "rpc-only")
    throw new Error("Unknown chain evidence mode");
  const subject = contextGraphId
    ? sparqlIri(contextGraphMetaUri(contextGraphId))
    : "?graph";
  const result = await store.query(
    `SELECT ?mode WHERE { GRAPH <${SNAPSHOT_TRUST_GRAPH}> { ${subject} <${DKG}chainEvidenceMode> ?mode } } LIMIT 1`,
    queryOptions,
  );
  if (result.type !== "bindings")
    throw new Error("Chain evidence metadata is unavailable");
  if (result.bindings.length)
    throw Object.assign(
      new Error(
        "This graph contains core-trusted chain evidence. Explicitly accept core-cache evidence or use an independent profile.",
      ),
      { code: "CORE_CACHE_QUERY_TRUST_REQUIRED" },
    );
}
/** Owned by one explicit public job, never installed as a shared/global chain adapter. */
export class PublicSnapshotEvidence {
  readonly assets: Map<string, PublicGraphSnapshot["assets"][number]>;
  constructor(
    readonly snapshot: PublicGraphSnapshot,
    readonly mode: PublicSnapshotMode,
    readonly sourceCore: string | null,
    readonly isCurrent: () => boolean,
  ) {
    this.assets = new Map(snapshot.assets.map((a) => [a.id, a]));
  }
  authenticate(asset: VerifiedGraphScopedAsset): AuthenticatedGraphScopedAsset {
    if (!this.isCurrent()) throw new Error("Snapshot job is no longer current");
    const s = this.snapshot;
    const identity = parseDeterministicKnowledgeAssetUal(asset.ual);
    const id = (
      (BigInt(identity.agentAddress) << 96n) |
      BigInt(identity.kaNumber)
    ).toString();
    const expected = this.assets.get(id);
    const roots = asset.metadataQuads.filter(
      (q) => q.predicate === `${DKG}merkleRoot`,
    );
    // Content digest verification already ran in the existing exact-sync worker.
    const root =
      roots.length === 1
        ? /^"(?:0x)?([0-9a-fA-F]{64})"(?:\^\^<[^>]+>)?$/.exec(
            roots[0]!.object,
          )?.[1]
        : undefined;
    if (
      asset.contextGraphId !== s.contextGraphId ||
      identity.chainId !== s.chainId ||
      !expected ||
      asset.assertionVersion.toString() !== expected.version ||
      `0x${root?.toLowerCase()}` !== expected.root
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
            ual: asset.ual, metaGraph: asset.metaGraph, receivedAt: new Date(),
          }, { status: "confirmed", confirmation: { kind: "finalized-materialization" },
            materializedVersion: { blockNumber: 0, txIndex: 0 } }),
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

/** Run only after the normal read-authority gate. Recheck before releasing results to close a concurrent-import race. */
export async function withPublicSnapshotQueryTrust<T>(
  store: TripleStore,
  contextGraphId: string | undefined,
  mode: PublicSnapshotMode | undefined,
  execute: () => Promise<T>,
  queryOptions?: import("@origintrail-official/dkg-storage").QueryOptions,
): Promise<T> {
  await assertPublicSnapshotQueryTrust(
    store,
    contextGraphId,
    mode,
    queryOptions,
  );
  const result = await execute();
  await assertPublicSnapshotQueryTrust(
    store,
    contextGraphId,
    mode,
    queryOptions,
  );
  return result;
}
