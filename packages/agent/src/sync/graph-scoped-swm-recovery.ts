// SPDX-License-Identifier: Apache-2.0
import { validateSubGraphName } from '@origintrail-official/dkg-core';
import { workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { stripMetadataLiteral as stripLiteral } from './metadata-literal.js';
import { SWM_SHARE_OPERATION_ID as SHARE_OPERATION_ID, type GraphScopedSwmRecoveryDescriptor } from './graph-scoped-swm-head-parser.js';
export { parseGraphScopedSwmRecoveryDescriptors, parseGraphScopedSwmRecoveryHeadResults } from './graph-scoped-swm-head-parser.js';
export type { GraphScopedSwmRecoveryDescriptor, GraphScopedSwmRecoveryParseInput, RecoverySnapshotLocator } from './graph-scoped-swm-head-parser.js';
export { OPERATION_IDENTITY_PREDICATES, operationIdentityKey } from './graph-scoped-swm-operation-identity.js';
export interface MaterializedGraphScopedSwmRecoveryAsset
  extends GraphScopedSwmRecoveryDescriptor {
  readonly quads: readonly Quad[];
}

/**
 * Recovery and sync can run before this node holds a subgraph's registration
 * (nothing syncs it for a catalog-authoritative graph; the public sync lane
 * registers it once it stores its rows). The authenticated responder serves
 * only its registered subgraphs, so bootstrap valid lane names from its answer
 * and keep the local known-child exclusion as the final collision guard.
 */
export function discoverSwmRecoverySubGraphNames(params: {
  readonly contextGraphId: string;
  readonly metaQuads: readonly Quad[];
  readonly excludedSubGraphNames?: readonly string[];
}): string[] {
  const prefix = `did:dkg:context-graph:${params.contextGraphId}/`;
  const suffix = '/_shared_memory_meta';
  const excluded = new Set(params.excludedSubGraphNames ?? []);
  const names = new Set<string>();
  for (const quad of params.metaQuads) {
    const graph = quad.graph;
    if (!graph.startsWith(prefix) || !graph.endsWith(suffix)) continue;
    const name = graph.slice(prefix.length, -suffix.length);
    if (!name || excluded.has(name) || !validateSubGraphName(name).valid) continue;
    names.add(name);
  }
  return [...names].sort();
}

/**
 * Keep one store-backed snapshot request per validated graph-scoped alias
 * class. Operation metadata remains intact for head recovery, while the
 * snapshot walk follows the locator selected by the equivalence resolver.
 */
export function canonicalGraphScopedSnapshotManifestQuads(
  metaQuads: readonly Quad[],
  descriptors: readonly GraphScopedSwmRecoveryDescriptor[],
): Quad[] {
  const equivalentOperationSubjects = new Set<string>();
  const selectedSnapshotSubjects = new Set<string>();
  for (const descriptor of descriptors) {
    selectedSnapshotSubjects.add(descriptor.snapshotSource.operationSubject);
    for (const subject of descriptor.equivalentOperationSubjects) {
      equivalentOperationSubjects.add(subject);
    }
  }
  return metaQuads.filter((row) => (
    !equivalentOperationSubjects.has(row.subject)
    || selectedSnapshotSubjects.has(row.subject)
  ));
}

/**
 * Collapse only the current-head pointer rows covered by parsed descriptors.
 * Superseded operation subjects may remain as immutable history, but a head
 * itself must name exactly one operation or LIMIT-1 readers become arbitrary.
 */
export function canonicalizeGraphScopedSwmHeadRows(params: {
  readonly metaQuads: readonly Quad[];
  readonly descriptors: readonly GraphScopedSwmRecoveryDescriptor[];
}): Quad[] {
  const selectedByHead = new Map(
    params.descriptors.map((descriptor) => [
      `${descriptor.metaGraph}\u0000${descriptor.headSubject}`,
      descriptor.shareOperationId,
    ]),
  );
  return params.metaQuads.filter((row) => {
    if (row.predicate !== SHARE_OPERATION_ID) return true;
    const selected = selectedByHead.get(`${row.graph}\u0000${row.subject}`);
    return selected === undefined || stripLiteral(row.object).trim() === selected;
  });
}

/** Load and re-verify one immutable snapshot, then stamp its exact SWM graph. */
export async function materializeGraphScopedSwmRecoveryAsset(params: {
  readonly descriptor: GraphScopedSwmRecoveryDescriptor;
  readonly fetchedDataQuads: readonly Quad[];
  readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
}): Promise<MaterializedGraphScopedSwmRecoveryAsset> {
  const descriptor = params.descriptor;
  const { locator } = descriptor.snapshotSource;
  let raw: Quad[] | null;
  if (locator.kind === 'graph') {
    // The SWM responder serves the canonical per-KA assertion graph through
    // the ordinary `_shared_memory/{address}/{number}` data lane. The legacy
    // `publicSnapshotGraph` is provenance for stores that predate snapshot
    // blobs; it is outside that responder graph family and is therefore not
    // normally present on the wire. Prefer the descriptor's independently
    // validated assertion graph, while retaining read compatibility with peers
    // that explicitly transported the legacy locator graph.
    const assertionRows = params.fetchedDataQuads
      .filter((quad) => quad.graph === descriptor.assertionGraph);
    const sourceRows = assertionRows.length > 0 || descriptor.publicQuadsCount === 0
      ? assertionRows
      : params.fetchedDataQuads.filter((quad) => quad.graph === locator.graph);
    raw = sourceRows.map((quad) => ({ ...quad, graph: '' }));
  } else {
    if (!params.publicSnapshotStore) {
      throw new Error(`Graph-scoped SWM recovery requires a public snapshot store for ${descriptor.kaUal}`);
    }
    raw = await params.publicSnapshotStore.getSnapshot(locator.ref);
    // Legacy explicit refs can differ from the content digest. A network
    // recovery stores verified bytes under the canonical digest, so retain
    // read compatibility with the advertised ref while accepting that local
    // canonical copy on subsequent materialization attempts.
    if (!raw && locator.ref !== descriptor.publicQuadsDigest) {
      raw = await params.publicSnapshotStore.getSnapshot(descriptor.publicQuadsDigest);
    }
  }
  if (!raw) {
    throw new Error(`Graph-scoped SWM snapshot is missing for ${descriptor.kaUal}`);
  }
  const normalized = raw.map((quad) => ({ ...quad, graph: '' }));
  const actualDigest = workspacePublicQuadsDigest(normalized);
  if (
    normalized.length !== descriptor.publicQuadsCount
    || actualDigest !== descriptor.publicQuadsDigest
  ) {
    throw new Error(
      `Graph-scoped SWM snapshot failed integrity for ${descriptor.kaUal}: ` +
      `expected ${descriptor.publicQuadsDigest}/${descriptor.publicQuadsCount}, ` +
      `got ${actualDigest}/${normalized.length}`,
    );
  }
  return {
    ...descriptor,
    quads: normalized.map((quad) => ({ ...quad, graph: descriptor.assertionGraph })),
  };
}
