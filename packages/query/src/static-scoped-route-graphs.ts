import {
  contextGraphDataUri, contextGraphSubGraphUri, contextGraphSharedMemoryUri,
  contextGraphMetaUri, contextGraphSharedMemoryMetaUri,
  contextGraphSubGraphMetaUri, contextGraphPrivateUri, contextGraphSubGraphPrivateUri,
} from '@origintrail-official/dkg-core';
import type { QueryOptions } from './query-engine.js';

/** Static authority of a legacy scoped route, independent of store inventory. */
export function staticScopedRouteGraphs(effectiveContextGraphId: string, options?: QueryOptions) {
  // Authenticated callers that scope a query to a `contextGraphId`
  // already have read access to that CG; refusing them visibility
  // into the same CG's metadata graphs breaks every legitimate
  // metadata read:
  //   - `/_meta` — curator lookup, allowedAgent list, registration
  //     status (invite-flow `assert_curator_triple_landed` probe,
  //     CG Overview UI, downstream sync code)
  //   - `/_shared_memory_meta` — SWM share metadata (operation
  //     heads, digests, storage-ACK ledger) and legacy
  //     root-keyed workspaceOwner rows. Graph-scoped KAs (10.0.7+)
  //     keep ownership in the per-author SWM graph instead.
  //
  // Privacy fence: a caller that explicitly narrowed routing to
  // SWM-only via `graphSuffix: '_shared_memory'` does NOT gain
  // access to the CG-level `_meta` (curator / allowedAgent /
  // registrationStatus). They asked for SWM, they get SWM
  // (including `_shared_memory_meta`). All other scoped routes
  // expose both `_meta` and `_shared_memory_meta` for the
  // legitimate metadata reads called out above.
  //
  // Sub-graph metadata uses `contextGraphSubGraphMetaUri`
  // (`/<sub>/_meta`) — the same path the storage layer
  // (`graph-manager.ts`) writes to — not the
  // `/context/<sub>/_meta` shape produced by `contextGraphMetaUri`
  // when a subGraphId is passed.
  //
  // Metadata graphs are always part of the scoped explicit allow-set:
  // UI helpers enumerate sub-graph metadata with `GRAPH ?g` under a
  // contextGraphId, while explicit GRAPH IRIs still need the same static
  // route checks. Broader content-partition scans are handled later and
  // require an explicit count-query opt-in.
  const subGraphName = options?.subGraphName;
  const isSwmOnlyRoute = options?.graphSuffix === '_shared_memory';
  const dataGraph = subGraphName
    ? contextGraphSubGraphUri(effectiveContextGraphId, subGraphName)
    : contextGraphDataUri(effectiveContextGraphId);
  const sharedMemoryGraph = contextGraphSharedMemoryUri(effectiveContextGraphId, subGraphName);
  // Keep option precedence and ordering shared by admission and authorization.
  const staticContentGraphs = options?.includeSharedMemory ?? options?.includeWorkspace
    ? [dataGraph, sharedMemoryGraph]
    : isSwmOnlyRoute ? [sharedMemoryGraph] : [dataGraph];
  const metaAllowList = [
    ...(isSwmOnlyRoute
      ? []
      : subGraphName
        ? [
            // Sub-graph metadata graph (`<cg>/<sub>/_meta`).
            contextGraphSubGraphMetaUri(effectiveContextGraphId, subGraphName),
            // Root CG metadata graph (`<cg>/_meta`). Canonical KA provenance
            // (`rootEntity` / `partOf` / `confirmed` status) is written to the
            // ROOT `_meta` even for sub-graph publishes — see
            // `finalization-handler.ts` (the confirmed-meta writes hardcode
            // `<cg>/_meta`). A sub-graph-scoped reader (e.g. the EPCIS events
            // query) joins provenance from there, so the root `_meta` must be
            // admitted alongside the sub-graph `_meta`. Both are within the
            // same `contextGraphId`, so this does not cross the privacy
            // boundary (which is the CG scope itself).
            contextGraphMetaUri(effectiveContextGraphId),
          ]
        : [contextGraphMetaUri(effectiveContextGraphId)]),
    contextGraphSharedMemoryMetaUri(effectiveContextGraphId, subGraphName),
  ];
  // `_private` is excluded from the allow-set by default (it is more
  // sensitive than the `_meta` graphs above). Only callers that opt in
  // via `includePrivate` may name the CG's own private partition — the
  // EPCIS events query does this to surface private-anchored events to
  // the hosting node. This stays strictly within the queried CG, so it
  // is not a cross-CG leak, and it does not widen any other caller.
  const staticPrivateAllowList = options?.includePrivate
    ? [
        subGraphName
          ? contextGraphSubGraphPrivateUri(effectiveContextGraphId, subGraphName)
          : contextGraphPrivateUri(effectiveContextGraphId),
      ]
    : [];
  return { dataGraph, sharedMemoryGraph, staticContentGraphs, subGraphName, isSwmOnlyRoute, metaAllowList, staticPrivateAllowList };
}
