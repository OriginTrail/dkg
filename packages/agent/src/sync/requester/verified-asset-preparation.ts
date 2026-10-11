// SPDX-License-Identifier: Apache-2.0
import {
  parseDeterministicKnowledgeAssetUal,
  isRfc64SemanticControlGraphV1,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  GRAPH_KNOWLEDGE_ASSET_CONFIRMATION_KIND_PREDICATE,
  readGraphKnowledgeAssetConfirmationKindV1,
} from '@origintrail-official/dkg-publisher';
import { packKnowledgeAssetIdFromIdentity } from '../../ka-identity.js';
import type { VerifiedGraphScopedAsset } from './graph-scoped-materialization.js';

const DKG_NS = 'http://dkg.io/ontology/';
const CONTENT_SCOPE_VERSION = `${DKG_NS}contentScopeVersion`;
const KA_UAL = `${DKG_NS}kaUal`;
const ASSERTION_GRAPH = `${DKG_NS}assertionGraph`;
const ASSERTION_VERSION = `${DKG_NS}assertionVersion`;
const CONTEXT_GRAPH = `${DKG_NS}contextGraph`;
const BATCH_ID = `${DKG_NS}batchId`;
const MATERIALIZED_VERSION = `${DKG_NS}materializedVersion`;
const TRANSACTION_HASH = `${DKG_NS}transactionHash`;
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const PEER_UNTRUSTED_METADATA_PREDICATES = new Set([
  MATERIALIZED_VERSION,
  `${DKG_NS}accessPolicy`,
  `${DKG_NS}allowedPeer`,
  `${DKG_NS}publisherPeerId`,
  `${DKG_NS}status`,
]);
const GRAPH_SCOPED_SYNC_METADATA_PREDICATES = new Set([
  `${DKG_NS}merkleRoot`,
  `${DKG_NS}contentScopeVersion`,
  `${DKG_NS}kaUal`,
  ASSERTION_VERSION,
  `${DKG_NS}publicTripleCount`,
  `${DKG_NS}privateTripleCount`,
  `${DKG_NS}privateMerkleRoot`,
  ASSERTION_GRAPH,
  `${DKG_NS}contextGraph`,
  `${DKG_NS}subGraphName`,
  TRANSACTION_HASH,
  GRAPH_KNOWLEDGE_ASSET_CONFIRMATION_KIND_PREDICATE,
]);

export function partitionVerifiedGraphScopedAssets(
  contextGraphId: string,
  verifiedData: Quad[],
  verifiedMeta: Quad[],
  verifiedGraphs: readonly string[],
): {
  assets: VerifiedGraphScopedAsset[];
  remainingData: Quad[];
  remainingMeta: Quad[];
} {
  const graphSet = new Set(verifiedGraphs);
  // Apply the peer-control quarantine only to graph-scoped metadata subjects.
  // Legacy read-only KAs still rely on their already-verified status/access
  // rows, and stripping those globally would make an otherwise valid legacy
  // snapshot unreadable. An assertionVersion-only subject is included here as
  // a fail-closed torn-V2 marker even when its remaining envelope is missing.
  const graphScopedMetadataSubjects = new Set(
    verifiedMeta
      .filter((quad) => (
        quad.predicate === CONTENT_SCOPE_VERSION
        || quad.predicate === ASSERTION_GRAPH
        || quad.predicate === ASSERTION_VERSION
      ))
      .map((quad) => quad.subject),
  );
  // These predicates participate in local stale-write control. A peer may
  // supply assertionVersion only inside a fully verified graph-scoped asset;
  // materializedVersion is never peer-owned.
  const peerSafeMetadata = verifiedMeta.filter(
    (quad) => (
      !graphScopedMetadataSubjects.has(quad.subject)
      || !PEER_UNTRUSTED_METADATA_PREDICATES.has(quad.predicate)
    ),
  );
  if (graphSet.size === 0) {
    return {
      assets: [],
      remainingData: verifiedData,
      remainingMeta: peerSafeMetadata.filter((quad) => !(
        graphScopedMetadataSubjects.has(quad.subject)
        && quad.predicate === ASSERTION_VERSION
      )),
    };
  }

  const dataByGraph = new Map<string, Quad[]>();
  const remainingData: Quad[] = [];
  for (const quad of verifiedData) {
    if (!graphSet.has(quad.graph)) {
      remainingData.push(quad);
      continue;
    }
    const graphQuads = dataByGraph.get(quad.graph) ?? [];
    graphQuads.push(quad);
    dataByGraph.set(quad.graph, graphQuads);
  }

  const ualByGraph = new Map<string, Set<string>>();
  const metadataBySubject = new Map<string, Quad[]>();
  for (const quad of peerSafeMetadata) {
    const subjectQuads = metadataBySubject.get(quad.subject) ?? [];
    subjectQuads.push(quad);
    metadataBySubject.set(quad.subject, subjectQuads);
  }
  // One V2 KA has two legitimate metadata subjects that may point at the same
  // exact graph: the self-bound UAL descriptor and the name-keyed lifecycle
  // row. Only the descriptor owns the graph. Treating every assertionGraph
  // pointer as an owner rejects normal publishes as "2 metadata owners".
  //
  // The self-binding is also a fail-closed boundary: a second complete KA
  // descriptor must carry `<candidate> dkg:kaUal <candidate>` and therefore is
  // still counted as a conflicting owner, while lifecycle/provenance pointers
  // cannot impersonate one merely by naming the exact graph.
  const descriptorSubjects = new Set(
    [...metadataBySubject.entries()]
      .filter(([subject, quads]) => quads.some(
        (quad) => quad.predicate === KA_UAL && stripLiteral(quad.object) === subject,
      ))
      .map(([subject]) => subject),
  );
  for (const quad of peerSafeMetadata) {
    if (quad.predicate !== ASSERTION_GRAPH || !descriptorSubjects.has(quad.subject)) continue;
    const graph = stripLiteral(quad.object);
    if (!graphSet.has(graph)) continue;
    const owners = ualByGraph.get(graph) ?? new Set<string>();
    owners.add(quad.subject);
    ualByGraph.set(graph, owners);
  }

  const assets: VerifiedGraphScopedAsset[] = [];
  const handledUals = new Set<string>();
  for (const assertionGraph of [...graphSet].sort()) {
    const owners = ualByGraph.get(assertionGraph);
    if (!owners || owners.size !== 1) {
      throw new Error(`Verified graph-scoped assertion ${assertionGraph} has ${owners?.size ?? 0} metadata owners`);
    }
    const [ual] = owners;
    // Carry only structural fields plus the bounded provenance discriminator
    // and receipt claim consumed by the chain authenticator below. ACLs,
    // status, timestamps, and local ordering are never accepted as trusted
    // controls from a peer.
    const metadataQuads = (metadataBySubject.get(ual) ?? []).filter(
      (quad) => GRAPH_SCOPED_SYNC_METADATA_PREDICATES.has(quad.predicate),
    );
    const versions = new Set(
      metadataQuads
        .filter((quad) => quad.predicate === ASSERTION_VERSION)
        .map((quad) => stripLiteral(quad.object)),
    );
    if (versions.size !== 1) {
      throw new Error(`Verified graph-scoped KA ${ual} has ${versions.size} assertion versions`);
    }
    const [versionRaw] = versions;
    if (!versionRaw || !/^\d+$/.test(versionRaw)) {
      throw new Error(`Verified graph-scoped KA ${ual} has invalid assertionVersion ${versionRaw ?? '<missing>'}`);
    }
    try {
      readGraphKnowledgeAssetConfirmationKindV1(metadataQuads);
    } catch (cause) {
      throw new Error(
        `Verified graph-scoped KA ${ual} has invalid confirmation metadata`,
        { cause },
      );
    }
    const metaGraphs = new Set(metadataQuads.map((quad) => quad.graph));
    if (metaGraphs.size !== 1) {
      throw new Error(`Verified graph-scoped KA ${ual} spans ${metaGraphs.size} metadata graphs`);
    }
    const [metaGraph] = metaGraphs;
    const expectedContextGraph = `did:dkg:context-graph:${contextGraphId}`;
    const contextGraphs = new Set(
      metadataQuads
        .filter((quad) => quad.predicate === CONTEXT_GRAPH)
        .map((quad) => stripLiteral(quad.object)),
    );
    if (
      metaGraph !== `${expectedContextGraph}/_meta`
      || contextGraphs.size !== 1
      || !contextGraphs.has(expectedContextGraph)
    ) {
      throw new Error(
        `Verified graph-scoped KA ${ual} is not bound to requested context graph ${contextGraphId}`,
      );
    }
    const identity = parseDeterministicKnowledgeAssetUal(ual);
    const batchId = packKnowledgeAssetIdFromIdentity(identity);
    metadataQuads.push({
      subject: ual,
      predicate: BATCH_ID,
      object: `"${batchId}"^^<${XSD_INTEGER}>`,
      graph: metaGraph,
    });
    assets.push({
      contextGraphId,
      ual,
      assertionVersion: BigInt(versionRaw),
      assertionGraph,
      metaGraph,
      dataQuads: dataByGraph.get(assertionGraph) ?? [],
      metadataQuads,
    });
    handledUals.add(ual);
  }

  return {
    assets,
    remainingData,
    remainingMeta: peerSafeMetadata.filter(
      (quad) => (
        !handledUals.has(quad.subject)
        && !(
          graphScopedMetadataSubjects.has(quad.subject)
          && quad.predicate === ASSERTION_VERSION
        )
      ),
    ),
  };
}

export function assertNoLegacyRfc64ControlGraphs(
  contextGraphId: string,
  verifiedData: readonly Quad[],
  verifiedMeta: readonly Quad[],
  verifiedGraphScopedDataGraphs: readonly string[],
): void {
  const reject = (graph: string): void => {
    // The verified worker result owns structural decoding. This boundary keeps
    // that typed contract and classifies only reserved graph IRIs.
    if (!isRfc64SemanticControlGraphV1(graph, contextGraphId)) return;
    throw Object.assign(
      new Error(
        `Legacy durable sync returned reserved RFC-64 control graph ${graph}`,
      ),
      { code: 'RFC64_CONTROL_GRAPH_LEGACY_SYNC_REJECTED' },
    );
  };
  for (const quad of verifiedData) reject(quad.graph);
  for (const quad of verifiedMeta) reject(quad.graph);
  for (const graph of verifiedGraphScopedDataGraphs) reject(graph);
}

function stripLiteral(raw: string): string {
  const match = raw.match(/^"(.*)"(?:\^\^.*|@.*)?$/);
  return match ? match[1]! : raw;
}
