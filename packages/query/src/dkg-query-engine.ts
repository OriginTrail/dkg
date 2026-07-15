import type { TripleStore, Quad, QueryResult as StoreQueryResult } from '@origintrail-official/dkg-storage';
import {
  ExactGraphReadError,
  GraphManager,
  readExactGraphPaged,
} from '@origintrail-official/dkg-storage';
import type {
  QueryResult,
  QueryOptions,
  GraphAwareQueryEngine,
  ResolvedGraphKnowledgeAsset,
  ResolvedKnowledgeAsset,
  ResolvedLegacyKnowledgeAsset,
} from './query-engine.js';
import {
  contextGraphDataUri, contextGraphSharedMemoryUri, contextGraphVerifiableMemoryUri, contextGraphAssertionUri, contextGraphLayerUri, MemoryLayer,
  contextGraphLayerUriCandidates, contextGraphLayerPrefixCandidates,
  contextGraphSubGraphUri, contextGraphMetaUri, contextGraphSharedMemoryMetaUri, assertionLifecycleUri,
  contextGraphSubGraphMetaUri, contextGraphPrivateUri, contextGraphSubGraphPrivateUri,
  assertSafeIri, escapeSparqlLiteral, validateSubGraphName,
  ASSERTION_NAMED_GRAPH_PREFIX,
  isAssertionScopedChildGraph,
  type GetView,
  REMOVED_VIEWS,
  TrustLevel,
  TRUST_LEVEL_PREDICATE,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  buildGraphKnowledgeAssetMetadataQuery,
  parseGraphKnowledgeAssetMetadataBindings,
} from '@origintrail-official/dkg-core';
import {
  validateReadOnlySparql,
  emptyResultForSparql,
  detectSparqlQueryForm,
} from './sparql-guard.js';
import { stripLiteralsAndComments } from './sparql-utils.js';

/**
 * Result of resolving a V10 GET view to concrete graph targets.
 */
export interface ViewResolution {
  /** Exact named-graph URIs to query directly. */
  graphs: string[];
  /**
   * Graph URI prefixes — the engine discovers all named graphs matching
   * each prefix and unions the results. Used for working-memory (multiple
   * assertions) and verifiable-memory (multiple quorum graphs).
   */
  graphPrefixes: string[];
}

export class ScopedQueryViolationError extends Error {
  constructor(message: string) {
    super(`Scoped query violation: ${message}`);
    this.name = 'ScopedQueryViolationError';
  }
}

/**
 * Resolves a V10 GetView + context graph ID to the named-graph URIs (or
 * prefixes) that the query engine should target.
 *
 * Spec reference: §12 GET — Declared State Views.
 *
 * Trust-level semantics for `verifiable-memory`: graph scope is not a trust
 * signal. The root graph and `/_verifiable_memory/*` graphs are candidates;
 * `minTrust` is enforced by explicit writer-side `dkg:trustLevel` metadata.
 */
export function resolveViewGraphs(
  view: GetView,
  contextGraphId: string,
  opts?: {
    agentAddress?: string;
    /** Same-identity WM namespace aliases — see QueryOptions.agentAddressAliases. */
    agentAddressAliases?: string[];
    verifiedGraph?: string;
    assertionName?: string;
    /** Resolved KA number for single-graph by-name reads under the uniform layout. */
    kaNumber?: bigint;
    /** Spec §12/§14 trust-gradient filter. Enforced after graph resolution. */
    minTrust?: TrustLevel;
    /**
     * GH #184 — when set, the view is scoped to this registered sub-graph: the
     * uniform layout stores sub-graph layer data at `…/{sub}/{slug}/…`, so the
     * per-layer prefixes below gain the `/{sub}` segment.
     */
    subGraphName?: string;
  },
): ViewResolution {
  if (REMOVED_VIEWS.includes(view as string)) {
    throw new Error(
      `View '${view}' was removed in V10. Use 'verifiable-memory' for on-chain anchored data. ` +
      `See migration guide for details.`,
    );
  }
  // GH #184 — sub-graph segment threaded into every per-layer prefix/graph.
  const sg = opts?.subGraphName ? `/${opts.subGraphName}` : '';
  switch (view) {
    case 'working-memory': {
      if (!opts?.agentAddress) {
        throw new Error('agentAddress is required for the working-memory view');
      }
      // Uniform layout: WM data is in `…[/{sub}]/_working_memory/{addr}/{number}`. A
      // by-name read STAYS a single-graph read (no sibling-assertion leak); the caller
      // resolves name→number and passes opts.kaNumber, falling back to the legacy
      // name-keyed graph. Both single-graph URIs mirror the writer
      // (`DKGPublisher.wmGraphUri`), including the sub-graph segment — without it a
      // `subGraphName` + `assertionName` read targets the ROOT assertion graph and
      // misses sub-graph assertions (Codex review on PR #1132).
      if (opts.assertionName) {
        if (opts.kaNumber !== undefined) {
          return {
            graphs: contextGraphLayerUriCandidates(
              contextGraphId,
              MemoryLayer.WorkingMemory,
              opts.agentAddress,
              opts.kaNumber,
              opts.subGraphName,
            ),
            graphPrefixes: [],
          };
        }
        return {
          graphs: [contextGraphAssertionUri(
            contextGraphId,
            opts.agentAddress,
            opts.assertionName,
            opts.subGraphName,
          )],
          graphPrefixes: [],
        };
      }
      // PR #1107 review (🟡): span the primary address AND every
      // same-identity alias so a node default agent's legacy peerId-keyed
      // drafts and rc.17+ wallet-keyed drafts are both visible from one
      // unscoped WM read. New full EVM-address writes use the lowercase core
      // identity, while the caller's original casing is retained as a legacy
      // read prefix for graphs written before canonicalization.
      const graphPrefixes: string[] = [];
      const seen = new Set<string>();
      for (const address of [opts.agentAddress, ...(opts.agentAddressAliases ?? [])]) {
        if (!address) continue;
        for (const candidate of contextGraphLayerPrefixCandidates(
          contextGraphId,
          MemoryLayer.WorkingMemory,
          address,
          opts.subGraphName,
        )) {
          if (seen.has(candidate)) continue;
          seen.add(candidate);
          graphPrefixes.push(candidate);
        }
      }
      return {
        graphs: [],
        // Combine main's same-identity alias span (#1107 review 🟡) with
        // #1132's sub-graph scoping (#184/#675): one prefix per alias address,
        // each carrying the optional sub-graph suffix.
        graphPrefixes,
      };
    }
    case 'shared-working-memory':
      // Uniform layout: SWM is per-KA `…/_shared_memory/{addr}/{number}` (the prefix);
      // the bare bucket is kept as a read-both fallback (empty in the pure per-KA flow).
      return {
        graphs: [contextGraphSharedMemoryUri(contextGraphId, opts?.subGraphName)],
        graphPrefixes: [`did:dkg:context-graph:${contextGraphId}${sg}/_shared_memory/`],
      };
    case 'verifiable-memory': {
      // `minTrust` is a verifiable-memory concept. The earlier iterations ran the
      // numeric/enum validation at the top of `resolveViewGraphs`,
      // but that meant a caller who passes a generic options object
      // (e.g. `{ agentAddress, minTrust }`) across views would get
      // a 400 on `working-memory`/`shared-working-memory` too,
      // where the option is documented as ignored. Keep the
      // validation here so only verifiable-memory consumers see it.
      if (opts?.minTrust !== undefined) {
        const mt: unknown = opts.minTrust;
        const validLevels = [
          TrustLevel.SelfAttested,
          TrustLevel.Endorsed,
          TrustLevel.PartiallyVerified,
          TrustLevel.ConsensusVerified,
        ];
        if (typeof mt !== 'number' || !Number.isInteger(mt) || !validLevels.includes(mt as TrustLevel)) {
          // "minTrust" + "must be one of" mirrors the daemon's 400
          // classifier wording so the HTTP path maps to a client error.
          throw new Error(
            `Invalid minTrust ${JSON.stringify(mt)}: must be one of TrustLevel.SelfAttested (0), ` +
            `Endorsed (1), PartiallyVerified (2), ConsensusVerified (3). The HTTP /api/query route ` +
            `accepts the string forms "SelfAttested" | "Endorsed" | "PartiallyVerified" | ` +
            `"ConsensusVerified" and normalises them; in-process callers must pass the numeric enum.`,
          );
        }
      }

      if (opts?.verifiedGraph) {
        return {
          graphs: [contextGraphVerifiableMemoryUri(contextGraphId, opts.verifiedGraph)],
          graphPrefixes: [],
        };
      }
      // RC11 / PR-A (Codex review fix on #671, comment 3302058969):
      // re-include the root content graph
      // `did:dkg:context-graph:{id}` alongside the `_verifiable_memory/*`
      // post-`verify` named graphs.
      //
      // The PR2 first cut dropped the root from VM to plug the
      // "tentative VM" leak (failed publishes used to leave triples in
      // the root graph and surfaced via `view: 'verifiable-memory'`).
      // That leak is now fixed at the publisher: the root-graph
      // `store.insert(normalizedQuads)` was moved INSIDE the
      // chain-success branch of `DKGPublisher.publish` (see
      // `packages/publisher/src/dkg-publisher.ts` "RC11 / PR2: write
      // the published public quads into the root data graph ONLY after
      // the chain has confirmed"), so a failed on-chain publish writes
      // nothing to the root graph. The three intentional-local
      // branches (`no on-chain CG id`, `chain not V10-ready`,
      // `private data — no ACKs collectable`) write through
      // `finalizeIntentionalLocalPublish` — these are deliberate
      // local-only publishes, not failed chain publishes, and were
      // already part of VM pre-PR2.
      //
      // Dropping the root graph here was a behavioural break for
      // existing callers (memory-search flows and the daemon's
      // `/api/query?view=verifiable-memory` route after named VM publish):
      // a successful publish would
      // silently disappear from VM until a separate `verify()` wrote
      // into `_verifiable_memory/{vmId}`. Restoring the root graph keeps
      // confirmed publisher-side data immediately queryable via VM
      // while `_verifiable_memory/*` remains the source of truth for
      // cross-node consensus-verified data (still stamped with
      // `dkg:trustLevel` ConsensusVerified by
      // `DKGAgent.promoteToVerifiableMemory`).
      return {
        // Include the content ROOT graph: the bare CG data graph for an
        // unscoped read, or the sub-graph root `…/{cg}/{sub}` when scoped.
        // Codex #1132 review: the publisher's intentional-local / pre-verify
        // sub-graph publishes land in `…/{cg}/{sub}` (not `…/_verifiable_memory/*`),
        // so a sub-graph VM read previously returned `[]` and missed confirmed
        // data — mirror the root-CG branch and include the sub-graph root.
        graphs: [opts?.subGraphName
          ? contextGraphSubGraphUri(contextGraphId, opts.subGraphName)
          : `did:dkg:context-graph:${contextGraphId}`],
        graphPrefixes: [`did:dkg:context-graph:${contextGraphId}${sg}/_verifiable_memory/`],
      };
    }
  }
}

/**
 * Local-only query engine that executes SPARQL against this node's own
 * triple store. No remote query capability — by design (Spec §1.6 Store
 * Isolation). All data must arrive via protocol messages (publish, access,
 * sync) before it can be queried here.
 */
export class DKGQueryEngine implements GraphAwareQueryEngine {
  private readonly store: TripleStore;
  private readonly graphManager: GraphManager;
  // Collapse the dashboard's parallel WM/SWM/VM count scans without retaining
  // a completed allow-list that could miss newly-created assertion graphs.
  private readonly scopedContentGraphAllowListInFlight = new Map<string, Promise<string[]>>();

  constructor(store: TripleStore) {
    this.store = store;
    this.graphManager = new GraphManager(store);
  }

  async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    const guard = validateReadOnlySparql(sparql);
    if (!guard.safe) {
      throw new Error(`SPARQL rejected: ${guard.reason}`);
    }

    // ── V10 view-based routing ────────────────────────────────────────
    const effectiveContextGraphId = options?.contextGraphId;
    if (effectiveContextGraphId) {
      assertNoCallerDatasetClauses(sparql);
    }

    if (options?.subGraphName) {
      const v = validateSubGraphName(options.subGraphName);
      if (!v.valid) throw new Error(`Invalid sub-graph name for query: ${v.reason}`);
    }

    if (effectiveContextGraphId && !options?.view) {
      const dataGraph = options?.subGraphName
        ? contextGraphSubGraphUri(effectiveContextGraphId, options.subGraphName)
        : contextGraphDataUri(effectiveContextGraphId);
      const sharedMemoryGraph = contextGraphSharedMemoryUri(effectiveContextGraphId, options?.subGraphName);
      // Per-KA SWM: when a route targets SWM, expand the allow-set with the discovered
      // …/_shared_memory/{addr}/{number} graphs so GRAPH-variable scans bind them.
      const swmRouted = (options?.includeSharedMemory ?? options?.includeWorkspace) || options?.graphSuffix === '_shared_memory';
      const swmPerKaGraphs = swmRouted ? await this.discoverGraphsByPrefix(`${sharedMemoryGraph}/`) : [];
      // Per-KA VM: published data is in …/_verifiable_memory/{addr}/{number}; bind those too
      // for GRAPH-variable scans on any route that reads the data graph.
      const dataRouted = options?.graphSuffix !== '_shared_memory';
      const vmPerKaGraphs = dataRouted ? await this.discoverGraphsByPrefix(`${dataGraph}/_verifiable_memory/`) : [];
      const allowedGraphs = options?.includeSharedMemory ?? options?.includeWorkspace
        ? [dataGraph, ...vmPerKaGraphs, sharedMemoryGraph, ...swmPerKaGraphs]
        : options?.graphSuffix === '_shared_memory'
          ? [sharedMemoryGraph, ...swmPerKaGraphs]
          : [dataGraph, ...vmPerKaGraphs];
      // Authenticated callers that scope a query to a `contextGraphId`
      // already have read access to that CG; refusing them visibility
      // into the same CG's metadata graphs breaks every legitimate
      // metadata read:
      //   - `/_meta` — curator lookup, allowedAgent list, registration
      //     status (invite-flow `assert_curator_triple_landed` probe,
      //     CG Overview UI, downstream sync code)
      //   - `/_shared_memory_meta` — workspaceOwner / promote-time
      //     ownership metadata (devnet-test-swm-ownership-restart
      //     `wait_for_owner_meta` probe, ACL enforcement on replicas).
      //
      // Privacy fence: a caller that explicitly narrowed routing to
      // SWM-only via `graphSuffix: '_shared_memory'` does NOT gain
      // access to the CG-level `_meta` (curator / allowedAgent /
      // registrationStatus). They asked for SWM, they get SWM
      // (including `_shared_memory_meta` for the workspaceOwner /
      // ownership ACL probe). All other scoped routes expose both
      // `_meta` and `_shared_memory_meta` for the legitimate metadata
      // reads called out above.
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
      const privateAllowList = options?.includePrivate
        ? [
            subGraphName
              ? contextGraphSubGraphPrivateUri(effectiveContextGraphId, subGraphName)
              : contextGraphPrivateUri(effectiveContextGraphId),
          ]
        : [];
      const explicitAllowedGraphs = [...allowedGraphs, ...metaAllowList, ...privateAllowList];
      const shouldExpandGraphVariables =
        options?.includeContextGraphPartitions === true && collectGraphVariables(sparql).length > 0;
      const variableAllowedGraphs = shouldExpandGraphVariables
        ? await this.resolveScopedGraphVariableAllowList(
            effectiveContextGraphId,
            explicitAllowedGraphs,
            { subGraphName, isSwmOnlyRoute },
          )
        : explicitAllowedGraphs;
      // Explicit GRAPH IRIs remain limited to the static route-specific
      // allow-list. GRAPH variables only gain known same-CG content
      // partitions for callers that explicitly opt into broad count scans;
      // legacy scoped routes keep their selected memory-layer contract.
      assertExplicitGraphIrisAllowed(sparql, explicitAllowedGraphs);
      sparql = constrainGraphVariablesToAllowedSet(sparql, variableAllowedGraphs);
    }

    if (options?.view) {
      if (!effectiveContextGraphId) {
        throw new Error(
          `view '${options.view}' requires a contextGraphId to scope the query`,
        );
      }
      // GH #184 — `subGraphName` + `view` is now supported: the view scopes to
      // the named sub-graph's per-layer partitions (handled in queryWithView /
      // resolveViewGraphs). Validate the name shape before routing.
      if (options.subGraphName) {
        const v = validateSubGraphName(options.subGraphName);
        if (!v.valid) throw new Error(v.reason);
      }
      return this.queryWithView(sparql, options.view, effectiveContextGraphId, options);
    }

    // ── Legacy routing (V9 compat) ────────────────────────────────────
    let effectiveSparql = sparql;

    if (effectiveContextGraphId) {
      const dataGraph = options?.subGraphName
        ? contextGraphSubGraphUri(effectiveContextGraphId, options.subGraphName)
        : contextGraphDataUri(effectiveContextGraphId);
      const sharedMemoryGraph = contextGraphSharedMemoryUri(effectiveContextGraphId, options?.subGraphName);
      if (options?.includeSharedMemory ?? options?.includeWorkspace) {
        // Per-KA VM: read-both the published per-KA …/_verifiable_memory/{addr}/{number} + root.
        const vmGraphsInc = await this.discoverGraphsByPrefix(`${dataGraph}/_verifiable_memory/`);
        const dataSparql = vmGraphsInc.length > 0
          ? (this.wrapVerifiableMemoryGraphSet(sparql, [dataGraph, ...vmGraphsInc])
            ?? wrapWithGraph(sparql, dataGraph))
          : wrapWithGraph(sparql, dataGraph);
        // Per-KA SWM: union the discovered …/_shared_memory/{addr}/{number} graphs.
        const swmGraphs = await this.discoverGraphsByPrefix(`${sharedMemoryGraph}/`);
        const sharedMemorySparql = swmGraphs.length > 0
          ? (wrapWithGraphUnion(sparql, swmGraphs) ?? wrapWithGraph(sparql, sharedMemoryGraph))
          : wrapWithGraph(sparql, sharedMemoryGraph);
        const dataResult = await this.store.query(dataSparql);
        const smResult = await this.store.query(sharedMemorySparql);
        return mergeSharedMemoryAndDataResults(dataResult, smResult);
      }
      if (options?.graphSuffix === '_shared_memory') {
        // Uniform layout: SWM is per-KA …/_shared_memory/{addr}/{number}. Discover the
        // per-KA graphs under the prefix and union them (the legacy bucket is now empty).
        const swmGraphs = await this.discoverGraphsByPrefix(`${sharedMemoryGraph}/`);
        effectiveSparql = swmGraphs.length > 0
          ? (wrapWithGraphUnion(sparql, swmGraphs) ?? wrapWithGraph(sparql, sharedMemoryGraph))
          : wrapWithGraph(sparql, sharedMemoryGraph);
      } else {
        // Per-KA VM: read-both the published per-KA …/_verifiable_memory/{addr}/{number} + root.
        const vmGraphs = await this.discoverGraphsByPrefix(`${dataGraph}/_verifiable_memory/`);
        effectiveSparql = vmGraphs.length > 0
          ? (this.wrapVerifiableMemoryGraphSet(sparql, [dataGraph, ...vmGraphs])
            ?? wrapWithGraph(sparql, dataGraph))
          : wrapWithGraph(sparql, dataGraph);
      }
    }

    const result = await this.execAndNormalize(effectiveSparql);

    // Strip results originating from excluded graphs (e.g. private CGs).
    if (options?.excludeGraphPrefixes?.length && result.bindings.length > 0) {
      return this.filterExcludedGraphs(result, options.excludeGraphPrefixes);
    }

    return result;
  }

  /**
   * Remove bindings that contain values matching excluded graph URI prefixes.
   * This prevents private CG data from leaking into unscoped queries.
   */
  private filterExcludedGraphs(result: QueryResult, prefixes: string[]): QueryResult {
    const filtered = result.bindings.filter((binding) => {
      for (const value of Object.values(binding)) {
        if (typeof value !== 'string') continue;
        // Strip surrounding angle brackets or quotes from URIs
        const clean = value.replace(/^[<"]|[>"]$/g, '');
        for (const prefix of prefixes) {
          if (clean.startsWith(prefix)) return false;
        }
      }
      return true;
    });
    return { ...result, bindings: filtered };
  }

  /**
   * Execute a SPARQL query scoped to a declared V10 state view.
   */
  private async queryWithView(
    sparql: string,
    view: GetView,
    contextGraphId: string,
    options: QueryOptions,
  ): Promise<QueryResult> {
    // Uniform layout (rc.17): a by-name working-memory read must target the per-KA
    // graph `…/_working_memory/{addr}/{number}` the data was written to. Resolve the
    // KA number from the `dkg:kaId` stamped on the lifecycle URN in `_meta` and pass
    // it to resolveViewGraphs; without it the read falls back to the (empty) legacy
    // name-keyed graph and returns nothing for newly created assertions.
    let kaNumber: bigint | undefined;
    if (view === 'working-memory' && options.assertionName && options.agentAddress) {
      kaNumber = await this.resolveWorkingMemoryKaNumber(
        contextGraphId,
        options.agentAddress,
        options.assertionName,
        options.subGraphName,
      );
    }

    const resolution = resolveViewGraphs(view, contextGraphId, {
      agentAddress: options.agentAddress,
      agentAddressAliases: options.agentAddressAliases,
      verifiedGraph: options.verifiedGraph,
      assertionName: options.assertionName,
      kaNumber,
      // GH #184 — scope the view to a named sub-graph when requested.
      subGraphName: options.subGraphName,
      // Back-compat: accept the legacy `_minTrust` underscore form for a
      // deprecation window. See QueryOptions._minTrust.
      minTrust: options.minTrust ?? options._minTrust,
    });

    const allGraphs = [...resolution.graphs];

    for (const prefix of resolution.graphPrefixes) {
      const discovered = await this.discoverGraphsByPrefix(prefix);
      allGraphs.push(...discovered);
    }

    // A by-name WM read is pinned to one assertion root to avoid sibling leaks,
    // but named-graph draft content is stored under child graphs of that exact
    // root. Include only the selected assertion's scoped child family.
    if (view === 'working-memory' && options.assertionName) {
      for (const rootGraph of resolution.graphs) {
        allGraphs.push(...(await this.discoverGraphsByPrefix(`${rootGraph}${ASSERTION_NAMED_GRAPH_PREFIX}`)));
      }
    }

    // GH #675 — a view read WITHOUT an explicit subGraphName must also include
    // data that lives in registered sub-graphs. The uniform layout stores those
    // at `…/{sub}/{slug}/…`, which the context-graph-root prefix never matches,
    // so they were silently excluded. Fan out across registered sub-graphs and
    // add each one's per-layer partitions. (A by-name WM read is already pinned
    // to a single graph, so skip the fan-out there.)
    // Codex #1132 review: also skip the fan-out for a single-graph
    // `verifiedGraph` VM read — it is already pinned to one graph (like a
    // by-name WM read); fanning out would broaden it across every sub-graph's
    // VM partition and return unrelated rows.
    if (!options.subGraphName && !options.verifiedGraph && !(view === 'working-memory' && options.assertionName)) {
      const subNames = await this.discoverRegisteredSubGraphNames(contextGraphId);
      for (const sub of subNames) {
        const subResolution = resolveViewGraphs(view, contextGraphId, {
          agentAddress: options.agentAddress,
          subGraphName: sub,
        });
        allGraphs.push(...subResolution.graphs);
        for (const prefix of subResolution.graphPrefixes) {
          allGraphs.push(...(await this.discoverGraphsByPrefix(prefix)));
        }
      }
    }

    // GH #1098 — include the per-cgId VM data graph(s) `<cg>/context/<onChainId>`.
    // Chain-driven VM reconcile (and any per-cgId-only materialisation — e.g. a
    // peer that subscribed BEFORE publish and recovered via the reconcile sweep,
    // which writes confirmed data into the per-cgId graph WITHOUT the root-label
    // dual-write copy) lands confirmed data ONLY in `<cg>/context/<id>`. The base
    // `verifiable-memory` resolution above only reads the root content graph +
    // `_verifiable_memory/*`, so that data was invisible to a VM read (the
    // observable symptom of #1098: a pre-subscribed peer never "saw" the
    // published KA even though it had materialised it). Union the per-cgId DATA
    // graphs (resolved from the store, so no subscription state is needed) into
    // the allow-set for an unscoped VM read.
    if (view === 'verifiable-memory' && !options.verifiedGraph && !options.subGraphName) {
      allGraphs.push(...(await this.discoverContextGraphPerCgIdDataGraphs(contextGraphId)));
    }

    // De-dup so a sub-graph never gets unioned twice.
    const dedupedGraphs = [...new Set(allGraphs)];
    allGraphs.length = 0;
    allGraphs.push(...dedupedGraphs);

    if (allGraphs.length === 0) {
      // PR #239 / r17-2: a zero-graph resolution (e.g. a `verifiable-memory`
      // query with `minTrust=Endorsed` on a context graph that has not
      // been populated with any `/_verifiable_memory/*` sub-graphs yet) must
      // still respect the requested query form. Returning `{ bindings: [] }`
      // for an ASK would look like a SELECT result and break clients that
      // rely on ASK's boolean binding; CONSTRUCT/DESCRIBE must carry
      // `quads: []`. Delegate to the shared kind-aware empty-result helper.
      return emptyResultForSparql(sparql);
    }

    assertExplicitGraphIrisAllowed(sparql, allGraphs);
    sparql = constrainGraphVariablesToAllowedSet(sparql, allGraphs);

    // Spec §14 trust-gradient filter — only enforced on verifiable-memory
    // where on-chain-anchored trust metadata is expected to live.
    // When `minTrust` (or legacy `_minTrust`) is set, rewrite the query so
    // every subject matched by the user's pattern MUST carry an explicit
    // `http://dkg.io/ontology/trustLevel` literal whose integer value is
    // ≥ minTrust. Subjects with no trust metadata are rejected.
    //
    // previously, when `injectMinTrustFilter()` could not
    // safely rewrite the query (e.g. explicit GRAPH, non-BGP first
    // clause, multi-subject WHERE), we silently ran the ORIGINAL
    // unfiltered SPARQL. That turned the trust threshold into a no-op in
    // exactly the shapes most likely to span sensitive data, and a caller
    // had no signal that their threshold was being ignored. Now the
    // rewriter MUST succeed or we fail closed — returning an empty result
    // is the correct behaviour for "no subject meets the trust threshold"
    // when we cannot prove the threshold was applied.
    let effectiveSparql = sparql;
    const effectiveMinTrust = options.minTrust ?? options._minTrust;
    // `SelfAttested` (0) is the floor and means no trust filter is needed.
    // Endorsed and above require explicit writer-side trust metadata.
    if (
      view === 'verifiable-memory' &&
      effectiveMinTrust !== undefined &&
      effectiveMinTrust > TrustLevel.SelfAttested
    ) {
      const rewritten = injectMinTrustFilter(sparql, effectiveMinTrust);
      if (!rewritten) {
        console.warn(
          `[DKGQueryEngine] minTrust=${effectiveMinTrust} requested for a query shape ` +
            `injectMinTrustFilter cannot safely rewrite; returning empty result (fail-closed)`,
        );
        // Preserve the query form so CONSTRUCT/DESCRIBE callers see
        // `{ bindings: [], quads: [] }` rather than a shapeless deny, and
        // ASK callers see `{ bindings: [{ result: 'false' }] }`.
        return emptyResultForSparql(sparql);
      }
      effectiveSparql = rewritten;
    }

    if (allGraphs.length === 1) {
      return this.execAndNormalize(wrapWithGraph(effectiveSparql, allGraphs[0]));
    }

    if (view === 'verifiable-memory') {
      const rewritten = this.wrapVerifiableMemoryGraphSet(effectiveSparql, allGraphs);
      if (rewritten !== null) return this.execAndNormalize(rewritten);
    }

    return this.queryMultipleGraphs(effectiveSparql, allGraphs);
  }

  /** Canonical graph rewrite for root + per-KA/per-cgId verifiable-memory reads. */
  private wrapVerifiableMemoryGraphSet(sparql: string, graphs: string[]): string | null {
    if (graphs.length === 0) return sparql;
    if (graphs.length === 1) return wrapWithGraph(sparql, graphs[0]);
    return wrapWithDeduplicatedGraphValues(sparql, graphs)
      ?? wrapWithGraphValues(sparql, graphs)
      ?? wrapWithGraphUnion(sparql, graphs);
  }

  private async queryMultipleGraphs(sparql: string, graphs: string[]): Promise<QueryResult> {
    if (graphs.length === 0) return { bindings: [] };
    if (graphs.length === 1) {
      return this.execAndNormalize(wrapWithGraph(sparql, graphs[0]));
    }
    // Prefer a single `VALUES ?g { … } GRAPH ?g { … }` query: it scopes the
    // read to the named-graph set as ONE basic graph pattern iterated over a
    // table, instead of one `{ GRAPH <g> { … } }` UNION branch per graph. A
    // per-graph UNION over the ~1.4k SWM graphs of a large public context
    // graph builds a ~1.4k-branch UnionNode that makes the oxigraph-server
    // planner blow up and drop the socket ("fetch failed", issue #1596); the
    // VALUES form plans in constant depth. LIMIT/ORDER BY/DISTINCT/aggregate
    // semantics are preserved because those modifiers stay in the outer query
    // around the injected block.
    const valuesSparql = wrapWithGraphValues(sparql, graphs);
    if (valuesSparql !== null) {
      return this.execAndNormalize(valuesSparql);
    }
    // Residual shapes `wrapWithGraphValues` declines (an inner top-level
    // UNION, no locatable WHERE block, or a sentinel-variable collision) keep
    // the original union / per-graph fallback so the #789 form-aware
    // cross-graph merge below is preserved unchanged.
    const unionSparql = wrapWithGraphUnion(sparql, graphs);
    if (unionSparql !== null) {
      return this.execAndNormalize(unionSparql);
    }
    // Fallback: the inner body contains a UNION so we cannot safely wrap
    // in a single query without either crashing Blazegraph (nested
    // UnionNode) or leaking a helper variable. Run per-graph and merge
    // results in a FORM-AWARE way (Codex review on #789): flattening
    // every form into `bindings` silently corrupts CONSTRUCT/DESCRIBE
    // (drops `quads`), ASK (drops the boolean), and SELECT result sets
    // (concatenation can't honour cross-graph LIMIT/ORDER BY/DISTINCT/
    // aggregates). This path is rare (a user UNION over a multi-graph
    // view), but it must not return the wrong shape.
    const form = detectSparqlQueryForm(sparql);

    if (form === 'CONSTRUCT' || form === 'DESCRIBE') {
      // Graph-shaped results: the correct cross-graph merge is the union
      // of the per-graph triple sets (deduped — the same triple can be
      // constructed from multiple source graphs).
      const merged: Quad[] = [];
      for (const g of graphs) {
        const r = await this.execAndNormalize(wrapWithGraph(sparql, g));
        if (r.quads) merged.push(...r.quads);
      }
      return { bindings: [], quads: dedupeQuads(merged) };
    }

    if (form === 'ASK') {
      // Boolean result: true iff the pattern matches in ANY graph.
      // Short-circuit on the first positive graph.
      for (const g of graphs) {
        const r = await this.execAndNormalize(wrapWithGraph(sparql, g));
        if (r.bindings[0]?.result === 'true') {
          return { bindings: [{ result: 'true' }] };
        }
      }
      return { bindings: [{ result: 'false' }] };
    }

    // SELECT (and UNKNOWN, which validateReadOnlySparql should already
    // have rejected upstream). Per-graph concatenation is only correct
    // when there are NO solution-set modifiers — DISTINCT/ORDER BY/
    // LIMIT/OFFSET/GROUP BY/HAVING/aggregates all operate over the full
    // solution set and cannot be reconstructed from per-graph slices.
    // Rather than silently return duplicate / mis-ordered / over-limit
    // rows, reject the unsupported shape explicitly so the caller gets a
    // clear error instead of wrong data.
    if (hasCrossGraphUnsafeModifier(sparql)) {
      throw new Error(
        'Multi-graph query combines an inner UNION with a solution-set ' +
          'modifier (DISTINCT/ORDER BY/LIMIT/OFFSET/GROUP BY/aggregate). ' +
          'This shape cannot be evaluated across graphs without corrupting ' +
          'the modifier semantics. Scope the query to a single graph (pass ' +
          'contextGraphId) or remove the inner UNION.',
      );
    }
    const all: Record<string, string>[] = [];
    for (const g of graphs) {
      const r = await this.execAndNormalize(wrapWithGraph(sparql, g));
      all.push(...r.bindings);
    }
    return { bindings: all };
  }

  private async discoverGraphsByPrefix(prefix: string): Promise<string[]> {
    const allGraphs = await listGraphsByPrefix(this.store, prefix);
    return allGraphs.filter(
      (g) => g.startsWith(prefix) && !g.includes('/_meta') && !g.includes('/staging/'),
    );
  }

  /**
   * GH #1098 — discover the per-cgId VM DATA graphs `<cg>/context/<onChainId>`
   * for a context graph. Chain-reconciled / per-cgId-only publishes materialise
   * confirmed VM content here rather than in the root content graph. We keep
   * ONLY the bare `<cg>/context/<id>` data graphs: `discoverGraphsByPrefix`
   * already drops `/_meta` + `/staging/`, and the extra `!rest.includes('/')`
   * guard excludes any nested per-cgId sub-partition (`…/context/<id>/_private`,
   * `…/context/<id>/_shared_memory`, …) so a VM content read never pulls
   * private/SWM rows.
   */
  private async discoverContextGraphPerCgIdDataGraphs(contextGraphId: string): Promise<string[]> {
    const base = `did:dkg:context-graph:${contextGraphId}/context/`;
    const discovered = await this.discoverGraphsByPrefix(base);
    return discovered.filter((g) => {
      const rest = g.slice(base.length);
      return rest.length > 0 && !rest.includes('/');
    });
  }

  /**
   * Resolve a WM assertion's allocated KA number (`dkg:kaId`) off its lifecycle URN
   * in `_meta`, for single-graph by-name reads under the uniform layout. Returns
   * `undefined` for an unallocated draft (legacy name-keyed graph fallback). Mirrors
   * the publisher's `resolveKaNumber`.
   */
  private async resolveWorkingMemoryKaNumber(
    contextGraphId: string,
    agentAddress: string,
    assertionName: string,
    subGraphName?: string,
  ): Promise<bigint | undefined> {
    // Mirror the writer (`assertionFinalize`): the `dkg:kaId` stamp lives in the
    // ROOT `_meta` graph, but keyed by the SUB-GRAPH-AWARE lifecycle URN
    // (`urn:dkg:assertion:{cg}:{sub}:{addr}:{name}`). Omitting the sub-graph
    // segment here made every sub-graph by-name lookup miss (Codex on PR #1132).
    const urn = assertionLifecycleUri(contextGraphId, agentAddress, assertionName, subGraphName);
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const res = await this.store.query(
      `SELECT ?n WHERE { GRAPH <${metaGraph}> { <${urn}> <http://dkg.io/ontology/kaId> ?n } } LIMIT 1`,
    );
    if (res.type === 'bindings' && res.bindings.length > 0) {
      const m = res.bindings[0]['n']?.match(/(\d+)/);
      if (m) return BigInt(m[1]);
    }
    return undefined;
  }

  private async resolveScopedGraphVariableAllowList(
    contextGraphId: string,
    staticAllowedGraphs: string[],
    opts: { subGraphName?: string; isSwmOnlyRoute: boolean },
  ): Promise<string[]> {
    if (opts.isSwmOnlyRoute) {
      return staticAllowedGraphs;
    }

    const allowed = new Set(staticAllowedGraphs);
    const scopedContentGraphs = await this.resolveScopedContentGraphAllowList(
      contextGraphId,
      opts.subGraphName,
    );
    for (const graph of scopedContentGraphs) {
      allowed.add(graph);
    }

    return [...allowed];
  }

  private async resolveScopedContentGraphAllowList(
    contextGraphId: string,
    subGraphName?: string,
  ): Promise<string[]> {
    const key = JSON.stringify([contextGraphId, subGraphName ?? null]);
    const cached = this.scopedContentGraphAllowListInFlight.get(key);
    if (cached) {
      return cached;
    }

    const promise = this.discoverScopedContentGraphAllowList(contextGraphId, subGraphName);
    this.scopedContentGraphAllowListInFlight.set(key, promise);

    try {
      return await promise;
    } finally {
      if (this.scopedContentGraphAllowListInFlight.get(key) === promise) {
        this.scopedContentGraphAllowListInFlight.delete(key);
      }
    }
  }

  private async discoverScopedContentGraphAllowList(
    contextGraphId: string,
    subGraphName?: string,
  ): Promise<string[]> {
    const allowed = new Set<string>();
    const registeredSubGraphs = subGraphName
      ? new Set([subGraphName])
      : await this.discoverRegisteredSubGraphNames(contextGraphId);
    const registeredAssertionGraphs = await this.discoverRegisteredAssertionGraphs(contextGraphId);
    const knownChildContextGraphs = await this.discoverKnownChildContextGraphUris(contextGraphId);
    const allGraphs = await listGraphFamily(this.store, `did:dkg:context-graph:${contextGraphId}`);

    for (const graph of allGraphs) {
      if (
        isScopedContentGraph(
          graph,
          contextGraphId,
          registeredSubGraphs,
          registeredAssertionGraphs,
          knownChildContextGraphs,
          subGraphName,
        )
      ) {
        allowed.add(graph);
      }
    }

    return [...allowed];
  }

  private async discoverRegisteredSubGraphNames(contextGraphId: string): Promise<Set<string>> {
    const names = new Set<string>();
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?name WHERE {
        GRAPH <${assertSafeIri(metaGraph)}> {
          ?subGraph a <http://dkg.io/ontology/SubGraph> ;
                    <http://schema.org/name> ?name .
        }
      }`,
    );
    if (result.type !== 'bindings') return names;

    for (const row of result.bindings) {
      const name = stripSparqlLiteralValue(row['name']);
      if (validateSubGraphName(name).valid) {
        names.add(name);
      }
    }
    return names;
  }

  private async discoverRegisteredAssertionGraphs(contextGraphId: string): Promise<Set<string>> {
    const graphs = new Set<string>();
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const result = await this.store.query(
      `SELECT ?graph WHERE {
        GRAPH <${assertSafeIri(metaGraph)}> {
          ?assertion <http://dkg.io/ontology/assertionGraph> ?graph .
        }
      }`,
    );
    if (result.type !== 'bindings') return graphs;

    for (const row of result.bindings) {
      const graph = row['graph'];
      if (typeof graph === 'string' && graph.length > 0) {
        graphs.add(graph);
      }
    }
    return graphs;
  }

  private async discoverKnownChildContextGraphUris(contextGraphId: string): Promise<Set<string>> {
    const rootPrefix = `${contextGraphDataUri(contextGraphId)}/`;
    const result = await this.store.query(
      `SELECT DISTINCT ?ctxGraph WHERE {
        GRAPH ?g {
          {
            ?ctxGraph <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://dkg.network/ontology#ContextGraph> .
          } UNION {
            ?ctxGraph <https://dkg.network/ontology#registrationStatus> ?status .
          }
        }
        FILTER(STR(?g) = CONCAT(STR(?ctxGraph), "/_meta"))
        FILTER(STRSTARTS(STR(?ctxGraph), "${escapeSparqlLiteral(rootPrefix)}"))
      }`,
    );
    const uris = new Set<string>();
    if (result.type !== 'bindings') return uris;

    for (const row of result.bindings) {
      const uri = row['ctxGraph'];
      if (typeof uri === 'string' && uri.length > 0) {
        uris.add(uri);
      }
    }
    return uris;
  }

  private async execAndNormalize(sparql: string): Promise<QueryResult> {
    const result = await this.store.query(sparql);

    if (result.type === 'bindings') {
      if (result.bindings.length === 0) {
        const empty = emptyResultForSparql(sparql);
        if (empty.quads !== undefined) return empty;
      }
      return { bindings: result.bindings };
    }
    if (result.type === 'quads') {
      return { bindings: [], quads: result.quads };
    }
    if (result.type === 'boolean') {
      return { bindings: [{ result: String(result.value) }] };
    }
    return { bindings: [] };
  }

  async resolveKA(ual: string): Promise<ResolvedLegacyKnowledgeAsset> {
    const resolved = await this.resolveKnowledgeAsset(ual);
    if (resolved.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION) {
      throw new Error(
        'Graph-scoped Knowledge Assets do not have root entities; use resolveKnowledgeAsset()',
      );
    }
    return resolved;
  }

  async resolveKnowledgeAsset(ual: string): Promise<ResolvedKnowledgeAsset> {
    const safeUal = assertSafeIri(ual);
    const graphScoped = await this.resolveGraphScopedKA(safeUal);
    if (graphScoped) return graphScoped;
    return this.resolveLegacyRootScopedKA(safeUal);
  }

  private async resolveGraphScopedKA(
    ual: string,
  ): Promise<ResolvedGraphKnowledgeAsset | null> {
    const metaResult = await this.store.query(
      buildGraphKnowledgeAssetMetadataQuery(ual),
    );
    const parsed = parseGraphKnowledgeAssetMetadataBindings(
      ual,
      metaResult.type === 'bindings' ? metaResult.bindings : [],
    );
    if (parsed.kind !== 'graph') return null;
    const metadata = parsed.metadata;
    const expectedGraph = metadata.assertionGraph;

    let quads: Quad[];
    try {
      quads = await readExactGraphPaged(this.store, expectedGraph, {
        expectedQuadCount: metadata.publicTripleCount,
        queryOptions: { source: 'query.resolveKnowledgeAsset' },
      });
    } catch (error) {
      if (error instanceof ExactGraphReadError && error.code === 'QUAD_COUNT_MISMATCH') {
        throw new Error(
          `Graph-scoped KA ${ual} graph integrity mismatch: metadata declares ` +
            `${metadata.publicTripleCount} public triples, found ${error.actual ?? 'an unknown count'}`,
        );
      }
      throw error;
    }
    if (quads.length !== metadata.publicTripleCount) {
      throw new Error(
        `Graph-scoped KA ${ual} graph integrity mismatch: metadata declares ${metadata.publicTripleCount} public triples, found ${quads.length}`,
      );
    }

    return {
      ual: metadata.scope.ual,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      assertionVersion: metadata.scope.assertionVersion,
      assertionGraph: expectedGraph,
      rootEntities: [],
      contextGraphId: metadata.contextGraphId,
      quads,
    };
  }

  private async resolveLegacyRootScopedKA(
    ual: string,
  ): Promise<ResolvedLegacyKnowledgeAsset> {
    // Existing V10 metadata can use either token-row + partOf membership or
    // the collapsed UAL-subject rootEntity form. This path is read-only.
    const metaResult = await this.store.query(
      `SELECT ?ka ?rootEntity ?ctxGraph ?sgName WHERE {
        GRAPH ?g {
          {
            ?ka <http://dkg.io/ontology/rootEntity> ?rootEntity .
            ?ka <http://dkg.io/ontology/partOf> <${ual}> .
          }
          UNION
          {
            <${ual}> <http://dkg.io/ontology/rootEntity> ?rootEntity .
            BIND(<${ual}> AS ?ka)
          }
          <${ual}> <http://dkg.io/ontology/contextGraph> ?ctxGraph .
          OPTIONAL { <${ual}> <http://dkg.io/ontology/subGraphName> ?sgName }
          BIND(CONCAT(STR(?ctxGraph), "/_meta") AS ?expectedMetaGraph)
          FILTER(STR(?g) = ?expectedMetaGraph)
        }
      } ORDER BY ?ka`,
    );

    if (metaResult.type !== 'bindings' || metaResult.bindings.length === 0) {
      throw new Error(`KA not found for UAL: ${ual}`);
    }

    const rootEntities = [
      ...new Set(
        metaResult.bindings
          .map((row) => row['rootEntity'])
          .filter((root): root is string => typeof root === 'string' && root.length > 0),
      ),
    ];
    if (rootEntities.length === 0) {
      throw new Error(`KA not found for UAL: ${ual}`);
    }
    const rootEntity = rootEntities[0] as string;
    const contextGraphUris = [
      ...new Set(
        metaResult.bindings
          .map((row) => row['ctxGraph'])
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    ];
    if (contextGraphUris.length !== 1) {
      throw new Error(`Legacy KA ${ual} has ambiguous contextGraph metadata`);
    }
    const contextGraphPrefix = 'did:dkg:context-graph:';
    const contextGraphUri = contextGraphUris[0] as string;
    if (!contextGraphUri.startsWith(contextGraphPrefix)) {
      throw new Error(`Legacy KA ${ual} has invalid contextGraph metadata`);
    }
    const contextGraphId = contextGraphUri.slice(contextGraphPrefix.length);
    const sgNameRaw = metaResult.bindings[0]?.['sgName'];
    const subGraphName = sgNameRaw ? sgNameRaw.replace(/^"(.*)".*$/, '$1') : undefined;

    const dataGraph = subGraphName
      ? contextGraphSubGraphUri(contextGraphId, subGraphName)
      : contextGraphDataUri(contextGraphId);

    const rootFilter = rootEntities
      .map(
        (root) =>
          `(?s = <${assertSafeIri(root)}> || STRSTARTS(STR(?s), "${escapeSparqlLiteral(root)}/.well-known/genid/"))`,
      )
      .join(' || ');

    const dataResult = await this.store.query(
      `SELECT ?s ?p ?o WHERE {
        GRAPH <${assertSafeIri(dataGraph)}> {
          ?s ?p ?o .
          FILTER(${rootFilter})
        }
      }`,
    );

    const quads: Quad[] =
      dataResult.type === 'bindings'
        ? dataResult.bindings.map((row) => ({
            subject: row['s'],
            predicate: row['p'],
            object: row['o'],
            graph: dataGraph,
          }))
        : [];

    return {
      ual,
      contentScopeVersion: 1,
      rootEntity,
      rootEntities,
      contextGraphId,
      quads,
    };
  }
  /**
   * Execute a query across all locally-stored context graphs.
   */
  async queryAllContextGraphs(sparql: string): Promise<QueryResult> {
    const contextGraphIds = await this.graphManager.listContextGraphs();
    const allBindings: Array<Record<string, string>> = [];

    for (const contextGraphId of contextGraphIds) {
      const result = await this.query(sparql, { contextGraphId });
      allBindings.push(...result.bindings);
    }

    return { bindings: allBindings };
  }

}

function isScopedContentGraph(
  graph: string,
  contextGraphId: string,
  registeredSubGraphs: Set<string>,
  registeredAssertionGraphs: Set<string>,
  knownChildContextGraphs: Set<string>,
  subGraphName?: string,
): boolean {
  const root = contextGraphDataUri(contextGraphId);
  if (graph === root) return !subGraphName;
  if (!graph.startsWith(`${root}/`)) return false;
  if (isKnownChildContextGraphPartition(graph, knownChildContextGraphs)) return false;

  const tail = graph.slice(root.length + 1);
  if (
    !tail ||
    isMetadataGraphTail(tail) ||
    isPrivateGraphTail(tail) ||
    isRulesGraphTail(tail) ||
    isStagingGraphTail(tail)
  ) {
    return false;
  }

  if (!subGraphName) {
    if (tail.startsWith('_shared_memory/')) return true;
    if (tail.startsWith('_verifiable_memory/')) return !isMetadataGraphTail(tail);
    if (tail.startsWith('_working_memory/')) return isRegisteredAssertionGraphOrScopedChild(graph, registeredAssertionGraphs);
  }

  const slash = tail.indexOf('/');
  const firstSegment = slash >= 0 ? tail.slice(0, slash) : tail;
  const remaining = slash >= 0 ? tail.slice(slash + 1) : '';
  if (subGraphName && firstSegment !== subGraphName) return false;
  if (!registeredSubGraphs.has(firstSegment) || !validateSubGraphName(firstSegment).valid) {
    return false;
  }

  if (!remaining) return true;
  if (remaining.startsWith('_shared_memory/')) return true;
  if (remaining.startsWith('_verifiable_memory/')) return !isMetadataGraphTail(remaining);
  if (remaining.startsWith('_working_memory/')) return isRegisteredAssertionGraphOrScopedChild(graph, registeredAssertionGraphs);
  return false;
}

function isRegisteredAssertionGraphOrScopedChild(
  graph: string,
  registeredAssertionGraphs: Set<string>,
): boolean {
  if (registeredAssertionGraphs.has(graph)) return true;
  for (const registeredGraph of registeredAssertionGraphs) {
    if (isAssertionScopedChildGraph(graph, registeredGraph)) {
      return true;
    }
  }
  return false;
}

function isMetadataGraphTail(tail: string): boolean {
  return (
    tail === '_meta' ||
    tail === '_shared_memory_meta' ||
    tail.endsWith('/_meta') ||
    tail.endsWith('/_shared_memory_meta') ||
    tail.includes('/_meta/') ||
    tail.includes('/_shared_memory_meta/')
  );
}

function isPrivateGraphTail(tail: string): boolean {
  return tail === '_private' || tail.startsWith('_private/') || tail.endsWith('/_private') || tail.includes('/_private/');
}

function isRulesGraphTail(tail: string): boolean {
  return tail === '_rules' || tail.startsWith('_rules/') || tail.endsWith('/_rules') || tail.includes('/_rules/');
}

function isKnownChildContextGraphPartition(graph: string, knownChildContextGraphs: Set<string>): boolean {
  for (const childContextGraph of knownChildContextGraphs) {
    if (graph === childContextGraph || graph.startsWith(`${childContextGraph}/`)) {
      return true;
    }
  }
  return false;
}

function isStagingGraphTail(tail: string): boolean {
  return tail.startsWith('_verifiable_memory/staging/') || tail.includes('/_verifiable_memory/staging/');
}

function stripSparqlLiteralValue(value: string | undefined): string {
  if (!value) return '';
  return value.replace(/^"/, '').replace(/"(?:\^\^<[^>]+>|@[a-zA-Z-]+)?$/, '');
}

function assertNoCallerDatasetClauses(sparql: string): void {
  if (hasCallerDatasetClause(sparql)) {
    throw new ScopedQueryViolationError(
      'FROM clauses are not allowed on scoped local queries',
    );
  }
}

async function listGraphsByPrefix(store: TripleStore, prefix: string): Promise<string[]> {
  return store.listGraphsByPrefix
    ? store.listGraphsByPrefix(prefix)
    : (await store.listGraphs()).filter((graph) => graph.startsWith(prefix));
}

async function listGraphFamily(store: TripleStore, rootGraph: string): Promise<string[]> {
  const graphs = await listGraphsByPrefix(store, `${rootGraph}/`);
  if (await store.hasGraph(rootGraph)) {
    graphs.unshift(rootGraph);
  }
  return graphs;
}

function hasCallerDatasetClause(sparql: string): boolean {
  const n = sparql.length;
  let i = 0;

  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      const end = skipSparqlIriRef(sparql, i);
      i = end ?? i + 1;
      continue;
    }
    if (isKeywordStart(sparql, i)) {
      let j = i + 1;
      while (j < n && isWordContinuation(sparql[j])) j++;
      if (isSparqlKeyword(sparql, i, j, 'FROM')) {
        return true;
      }
      i = j;
      continue;
    }
    i++;
  }

  return false;
}

function assertExplicitGraphIrisAllowed(sparql: string, allowedGraphs: string[]): void {
  const allowed = new Set(allowedGraphs);
  for (const graphIri of collectExplicitGraphIris(sparql)) {
    if (!allowed.has(graphIri)) {
      throw new ScopedQueryViolationError(
        `GRAPH <${graphIri}> is outside the allowed graph set`,
      );
    }
  }
}

function collectPrefixDeclarations(sparql: string): Map<string, string> {
  const prefixes = new Map<string, string>();
  const n = sparql.length;
  let i = 0;

  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      const end = skipSparqlIriRef(sparql, i);
      i = end ?? i + 1;
      continue;
    }
    if (isKeywordStart(sparql, i)) {
      let j = i + 1;
      while (j < n && isWordContinuation(sparql[j])) j++;
      if (isSparqlKeyword(sparql, i, j, 'PREFIX')) {
        const prefixStart = skipSparqlSpaceAndLineComments(sparql, j);
        const prefix = readSparqlPrefixName(sparql, prefixStart);
        if (!prefix || prefix.local.length > 0) {
          i = j;
          continue;
        }
        const iriStart = skipSparqlSpaceAndLineComments(sparql, prefixStart + prefix.length);
        const iriEnd = skipSparqlIriRef(sparql, iriStart);
        if (iriEnd) {
          prefixes.set(prefix.prefix, sparql.slice(iriStart + 1, iriEnd - 1));
          i = iriEnd;
          continue;
        }
      }
      i = j;
      continue;
    }
    i++;
  }

  return prefixes;
}

interface SparqlPrefixName {
  prefix: string;
  local: string;
  length: number;
}

function readSparqlPrefixName(sparql: string, start: number): SparqlPrefixName | null {
  let colon = start;
  while (colon < sparql.length && isSparqlPrefixLabelChar(sparql[colon])) colon++;
  if (sparql[colon] !== ':') return null;

  let end = colon + 1;
  while (end < sparql.length && isSparqlPrefixedLocalChar(sparql[end])) end++;

  return {
    prefix: sparql.slice(start, colon),
    local: sparql.slice(colon + 1, end),
    length: end - start,
  };
}

function isSparqlPrefixLabelChar(ch: string | undefined): ch is string {
  return !!ch && (
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= 'a' && ch <= 'z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '_' ||
    ch === '-'
  );
}

function isSparqlPrefixedLocalChar(ch: string | undefined): ch is string {
  return !!ch && !/\s/.test(ch) && ch !== '{' && ch !== '}' && ch !== '(' && ch !== ')' && ch !== ';' && ch !== ',';
}

function resolveSparqlPrefixedName(
  prefixedName: SparqlPrefixName,
  prefixes: Map<string, string>,
): string | null {
  const base = prefixes.get(prefixedName.prefix);
  if (base === undefined) return null;
  return `${base}${prefixedName.local}`;
}

interface GraphTarget {
  kind: 'variable' | 'iri';
  iri?: string;
  end: number;
}

function readGraphTarget(
  sparql: string,
  start: number,
  prefixes: Map<string, string>,
): GraphTarget | null {
  const variable = readSparqlVariable(sparql, start);
  if (variable) {
    return { kind: 'variable', end: start + variable.length };
  }

  if (sparql[start] === '<') {
    const iriEnd = skipSparqlIriRef(sparql, start);
    if (!iriEnd) {
      throw new ScopedQueryViolationError(
        'GRAPH target must be a variable, explicit IRI, or resolvable prefixed name on scoped queries',
      );
    }
    return {
      kind: 'iri',
      iri: sparql.slice(start + 1, iriEnd - 1),
      end: iriEnd,
    };
  }

  const prefixedName = readSparqlPrefixName(sparql, start);
  if (prefixedName) {
    const iri = resolveSparqlPrefixedName(prefixedName, prefixes);
    if (!iri) {
      throw new ScopedQueryViolationError(
        `GRAPH prefixed target ${sparql.slice(start, start + prefixedName.length)} cannot be resolved from PREFIX declarations`,
      );
    }
    return {
      kind: 'iri',
      iri,
      end: start + prefixedName.length,
    };
  }

  return null;
}

function constrainGraphVariablesToAllowedSet(sparql: string, allowedGraphs: string[]): string {
  if (hasNestedSelectWithGraphVariable(sparql)) {
    throw new ScopedQueryViolationError(
      'GRAPH variables inside nested SELECT subqueries cannot be constrained safely',
    );
  }

  const graphVariables = collectGraphVariables(sparql);
  if (graphVariables.length === 0) return sparql;

  const braceStart = findWhereBraceStart(sparql);
  if (braceStart === -1) {
    throw new ScopedQueryViolationError(
      'GRAPH variables cannot be constrained because the WHERE block could not be located',
    );
  }
  assertGraphVariablesAreTopLevel(sparql, braceStart);
  assertNoTopLevelDefaultGraphPatternsWithGraphVariables(sparql, braceStart);

  const values = allowedGraphs
    .map((g) => `<${assertSafeIri(g)}>`)
    .join(' ');
  const constraints = graphVariables
    .map((variable) => `VALUES ${variable} { ${values} }`)
    .join(' ');

  return `${sparql.slice(0, braceStart + 1)} ${constraints} ${sparql.slice(braceStart + 1)}`;
}

function assertNoTopLevelDefaultGraphPatternsWithGraphVariables(sparql: string, braceStart: number): void {
  if (!hasTopLevelDefaultGraphPattern(sparql, braceStart)) return;

  throw new ScopedQueryViolationError(
    'GRAPH variables cannot be mixed with default-graph triple patterns on scoped local queries',
  );
}

function hasTopLevelDefaultGraphPattern(sparql: string, braceStart: number): boolean {
  const braceEnd = findMatchingCloseBrace(sparql, braceStart);
  if (braceEnd === -1) return true;

  const prefixes = collectPrefixDeclarations(sparql);
  let depth = 0;
  let i = braceStart + 1;

  while (i < braceEnd) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < braceEnd && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '{') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth !== 0 || /\s/.test(ch) || ch === '.' || ch === ';' || ch === ',') {
      i++;
      continue;
    }
    if (ch === '<') return !!skipSparqlIriRef(sparql, i);
    if (ch === '?' || ch === '$' || ch === '[') return true;
    if (isKeywordStart(sparql, i)) {
      let j = i + 1;
      while (j < braceEnd && isWordContinuation(sparql[j])) j++;
      if (isSparqlKeyword(sparql, i, j, 'GRAPH')) {
        const operandStart = skipSparqlSpaceAndLineComments(sparql, j);
        const target = readGraphTarget(sparql, operandStart, prefixes);
        i = target && target.end <= braceEnd ? target.end : j;
        continue;
      }
      if (isSparqlKeyword(sparql, i, j, 'FILTER') || isSparqlKeyword(sparql, i, j, 'BIND')) {
        const exprStart = skipSparqlSpaceAndLineComments(sparql, j);
        if (sparql[exprStart] === '(') {
          const exprEnd = skipBalancedParentheses(sparql, exprStart, braceEnd);
          i = exprEnd ?? j;
          continue;
        }
      }
      if (isSparqlKeyword(sparql, i, j, 'VALUES')) {
        i = skipValuesClause(sparql, j, braceEnd);
        continue;
      }
      if (
        isSparqlKeyword(sparql, i, j, 'OPTIONAL') ||
        isSparqlKeyword(sparql, i, j, 'MINUS') ||
        isSparqlKeyword(sparql, i, j, 'SERVICE') ||
        isSparqlKeyword(sparql, i, j, 'UNION') ||
        isSparqlKeyword(sparql, i, j, 'SELECT')
      ) {
        i = j;
        continue;
      }
      return true;
    }
    i++;
  }

  return false;
}

function assertGraphVariablesAreTopLevel(sparql: string, braceStart: number): void {
  const braceEnd = findMatchingCloseBrace(sparql, braceStart);
  if (braceEnd === -1) {
    throw new ScopedQueryViolationError(
      'GRAPH variables cannot be constrained because the WHERE block could not be located',
    );
  }

  let depth = 0;
  let i = braceStart + 1;

  while (i < braceEnd) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < braceEnd && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      const iriEnd = skipSparqlIriRef(sparql, i);
      i = iriEnd && iriEnd <= braceEnd ? iriEnd : i + 1;
      continue;
    }
    if (ch === '{') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (isKeywordStart(sparql, i)) {
      let j = i + 1;
      while (j < braceEnd && isWordContinuation(sparql[j])) j++;
      if (isSparqlKeyword(sparql, i, j, 'GRAPH')) {
        const operandStart = skipSparqlSpaceAndLineComments(sparql, j);
        if (operandStart < braceEnd && readSparqlVariable(sparql, operandStart) && depth !== 0) {
          throw new ScopedQueryViolationError(
            'GRAPH variables must appear at the top level of scoped local queries',
          );
        }
      }
      i = j;
      continue;
    }
    i++;
  }
}

function hasNestedSelectWithGraphVariable(sparql: string): boolean {
  const n = sparql.length;
  let i = 0;
  let braceDepth = 0;

  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      const end = skipSparqlIriRef(sparql, i);
      i = end ?? i + 1;
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      i++;
      continue;
    }
    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      i++;
      continue;
    }
    if (isKeywordStart(sparql, i)) {
      let j = i + 1;
      while (j < n && isWordContinuation(sparql[j])) j++;
      const word = sparql.slice(i, j);
      if (isSparqlKeyword(sparql, i, j, 'SELECT') && braceDepth > 0) {
        const end = findNestedSelectEnd(sparql, j, braceDepth);
        if (rangeContainsGraphVariable(sparql, j, end === -1 ? n : end)) {
          return true;
        }
        i = end === -1 ? j : end + 1;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }

  return false;
}

function findNestedSelectEnd(sparql: string, start: number, startingDepth: number): number {
  const n = sparql.length;
  let depth = startingDepth;
  let i = start;

  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      const end = skipSparqlIriRef(sparql, i);
      i = end ?? i + 1;
      continue;
    }
    if (ch === '{') {
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth < startingDepth) return i;
      if (depth < 0) return -1;
      i++;
      continue;
    }
    i++;
  }

  return -1;
}

function rangeContainsGraphVariable(sparql: string, start: number, end: number): boolean {
  const n = Math.min(sparql.length, end);
  let i = start;

  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      const iriEnd = skipSparqlIriRef(sparql, i);
      i = iriEnd && iriEnd <= n ? iriEnd : i + 1;
      continue;
    }
    if (isKeywordStart(sparql, i)) {
      let j = i + 1;
      while (j < n && isWordContinuation(sparql[j])) j++;
      const word = sparql.slice(i, j);
      if (isSparqlKeyword(sparql, i, j, 'GRAPH')) {
        const operandStart = skipSparqlSpaceAndLineComments(sparql, j);
        if (operandStart < n && readSparqlVariable(sparql, operandStart)) {
          return true;
        }
      }
      i = j;
      continue;
    }
    i++;
  }

  return false;
}

function collectExplicitGraphIris(sparql: string): string[] {
  const iris: string[] = [];
  const prefixes = collectPrefixDeclarations(sparql);
  const n = sparql.length;
  let i = 0;

  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      const end = skipSparqlIriRef(sparql, i);
      i = end ?? i + 1;
      continue;
    }
    if (isKeywordStart(sparql, i)) {
      let j = i + 1;
      while (j < n && isWordContinuation(sparql[j])) j++;
      if (isSparqlKeyword(sparql, i, j, 'GRAPH')) {
        const operandStart = skipSparqlSpaceAndLineComments(sparql, j);
        const target = readGraphTarget(sparql, operandStart, prefixes);
        if (!target) {
          throw new ScopedQueryViolationError(
            'GRAPH target must be a variable, explicit IRI, or resolvable prefixed name on scoped queries',
          );
        }
        if (target.kind === 'iri' && target.iri) iris.push(target.iri);
        i = target.end;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }

  return iris;
}

function hasGraphClause(sparql: string): boolean {
  const n = sparql.length;
  let i = 0;

  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      const end = skipSparqlIriRef(sparql, i);
      i = end ?? i + 1;
      continue;
    }
    if (isKeywordStart(sparql, i)) {
      let j = i + 1;
      while (j < n && isWordContinuation(sparql[j])) j++;
      if (isSparqlKeyword(sparql, i, j, 'GRAPH')) {
        return true;
      }
      i = j;
      continue;
    }
    i++;
  }

  return false;
}

function collectGraphVariables(sparql: string): string[] {
  const variables: string[] = [];
  const seen = new Set<string>();
  const n = sparql.length;
  let i = 0;

  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      const end = skipSparqlIriRef(sparql, i);
      i = end ?? i + 1;
      continue;
    }
    if (isKeywordStart(sparql, i)) {
      let j = i + 1;
      while (j < n && isWordContinuation(sparql[j])) j++;
      const word = sparql.slice(i, j);
      if (isSparqlKeyword(sparql, i, j, 'GRAPH')) {
        const operandStart = skipSparqlSpaceAndLineComments(sparql, j);
        const variable = readSparqlVariable(sparql, operandStart);
        if (variable && !seen.has(variable)) {
          seen.add(variable);
          variables.push(variable);
        }
        i = operandStart + (variable?.length ?? 0);
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }

  return variables;
}

function skipSparqlIriRef(sparql: string, start: number): number | null {
  if (sparql[start] !== '<') return null;
  const next = sparql[start + 1];
  if (!isLikelyIriRefStart(next)) return null;

  for (let i = start + 1; i < sparql.length; i++) {
    const ch = sparql[i];
    if (ch === '>') return i + 1;
    if (
      ch === '<' ||
      ch === '"' ||
      ch === '{' ||
      ch === '}' ||
      ch === '|' ||
      ch === '\\' ||
      ch === '^' ||
      ch === '`' ||
      /\s/.test(ch)
    ) {
      return null;
    }
  }

  return null;
}

function isLikelyIriRefStart(ch: string | undefined): boolean {
  return !!ch && (
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= 'a' && ch <= 'z') ||
    ch === '#' ||
    ch === '_' ||
    ch === '/' ||
    ch === '.'
  );
}

function readSparqlVariable(sparql: string, start: number): string | null {
  const sigil = sparql[start];
  if (sigil !== '?' && sigil !== '$') return null;
  let end = start + 1;
  const first = readCodePoint(sparql, end);
  if (!first || !isSparqlVariableInitialCodePoint(first.codePoint)) return null;
  end += first.width;

  while (end < sparql.length) {
    const next = readCodePoint(sparql, end);
    if (!next || !isSparqlVariableContinuationCodePoint(next.codePoint)) break;
    end += next.width;
  }

  return end > start + 1 ? sparql.slice(start, end) : null;
}

function readCodePoint(src: string, index: number): { codePoint: number; width: number } | null {
  if (index >= src.length) return null;
  const codePoint = src.codePointAt(index);
  if (codePoint === undefined) return null;
  return { codePoint, width: codePoint > 0xffff ? 2 : 1 };
}

function isSparqlVariableInitialCodePoint(codePoint: number): boolean {
  return isSparqlPnCharsUCodePoint(codePoint) || isAsciiDigitCodePoint(codePoint);
}

function isSparqlVariableContinuationCodePoint(codePoint: number): boolean {
  return (
    isSparqlPnCharsUCodePoint(codePoint) ||
    isAsciiDigitCodePoint(codePoint) ||
    codePoint === 0x00b7 ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x203f && codePoint <= 0x2040)
  );
}

function isSparqlPnCharsUCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x5f ||
    isAsciiAlphaCodePoint(codePoint) ||
    (codePoint >= 0x00c0 && codePoint <= 0x00d6) ||
    (codePoint >= 0x00d8 && codePoint <= 0x00f6) ||
    (codePoint >= 0x00f8 && codePoint <= 0x02ff) ||
    (codePoint >= 0x0370 && codePoint <= 0x037d) ||
    (codePoint >= 0x037f && codePoint <= 0x1fff) ||
    (codePoint >= 0x200c && codePoint <= 0x200d) ||
    (codePoint >= 0x2070 && codePoint <= 0x218f) ||
    (codePoint >= 0x2c00 && codePoint <= 0x2fef) ||
    (codePoint >= 0x3001 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xf900 && codePoint <= 0xfdcf) ||
    (codePoint >= 0xfdf0 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0xeffff)
  );
}

function isAsciiAlphaCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a)
  );
}

function isAsciiDigitCodePoint(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x39;
}

function skipSparqlSpaceAndLineComments(sparql: string, start: number): number {
  let i = start;
  while (i < sparql.length) {
    if (/\s/.test(sparql[i])) {
      i++;
      continue;
    }
    if (sparql[i] === '#') {
      while (i < sparql.length && sparql[i] !== '\n') i++;
      continue;
    }
    break;
  }
  return i;
}

function skipBalancedParentheses(sparql: string, start: number, limit = sparql.length): number | null {
  if (sparql[start] !== '(') return null;
  let depth = 1;
  let i = start + 1;

  while (i < limit) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < limit && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      const iriEnd = skipSparqlIriRef(sparql, i);
      i = iriEnd && iriEnd <= limit ? iriEnd : i + 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }

  return null;
}

function skipValuesClause(sparql: string, start: number, limit: number): number {
  let i = start;
  while (i < limit) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < limit && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '{') {
      const end = findMatchingCloseBrace(sparql, i);
      return end === -1 || end > limit ? i : end + 1;
    }
    if (ch === '.') return i + 1;
    i++;
  }
  return i;
}

function isKeywordStart(src: string, idx: number): boolean {
  const ch = src[idx];
  if (!isWordStart(ch)) return false;
  const prev = idx > 0 ? src[idx - 1] : '';
  return !prev || (!isWordContinuation(prev) && prev !== '?' && prev !== '$' && prev !== ':' && prev !== '#');
}

function isSparqlKeyword(src: string, start: number, end: number, keyword: string): boolean {
  const next = src[end];
  return src.slice(start, end).toUpperCase() === keyword
    && next !== ':'
    && next !== '-'
    && next !== '.';
}

function isWordStart(ch: string | undefined): ch is string {
  return !!ch && (
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= 'a' && ch <= 'z') ||
    ch === '_'
  );
}

function isWordContinuation(ch: string | undefined): ch is string {
  return isWordStart(ch) || isAsciiDigitChar(ch);
}

function isAsciiDigitChar(ch: string | undefined): ch is string {
  return !!ch && ch >= '0' && ch <= '9';
}

/**
 * Skip past a SPARQL string literal starting at `src[i]`, returning the
 * index immediately AFTER the closing quote.
 *
 * Recognises **all four** SPARQL 1.1 literal forms:
 *
 *   - `"…"`         single-line, double-quoted (escape: `\\`, `\"`, `\n`, …)
 *   - `'…'`         single-line, single-quoted (same escape grammar)
 *   - `"""…"""`     long-form, double-quoted (may span newlines, contains
 *                   raw `"`, `'`, `{`, `}`, `#`, `.` without escaping)
 *   - `'''…'''`     long-form, single-quoted (same as above)
 *
 * **Caller contract:** `src[i]` MUST be `"` or `'`; otherwise the function
 * returns `i` (no advance). The cursor returned points to the first byte
 * AFTER the literal, ready for the caller to resume its own scan.
 *
 * If a literal is unterminated (truncated input) the function consumes
 * the remainder of the string and returns `src.length`. Callers treat
 * unterminated literals as "the rest of the input is opaque payload",
 * which is the safe choice for structural scans (brace balancing,
 * keyword detection): we do NOT want a stray `{` near the end of a
 * truncated query body to confuse the surrounding scanner.
 *
 * dkg-query-engine.ts:848). The
 * previous helpers (`stripSparqlLineComments`, `scrubStringsAndComments`,
 * `findMatchingCloseBrace`, `findWhereBraceStart`, and
 * `splitTopLevelTripleStatements`) all had their own copy of the
 * single-line literal scanner and NONE recognised triple-quoted
 * literals, so a long-form payload like
 *
 *     SELECT ?t WHERE { ?s <p> """contains a {brace} and a #comment""" }
 *
 * leaked `{`, `}`, `#`, `.`, etc. through the structural scrubber and
 * the `minTrust` rewriter (and the SPARQL form classifier, and the
 * triple terminator splitter) misclassified payload as syntax. The
 * downstream effect was the same fail-closed empty result the
 * scrubbing was supposed to prevent. Centralising the lex here means
 * every helper that walks SPARQL source learns triple-quoted handling
 * in one place.
 */
export function skipSparqlStringLiteral(src: string, i: number): number {
  const n = src.length;
  if (i >= n) return i;
  const ch = src[i];
  if (ch !== '"' && ch !== "'") return i;
  // Long-form (triple-quoted) literal? Lookahead must match `ch ch ch`.
  if (i + 2 < n && src[i + 1] === ch && src[i + 2] === ch) {
    let j = i + 3;
    while (j < n) {
      // SPARQL 1.1 long-string grammar (§19.8 STRING_LITERAL_LONG*) allows
      // `\<x>` style ECHAR escapes — skip the escaped byte so a `\\"` or
      // a `\\'` does not prematurely terminate. Between escapes, look for
      // the triple-quote terminator.
      if (src[j] === '\\' && j + 1 < n) { j += 2; continue; }
      if (
        src[j] === ch &&
        j + 2 < n &&
        src[j + 1] === ch &&
        src[j + 2] === ch
      ) {
        return j + 3;
      }
      j++;
    }
    return n;
  }
  // Short-form (single-line) literal. SPARQL 1.1 STRING_LITERAL1/2 forbid
  // unescaped newlines, but we still defensively bail on EOL just like
  // the previous helpers did.
  let j = i + 1;
  while (j < n) {
    if (src[j] === '\\' && j + 1 < n) { j += 2; continue; }
    if (src[j] === ch) { return j + 1; }
    j++;
  }
  return j;
}

/**
 * Token-aware locator for the explicit `WHERE` keyword at the
 * top-level of a SPARQL query. Mirrors the lex rules used by
 * {@link findMatchingCloseBrace} / the fallback path in
 * {@link findWhereBraceStart}: skips line comments (`# ... \n`),
 * single/double/triple-quoted string literals (via
 * {@link skipSparqlStringLiteral}), and IRIREFs (`<...>`) so the
 * `WHERE` substring can NOT be sourced from inside any of those
 * payload contexts. The `<` token is disambiguated as IRI-start
 * vs less-than via the same next-byte allow-list as
 * {@link findWhereBraceStart}'s fallback.
 *
 * Returns the index of the `W` of the `WHERE` keyword, or `-1` if
 * none is found at top level. Case-insensitive on the keyword
 * itself, but the surrounding word boundary is enforced (so
 * identifiers like `WHEREVER` / `aWHERE` do NOT match).
 */
function findExplicitWhereTokenIdx(sparql: string): number {
  const n = sparql.length;
  const isWordStart = (c: string): boolean =>
    (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_';
  const isWordCont = (c: string): boolean =>
    (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
    (c >= '0' && c <= '9') || c === '_';
  const isIriStartFirstByte = (c: string): boolean => {
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) return true;
    return c === '#' || c === '_' || c === '/' || c === '.';
  };
  const isIriStart = (idx: number): boolean => {
    const next = sparql[idx + 1];
    if (next === undefined) return false;
    if (!isIriStartFirstByte(next)) return false;
    for (let j = idx + 1; j < n; j++) {
      const c = sparql[j];
      if (c === '>') return true;
      if (
        c === '<' || c === '"' || c === '{' || c === '}' ||
        c === '|' || c === '\\' || c === '^' || c === '`' ||
        /\s/.test(c)
      ) return false;
    }
    return false;
  };

  let i = 0;
  let braceDepth = 0;
  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      if (isIriStart(i)) {
        const end = sparql.indexOf('>', i + 1);
        if (end === -1) return -1;
        i = end + 1;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      i++;
      continue;
    }
    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      i++;
      continue;
    }
    if (isWordStart(ch)) {
      // Word boundary check: previous char (if any) must NOT be a
      // word-continuation byte. The outer lexer already skipped
      // comments/strings/IRIs, so a non-word predecessor means we're
      // at a real keyword start.
      const prev = i > 0 ? sparql[i - 1] : '';
      if (prev && isWordCont(prev)) {
        // Mid-identifier — skip the rest of the word.
        let j = i + 1;
        while (j < n && isWordCont(sparql[j])) j++;
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < n && isWordCont(sparql[j])) j++;
      const word = sparql.substring(i, j);
      if (braceDepth === 0 && word.length === 5 && word.toUpperCase() === 'WHERE') {
        return i;
      }
      i = j;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Find the next significant `{` after a given index, skipping
 * whitespace AND line comments (`# … \n`) but NOT string literals
 * — SPARQL grammar does not allow a string literal between the
 * `WHERE` keyword and its opening `{`, so encountering one means
 * the input is malformed and we should bail (return `-1`).
 */
function nextSignificantBraceAfter(sparql: string, startIdx: number): number {
  const n = sparql.length;
  let i = startIdx;
  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '{') return i;
    return -1;
  }
  return -1;
}

/**
 * Locate the opening `{` of the WHERE clause in a SPARQL query.
 *
 * SPARQL 1.1 (§16) allows the `WHERE` keyword to be omitted from
 * `SELECT`, `DESCRIBE`, and `ASK` queries, and from the second
 * `GroupGraphPattern` of a `CONSTRUCT`. The legacy callers (`wrapWithGraph`,
 * `wrapWithGraphUnion`, `injectMinTrustFilter`) all matched only
 * `WHERE\s*\{`, so any of those legitimate shorthand forms left the
 * query untouched (no GRAPH wrapping, no trust filter injection) and —
 * on a `verifiable-memory` view whose data lives in a named sub-graph —
 * silently returned `[]` instead of executing against the right graph.
 *
 * Strategy:
 *   1. Prefer the explicit `WHERE { ... }` form.
 *   2. Otherwise, walk top-level braces (skipping IRIs / quoted
 *      strings / comments) and use the LAST top-level `{...}`. This
 *      is correct for every form:
 *        - `SELECT ?x { ... }`           (1 top-level brace)
 *        - `ASK { ... }`                 (1)
 *        - `DESCRIBE ?x { ... }`         (1)
 *        - `CONSTRUCT { tmpl } { where }`(2 — last is the WHERE)
 *      `CONSTRUCT WHERE { ... }` already matches the primary path.
 *
 * Returns `null` when no top-level `{...}` block is balanced.
 */
function findWhereBraceStart(sparql: string): number {
  // The earlier fast path used a raw regex `/\bWHERE\s*\{/i` which
  // matches ANY `WHERE` followed by `{` — including ones embedded inside
  // string literals or comments. Adversarial / obfuscated input
  // like
  //   SELECT ("WHERE {" AS ?x) WHERE { ... }
  // would have the regex hit the literal substring inside the
  // SELECT projection, then `sparql.indexOf('{', whereIdx)` would
  // grab the brace just past the literal — and every later
  // injection (`wrapWithGraph` / `injectMinTrustFilter`) would
  // rewrite the wrong block, in some cases producing an invalid
  // query and in others silently filtering against a string-literal
  // expression rather than the actual WHERE clause.
  //
  // Fix: locate the explicit `WHERE` token using the SAME token-
  // aware scanner the fallback already uses (skips line comments,
  // single/double/triple-quoted string literals, and IRIREFs;
  // disambiguates `<` as IRI-start vs less-than via the next-byte
  // allow-list below). Then advance past inter-keyword whitespace
  // (and any line comments) before reading the `{`.
  const whereTokenIdx = findExplicitWhereTokenIdx(sparql);
  if (whereTokenIdx !== -1) {
    const idx = nextSignificantBraceAfter(sparql, whereTokenIdx + 'WHERE'.length);
    return idx;
  }

  // Fallback: scan for top-level `{` while honouring SPARQL token
  // boundaries — IRIs (`<...>`), quoted literals, and `#` comments
  // can all contain stray `{` chars that the regex would
  // misinterpret as block openers.
  //
  // dkg-query-engine.ts:559). The classifier rejects obvious
  // comparison shapes after `<` and falls back to a forward scan
  // that confirms a balanced IRIREF body. The r30 cut only rejected
  // `=`, `<`, and whitespace — a pure forward scan from `<` in
  // compact comparison syntax like
  //   `FILTER(?n<10&&?m>5)`
  // walks `1`, `0`, `&`, `&`, `?`, `m` (none of which are
  // IRIREF-forbidden per the SPARQL grammar
  // `[^<>"{}|^`\]-[#x00-#x20]`) and lands on `>`, mis-classifying
  // the entire `<10&&?m>` as an IRI. The forward scan therefore
  // CANNOT be trusted alone for compact `<` operators that operate
  // on numerics / variables / sub-expressions whose body bytes are
  // all IRIREF-legal.
  //
  // r30+ resolution: combine an EXPLICIT next-byte allow-list of
  // characters that can validly start a real-world SPARQL IRIREF
  // (ALPHA for absolute IRIs `http:` / `urn:` / `did:` / `file:` /
  // `_blank-node:`, `#` for fragment-only relatives, `_` for the
  // legacy blank-node-as-IRI shape, `/` for path-only relatives,
  // and `.` for path-relative IRIs) with the existing
  // forbidden-byte forward scan. Anything else after `<` is treated
  // as a comparison and we advance by ONE byte. This bails fast on
  // every `<digit`, `<?var`, `<$var`, `<(...)`, `<"lit"`, `<-1`,
  // `<+1`, `<&`, `<|`, `<!`, `<*`, `<=`, `<<` shape — i.e. the
  // full set of SPARQL operator contexts in which `<` is overloaded
  // as less-than.
  //
  // Note: this is INTENTIONALLY stricter than the SPARQL grammar
  // (which technically allows `<10>` as an IRIREF). Real-world
  // SPARQL queries don't write bare-digit IRIs; falling out of the
  // IRI branch here just means we treat `<` as a comparison and
  // advance one byte, which is the safe behaviour for the brace
  // scan we actually care about.
  const isIriStartFirstByte = (c: string): boolean => {
    // ASCII letter? (covers every absolute IRI scheme — `http:`,
    // `urn:`, `did:`, `file:`, `mailto:`, `tag:`, `data:`, …).
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) return true;
    // `#fragment` (SPARQL allows fragment-only relative IRIREFs
    // when the base IRI is set by the query environment), `_blah`
    // (legacy blank-node-as-IRI), `/path` (path-only relative),
    // `.something` (path-relative). Everything else is a comparison
    // operator context.
    return c === '#' || c === '_' || c === '/' || c === '.';
  };
  const isIriStart = (idx: number): boolean => {
    const next = sparql[idx + 1];
    if (next === undefined) return false;
    if (!isIriStartFirstByte(next)) return false;
    for (let j = idx + 1; j < n; j++) {
      const c = sparql[j];
      if (c === '>') return true;
      // Any IRIREF-forbidden character before `>` proves this `<`
      // is a comparison, not the start of an IRI.
      if (
        c === '<' ||
        c === '"' ||
        c === '{' ||
        c === '}' ||
        c === '|' ||
        c === '\\' ||
        c === '^' ||
        c === '`' ||
        /\s/.test(c)
      ) {
        return false;
      }
    }
    return false;
  };

  const n = sparql.length;
  const opens: number[] = [];
  let depth = 0;
  let i = 0;
  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '<') {
      if (isIriStart(i)) {
        const end = sparql.indexOf('>', i + 1);
        if (end === -1) return -1;
        i = end + 1;
        continue;
      }
      // Comparison operator — advance one byte and keep scanning.
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // dkg-query-engine.ts:848).
      // Centralised triple-quoted-aware skip — see skipSparqlStringLiteral.
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '{') {
      if (depth === 0) opens.push(i);
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth < 0) return -1;
    }
    i++;
  }
  if (depth !== 0 || opens.length === 0) return -1;
  return opens[opens.length - 1];
}

/**
 * Locate the matching `}` for the `{` at `openIdx`, while skipping over
 * `{` / `}` chars that appear inside SPARQL string literals, line
 * comments, or IRIREFs.
 *
 * — dkg-query-engine.ts:939). The naive
 * brace-balance loop in `injectMinTrustFilter`, `wrapWithGraph`, and
 * `wrapWithGraphUnion` counted `{`/`}` blindly. A query like
 *
 *     SELECT ?t WHERE { ... FILTER(STR(?t) = "{") }
 *
 * has a literal `{` inside a string literal and a single closing `}`
 * for the WHERE block, so the naive counter ended at depth 1 and
 * returned `-1`. Every caller treated `-1` as "refuse to rewrite" and
 * (for `injectMinTrustFilter`) silently fail-closed `minTrust >
 * Endorsed` queries to an empty result — exactly the literal-heavy
 * shape the surrounding scrubbing was supposed to enable.
 *
 * Returns `-1` if `sparql[openIdx]` is not `{` or no matching close
 * exists at depth zero.
 */
function findMatchingCloseBrace(sparql: string, openIdx: number): number {
  if (sparql[openIdx] !== '{') return -1;
  const n = sparql.length;
  let depth = 0;
  let i = openIdx;
  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      // Line comment — skip to newline.
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // Centralised triple-quoted-aware skip.
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      // Look ahead for a balanced `>` that delimits an IRIREF body.
      // IRIREFs cannot contain whitespace or any of `<{}|"^\``, so a
      // candidate range that contains those chars is treated as a
      // comparison operator and we fall through to a single-byte
      // advance. (Mirror of the IRI/comparison disambiguation in
      // `findWhereBraceStart`.)
      let foundIri = false;
      for (let j = i + 1; j < n; j++) {
        const c = sparql[j];
        if (c === '>') { foundIri = true; i = j + 1; break; }
        if (
          c === '<' || c === '"' || c === '{' || c === '}' ||
          c === '|' || c === '\\' || c === '^' || c === '`' ||
          /\s/.test(c)
        ) {
          break;
        }
      }
      if (foundIri) continue;
      // Comparison operator — advance one byte.
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
    i++;
  }
  return -1;
}

/**
 * Wraps a SELECT query to scope it to a named graph.
 * If the query already uses GRAPH patterns, returns it unchanged.
 */
function wrapWithGraph(sparql: string, graphUri: string): string {
  if (hasGraphClause(sparql)) return sparql;

  const braceStart = findWhereBraceStart(sparql);
  if (braceStart === -1) return sparql;

  // — dkg-query-engine.ts:939). Use the
  // literal/comment/IRI-aware helper so a `{` or `}` inside a SPARQL
  // string literal, line comment, or IRI does NOT confuse the depth
  // counter and we stop wrapping queries with literal-heavy bodies.
  const braceEnd = findMatchingCloseBrace(sparql, braceStart);
  if (braceEnd === -1) return sparql;

  const before = sparql.slice(0, braceStart + 1);
  const inner = sparql.slice(braceStart + 1, braceEnd);
  const after = sparql.slice(braceEnd);

  return `${before} GRAPH <${graphUri}> { ${inner} } ${after}`;
}

/**
 * Wrap a query so it runs over a union of named graphs in a single execution,
 * preserving LIMIT/ORDER BY/DISTINCT/aggregate semantics.
 *
 * the previous revision injected
 * `VALUES ?_viewGraph { <g1> <g2> … } GRAPH ?_viewGraph { inner }` directly
 * into the caller's WHERE block. Two failure modes:
 *
 *   1. Scope leak — `SELECT *` (or any projection that includes the graph
 *      variable) over a multi-graph view emitted an extra `_viewGraph`
 *      column, so downstream consumers saw a mystery binding they didn't
 *      ask for.
 *   2. Name collision — a user query that legitimately binds
 *      `?_viewGraph` (rare but valid) would silently intersect with the
 *      helper's VALUES list and clamp to the helper's graph URIs.
 *
 * The fix is to use an explicit UNION over each graph instead of a
 * single GRAPH ?var binding. That keeps the inner block's variables
 * (and only those) in scope — no helper var is introduced at all, so
 * neither SELECT * leakage nor variable-name collisions can happen.
 * Single-graph views skip the UNION wrapper entirely and use a plain
 * `GRAPH <uri>` block.
 *
 * Returns `null` when the inner WHERE body contains a UNION — the
 * UNION-of-GRAPHs wrapper would produce a nested UnionNode that
 * crashes Blazegraph, and a VALUES+GRAPH fallback leaks a helper
 * variable into the caller's scope.  The caller should fall back to
 * per-graph execution.
 */
function wrapWithGraphUnion(sparql: string, graphUris: string[]): string | null {
  if (hasGraphClause(sparql)) return sparql;
  if (graphUris.length === 0) return sparql;

  const braceStart = findWhereBraceStart(sparql);
  if (braceStart === -1) return sparql;

  // — dkg-query-engine.ts:939). See
  // `findMatchingCloseBrace` and the `wrapWithGraph` cousin above.
  const braceEnd = findMatchingCloseBrace(sparql, braceStart);
  if (braceEnd === -1) return sparql;

  const before = sparql.slice(0, braceStart + 1);
  const inner = sparql.slice(braceStart + 1, braceEnd);
  const after = sparql.slice(braceEnd);

  if (graphUris.length === 1) {
    return `${before} GRAPH <${graphUris[0]}> { ${inner} } ${after}`;
  }

  // Blazegraph crashes with "Illegal child type for union: UnionNode"
  // when a UNION appears inside a GRAPH block that is itself a branch
  // of an outer UNION. We cannot use VALUES+GRAPH either because the
  // helper variable leaks into caller scope (SELECT *, name collisions).
  // Signal the caller to fall back to per-graph execution.
  const innerHasUnion = /\bUNION\b/i.test(inner);
  if (innerHasUnion) {
    return null;
  }

  const unionBranches = graphUris
    .map((g) => `{ GRAPH <${g}> { ${inner} } }`)
    .join(' UNION ');
  return `${before} ${unionBranches} ${after}`;
}

/** The graph variable `wrapWithGraphValues` injects. Double-underscore + a
 *  view-specific name so a user query is astronomically unlikely to bind it;
 *  a collision is nonetheless detected and declined (never silently clamped). */
const VIEW_GRAPH_SENTINEL = '?__dkgViewGraph';
const DEDUP_GRAPH_SENTINEL = '?__dkgDedupGraph';
const DEDUP_RANK_SENTINEL = '?__dkgDedupRank';
const DEDUP_PRIOR_GRAPH_SENTINEL = '?__dkgDedupPriorGraph';
const DEDUP_PRIOR_RANK_SENTINEL = '?__dkgDedupPriorRank';

function wrapWithProjectedGraphSubselect(
  sparql: string,
  graphUris: string[],
  helperVariables: string[],
  buildGraphPattern: (inner: string, graphs: string[]) => string,
  acceptsInner: (inner: string) => boolean = () => true,
): string | null {
  if (hasGraphClause(sparql)) return sparql;
  if (graphUris.length === 0) return sparql;

  const braceStart = findWhereBraceStart(sparql);
  if (braceStart === -1) return null;
  const braceEnd = findMatchingCloseBrace(sparql, braceStart);
  if (braceEnd === -1) return null;

  const before = sparql.slice(0, braceStart + 1);
  const inner = sparql.slice(braceStart + 1, braceEnd);
  const after = sparql.slice(braceEnd);
  const graphs = [...new Set(graphUris)];

  if (graphs.length === 1) {
    return `${before} GRAPH <${assertSafeIri(graphs[0])}> { ${inner} } ${after}`;
  }
  if (/\bUNION\b/i.test(inner) || !acceptsInner(inner)) return null;

  const helperNames = new Set(helperVariables.map((variable) => variable.slice(1)));
  if (collectQueryVariables(sparql).some((variable) => helperNames.has(variable.slice(1)))) {
    return null;
  }

  const innerVars = collectQueryVariables(inner);
  if (innerVars.length === 0) return null;

  const graphPattern = buildGraphPattern(inner, graphs);
  return `${before} { SELECT ${innerVars.join(' ')} WHERE { ${graphPattern} } } ${after}`;
}

/**
 * Run one graph pattern across an ordered graph set while suppressing only a
 * solution mapping already produced by an earlier graph. The comparison uses
 * every variable bound by the caller's inner pattern, before the caller's
 * projection runs. Thus an identical mirrored triple is emitted once, while
 * distinct triples that both project to the same `?s` still produce two rows.
 *
 * Helper graph/rank variables are hidden inside a sub-SELECT, preserving
 * `SELECT *` and caller DISTINCT semantics. Unsupported/colliding query shapes
 * return null so the existing generic multi-graph fallback remains available.
 */
function wrapWithDeduplicatedGraphValues(sparql: string, graphUris: string[]): string | null {
  return wrapWithProjectedGraphSubselect(
    sparql,
    graphUris,
    [
      DEDUP_GRAPH_SENTINEL,
      DEDUP_RANK_SENTINEL,
      DEDUP_PRIOR_GRAPH_SENTINEL,
      DEDUP_PRIOR_RANK_SENTINEL,
    ],
    (inner, graphs) => {
      const rows = graphs
        .map((graph, rank) => `(<${assertSafeIri(graph)}> ${rank})`)
        .join(' ');
      return [
        `VALUES (${DEDUP_GRAPH_SENTINEL} ${DEDUP_RANK_SENTINEL}) { ${rows} }`,
        `GRAPH ${DEDUP_GRAPH_SENTINEL} { ${inner} }`,
        'FILTER NOT EXISTS {',
        `  VALUES (${DEDUP_PRIOR_GRAPH_SENTINEL} ${DEDUP_PRIOR_RANK_SENTINEL}) { ${rows} }`,
        `  FILTER (${DEDUP_PRIOR_RANK_SENTINEL} < ${DEDUP_RANK_SENTINEL})`,
        `  GRAPH ${DEDUP_PRIOR_GRAPH_SENTINEL} { ${inner} }`,
        '}',
      ].join(' ');
    },
    isDedupSafeBasicGraphPattern,
  );
}

/**
 * Wrap a query so it runs over a set of named graphs in ONE execution using a
 * single `VALUES ?g { <g1> … } GRAPH ?g { inner }` block, instead of one
 * `{ GRAPH <g> { inner } } UNION …` branch per graph.
 *
 * Why this exists (issue #1596): the per-graph UNION form (`wrapWithGraphUnion`)
 * emits an N-branch UnionNode. At the ~1,424 SWM graphs of a large public
 * context graph that is a ~257 KB query whose union tree makes the
 * oxigraph-server query planner blow up and reset the connection ("fetch
 * failed"). A single VALUES table is one basic graph pattern iterated over the
 * graph list — constant plan depth — so it scales.
 *
 * Semantics are preserved. LIMIT/ORDER BY/DISTINCT/GROUP BY/aggregate all live
 * in the outer query (the `before`/`after` slices) and reduce over the merged
 * solution set exactly as the UNION form did. The one hazard is the injected
 * graph variable leaking into the caller's projection: a bare `SELECT *` would
 * expose `?__dkgViewGraph` as a mystery column, and cross-graph DISTINCT of an
 * identical triple would split on the graph. Both are neutralised by scoping
 * the VALUES+GRAPH block inside a sub-SELECT that projects ONLY the user's own
 * variables (collected from `inner`), so the sentinel never escapes.
 *
 * Returns `null` (caller falls back to `wrapWithGraphUnion` / per-graph
 * execution) when the WHERE block cannot be located, when `inner` carries a
 * top-level UNION (kept on the #789 form-aware fallback so its behaviour and
 * tests are untouched), when the user query already binds the sentinel, or
 * when the WHERE body binds no user variable at all (a var-less body offers
 * nowhere to hide the sentinel from a `SELECT *` projection).
 */
function wrapWithGraphValues(sparql: string, graphUris: string[]): string | null {
  return wrapWithProjectedGraphSubselect(
    sparql,
    graphUris,
    [VIEW_GRAPH_SENTINEL],
    (inner, graphs) => {
      const values = graphs.map((graph) => `<${assertSafeIri(graph)}>`).join(' ');
      return `VALUES ${VIEW_GRAPH_SENTINEL} { ${values} } GRAPH ${VIEW_GRAPH_SENTINEL} { ${inner} }`;
    },
  );
}

/**
 * The mirror anti-join is valid only for a flat basic graph pattern (plus
 * FILTER expressions). Nested graph patterns can differ by boundness, where a
 * correlated NOT EXISTS compatibility check is not exact mapping equality.
 */
function isDedupSafeBasicGraphPattern(inner: string): boolean {
  const forbidden = ['OPTIONAL', 'MINUS', 'SERVICE', 'VALUES', 'BIND', 'SELECT', 'GRAPH', 'EXISTS'];
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === '#') {
      while (i < inner.length && inner[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(inner, i);
      continue;
    }
    if (ch === '<') {
      const end = skipSparqlIriRef(inner, i);
      i = end ?? i + 1;
      continue;
    }
    if (ch === '{' || ch === '}') return false;
    if (isKeywordStart(inner, i)) {
      let end = i + 1;
      while (end < inner.length && isWordContinuation(inner[end])) end++;
      if (forbidden.some((keyword) => isSparqlKeyword(inner, i, end, keyword))) {
        return false;
      }
      i = end;
      continue;
    }
    i++;
  }
  return true;
}

/**
 * Collect every distinct SPARQL variable (`?x` / `$x`, in first-seen order,
 * sigil included) in a query fragment, skipping tokens inside line comments,
 * string literals, and IRI refs. Reuses the same literal/comment/IRI-aware
 * primitives as `collectGraphVariables` so a `?`/`$` inside a literal or IRI is
 * never mistaken for a variable.
 */
function collectQueryVariables(sparql: string): string[] {
  const variables: string[] = [];
  const seen = new Set<string>();
  const n = sparql.length;
  let i = 0;

  while (i < n) {
    const ch = sparql[i];
    if (ch === '#') {
      while (i < n && sparql[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipSparqlStringLiteral(sparql, i);
      continue;
    }
    if (ch === '<') {
      const end = skipSparqlIriRef(sparql, i);
      i = end ?? i + 1;
      continue;
    }
    if (ch === '?' || ch === '$') {
      const variable = readSparqlVariable(sparql, i);
      if (variable) {
        if (!seen.has(variable)) {
          seen.add(variable);
          variables.push(variable);
        }
        i += variable.length;
        continue;
      }
    }
    i++;
  }

  return variables;
}

/**
 * Rewrites a SPARQL query so EVERY subject variable used in its WHERE
 * block also matches `<http://dkg.io/ontology/trustLevel> ?__trustN`
 * with an integer value ≥ `minTrust`. Subjects with no trust metadata
 * are filtered out (the required triple is absent).
 *
 * The rewriter scans the WHERE block for top-level triple patterns
 * and collects every distinct subject variable so multi-subject
 * queries like `?a <p> ?o . ?b <q> ?r` have BOTH `?a` and `?b`
 * trust-filtered.
 *
 * Returns `null` when:
 *   - no `WHERE { ... }` block can be located;
 *   - braces are unbalanced;
 *   - the WHERE contains nested structure (`{`, `GRAPH`, `OPTIONAL`,
 *     `UNION`, `MINUS`, `SERVICE`, subselect) we cannot safely rewrite;
 *   - the block contains a constant (IRI/literal/blank) subject — we
 *     cannot attach a filter to a constant, and silently ignoring the
 *     constant row would leak sub-threshold data (L1 fail-closed);
 *   - no subject var is found at all.
 * Callers treat `null` as "refuse to run".
 */
/**
 * Strip SPARQL line comments (`# … EOL`) from a fragment of SPARQL
 * WHERE body while preserving `#` that appears inside an IRI
 * (`<http://…/rdf-ns#type>`) or inside a string literal (`"…#…"`,
 * `'…#…'`). Used by `injectMinTrustFilter` where a full parser would
 * be overkill but a naive line-comment regex mangles `rdf:type` etc.
 *
 * This is intentionally small: we handle the three grammar contexts
 * that can legally contain a bare `#` in SPARQL 1.1 (IRI, quoted
 * literal, line comment) and treat everything else as ordinary code.
 * Triple-quoted `"""…"""` / `'''…'''` are NOT recognised because
 * `injectMinTrustFilter` already bails on any WHERE containing tokens
 * from the multi-line literal grammar (FILTER EXISTS, SELECT, …).
 */
function stripSparqlLineComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '<') {
      const end = src.indexOf('>', i + 1);
      if (end === -1) { out += src.slice(i); break; }
      out += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // Centralised triple-quoted-aware skip.
      const j = skipSparqlStringLiteral(src, i);
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '#') {
      const nl = src.indexOf('\n', i);
      if (nl === -1) { break; }
      i = nl; // leave the newline so dot-accounting still sees line breaks
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Replace every SPARQL string literal and `# …` comment in `src`
 * with neutral whitespace, preserving overall byte length. IRIs and
 * code tokens are passed through verbatim. The returned string is
 * suitable for STRUCTURAL CHECKS (brace balancing, keyword scans)
 * that must not be confused by user payloads such as
 * `"{json: 1}"` or `# OPTIONAL: ...`.
 *
 * Triple-quoted
 * (`"""…"""` / `'''…'''`) literals are NOT recognised because
 * `injectMinTrustFilter`'s outer pipeline already refuses any WHERE
 * carrying tokens from the multi-line literal grammar (FILTER EXISTS,
 * SELECT inside, etc.).
 */
function scrubStringsAndComments(src: string): string {
  const n = src.length;
  const buf: string[] = new Array(n);
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '<') {
      const end = src.indexOf('>', i + 1);
      if (end === -1) {
        for (let k = i; k < n; k++) buf[k] = src[k];
        return buf.join('');
      }
      for (let k = i; k <= end; k++) buf[k] = src[k];
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // Centralised triple-quoted-aware skip.
      const j = skipSparqlStringLiteral(src, i);
      for (let k = i; k < j; k++) buf[k] = src[k] === '\n' ? '\n' : ' ';
      i = j;
      continue;
    }
    if (ch === '#') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      for (let k = i; k < end; k++) buf[k] = ' ';
      i = end;
      continue;
    }
    buf[i] = ch;
    i++;
  }
  return buf.join('');
}

/**
 * Split a SPARQL WHERE body on **top-level** triple terminators, i.e.
 * dots that live outside quoted literals and outside IRI angle
 * brackets. The earlier `/\.(?=\s|$)/` regex broke on literal dots
 * in messages like `?s <p> "hello. world"`, silently fragmenting
 * the statement so the subject scanner returned garbage and
 * `_minTrust` fail-closed to `[]` for every text/chat query. This
 * tokenizer walks the body character
 * by character, tracks `<…>` and `"…"` / `'…'` scopes (with `\`-escape
 * handling), and only treats `.` as a separator when it sits at depth
 * zero and is followed by whitespace or end-of-input. Comments have
 * already been stripped by {@link stripSparqlLineComments} before we
 * get here, so `#` is treated as an ordinary character.
 *
 * Parentheses and braces would also open top-level scopes in general
 * SPARQL, but `injectMinTrustFilter` refuses to rewrite any WHERE that
 * contains `{`, `}`, `FILTER EXISTS`, subselects, or property paths
 * with grouping (the `/\{|\}/.test(inner)` + token guard above), so
 * this helper only has to handle the three grammar contexts that can
 * legally carry a bare `.` in the shapes we rewrite: IRI, string
 * literal, and top-level statement terminator.
 */
function splitTopLevelTripleStatements(body: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = body.length;
  while (i < n) {
    const ch = body[i];
    if (ch === '<') {
      const end = body.indexOf('>', i + 1);
      if (end === -1) { i = n; break; }
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // Centralised triple-quoted-aware skip.
      i = skipSparqlStringLiteral(body, i);
      continue;
    }
    if (ch === '.') {
      // Terminator only when followed by whitespace OR end-of-input.
      // This keeps decimals and prefixed-name dots (rdf:type.foo —
      // rejected upstream anyway) from accidentally splitting, and
      // matches the original regex semantics on the top-level cases.
      const next = i + 1 < n ? body[i + 1] : '';
      if (next === '' || /\s/.test(next)) {
        const piece = body.slice(start, i).trim();
        if (piece) out.push(piece);
        start = i + 1;
        i += 1;
        continue;
      }
    }
    i++;
  }
  const tail = body.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

function injectMinTrustFilter(sparql: string, minTrust: number): string | null {
  // The
  // pre-fix rewriter only recognised `WHERE\s*\{`, so SPARQL 1.1
  // shorthand forms (`SELECT ?x { … }`, `ASK { … }`,
  // `DESCRIBE ?x { … }`, `CONSTRUCT { tmpl } { where }`) returned
  // `null` and the `minTrust > Endorsed` caller silently fell
  // through to an empty result. `findWhereBraceStart` normalises
  // every shape to the WHERE-clause brace position before we apply
  // the existing depth-counting pass below.
  const braceStart = findWhereBraceStart(sparql);
  if (braceStart === -1) return null;

  // — dkg-query-engine.ts:939). The
  // earlier brace-balance loop counted `{`/`}` inside SPARQL string
  // literals (e.g. `FILTER(STR(?t) = "{")`), so a literal-heavy WHERE
  // ended at depth 1 and `injectMinTrustFilter` returned `null` —
  // which the `_minTrust > Endorsed` caller treats as "refuse to run"
  // and silently fails closed. Use the literal/comment/IRI-aware
  // helper so the brace boundaries match what SPARQL actually
  // parses.
  const braceEnd = findMatchingCloseBrace(sparql, braceStart);
  if (braceEnd === -1) return null;

  const inner = sparql.slice(braceStart + 1, braceEnd);

  // A
  // leading top-level `VALUES` clause is the canonical SPARQL shape
  // for batched exact-subject lookups:
  //
  //     SELECT ?o WHERE {
  //       VALUES ?s { <a> <b> <c> }
  //       ?s <p> ?o .
  //     }
  //
  // the forbidden-tokens regex treated any VALUES as
  // "unsupported" and `_minTrust` fell through to
  // `emptyResultForForm(...)`, which turns into a silent `[]` / `false`
  // even when the bound subjects satisfy the threshold. The contract
  // we need is:
  //   (a) bail loudly on complex VALUES we can't reason about
  //       (multi-var tuples, multi-line, no closing `}`);
  //   (b) for the common single-var VALUES case, peel it off, run
  //       the existing subject analysis on the body, and re-emit
  //       the VALUES binding at the top of the rewritten WHERE so
  //       the trust filter still applies to each bound IRI.
  //
  // Any other location (non-leading, multi-var, parenthesised row
  // syntax `VALUES (?x ?y) { (<a> "b") }`) still bails because the
  // flat scanner cannot safely rewrite them.
  const { valuesClause, bodyAfterValues } = peelLeadingValues(inner);
  const scanTarget = bodyAfterValues ?? inner;

  // — dkg-query-engine.ts:851).
  // Pre-fix the unsupported-nesting guard `/\{|\}/.test(scanTarget)`
  // and the keyword guard below ran on the RAW WHERE body. Any
  // `{`, `}`, or sensitive keyword that happened to appear inside a
  // SPARQL string literal (`"{json: 1}"`, `"OPTIONAL field"`,
  // `"SELECT * FROM x"`) or inside a `# …` line comment caused the
  // rewriter to bail out and the caller fell through to
  // `emptyResultForSparql(...)`. That silently fail-closed every
  // legitimate high-trust query whose payload happened to mention
  // those tokens — text/JSON/log content is the most common case.
  //
  // Scrub literals and comments to neutral spaces BEFORE the
  // structural / keyword checks so they only see real code tokens.
  // IRIs are preserved verbatim because IRIREF grammar already
  // forbids `{`, `}`, `"`, and the keyword tokens we care about.
  const codeView = scrubStringsAndComments(scanTarget);
  if (/[{}]/.test(codeView)) return null;
  if (
    /\b(GRAPH|OPTIONAL|UNION|MINUS|SERVICE|VALUES|FILTER\s+EXISTS|FILTER\s+NOT\s+EXISTS|SELECT)\b/i.test(codeView)
  ) {
    return null;
  }

  // Strip SPARQL line comments (`# … \n`) so the dot accounting below
  // doesn't misclassify "# foo ." as a terminating triple — BUT leave
  // `#` fragments inside IRIs (`<…#…>`) and literals (`"…#…"`) alone.
  // The naive `/#[^\n]*/g` regex used here previously mangled the
  // extremely common `rdf:type` shape
  // `<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>` whenever
  // `_minTrust` was set, which fail-closes the entire query to `[]`
  // .
  const innerCodeOnly = stripSparqlLineComments(scanTarget);
  const trimmedInner = innerCodeOnly.trim();
  if (trimmedInner.length === 0) return null;

  // Split on the top-level `.` separator to walk each triple pattern.
  // use a
  // quote/IRI-aware tokenizer instead of a naive regex so `?s <p>
  // "hello. world"` isn't fragmented into broken statements that the
  // subject scanner then refuses, fail-closing `_minTrust` to `[]`
  // for every text/chat query. Rejoined dots are preserved for the
  // emitted query by the clause builder below.
  const statements = splitTopLevelTripleStatements(trimmedInner);

  const subjectVars = new Set<string>();
  const subjectIris = new Set<string>();
  const subjectPrefixed = new Set<string>();
  for (const stmt of statements) {
    // top-level `FILTER(...)` / `BIND(... AS ?x)` clauses share the
    // statement-list with triple patterns and have no subject token.
    // Pre-fix the subject regex below didn't match either keyword,
    // returned `null`, and `injectMinTrustFilter()` propagated `null`
    // — collapsing every query like
    //   SELECT ?s WHERE { ?s <p> ?o . FILTER(?o > 10) }
    // into an empty result whenever `minTrust > SelfAttested`.
    //
    // Skip these clauses in the subject scan: they don't introduce
    // new subjects and they survive verbatim because the rewritten
    // WHERE is built by appending trust-filter triples to the
    // *original* trimmed inner (see `rewrittenBody` below) — the
    // FILTER/BIND text stays exactly where the caller put it.
    //
    // Anti-recursion: only skip TOP-LEVEL FILTER/BIND. Nested ones
    // (e.g. `FILTER EXISTS { ... }`) are already rejected by the
    // `\{|\}` and `FILTER\s+EXISTS` checks at line 753 / 754, so
    // by the time we reach this loop we're guaranteed to be looking
    // at a flat FILTER(<expr>) or BIND(<expr> AS ?x).
    const stmtTrimmed = stmt.trim();
    if (/^FILTER\s*\(/i.test(stmtTrimmed) || /^BIND\s*\(/i.test(stmtTrimmed)) {
      continue;
    }
    // First non-whitespace token is the subject. Accept:
    //   - variable (`?x`, `$x`)
    //   - absolute IRI (`<urn:x>`)
    //   - blank node (`_:b`)
    //   - RDF literal (`"…"` with optional type/lang tag)
    //   - prefixed name (`ex:item`) — SPARQL `PNAME_LN` / `PNAME_NS`.
    //     Earlier revisions fail-closed `_minTrust` to `[]` for
    //     every query that used standard `PREFIX ex: <urn:> …`
    //     syntax, which is the recommended SPARQL shape for exact
    //     entity lookups.
    const m = stmt.match(
      /^\s*([?$]([A-Za-z_]\w*)|<[^>]+>|_:[A-Za-z_]\w*|"[^"]*"(?:\^\^<[^>]+>|@[A-Za-z-]+)?|[A-Za-z][\w-]*:[A-Za-z_][\w-]*|[A-Za-z][\w-]*:)/,
    );
    if (!m) return null;
    const subj = m[1];
    if (subj.startsWith('?') || subj.startsWith('$')) {
      subjectVars.add(subj);
      continue;
    }
    // exact-entity lookups like `SELECT ?o WHERE { <e> <p> ?o }` are
    // the most common SPARQL shape in DKG and must NOT fail closed on
    // `_minTrust`. The threshold is perfectly enforceable against a
    // concrete IRI: attach `<iri> <trustLevel> ?t . FILTER(?t >= N)`
    // to the rewritten WHERE. Blank-node and literal subjects remain
    // refused — neither can carry trust metadata in our ontology.
    if (subj.startsWith('<') && subj.endsWith('>')) {
      subjectIris.add(subj);
      continue;
    }
    // Prefixed name — treat like an IRI at the clause-emission stage.
    // The original query still carries the `PREFIX` declarations, so
    // emitting `ex:item <trustLevel> ?t . FILTER(...)` is valid SPARQL
    // at the same scope. Rejects `_:bn` (starts with `_:`) and
    // string literals (start with `"`) naturally because this branch
    // only runs when subj starts with a letter.
    if (/^[A-Za-z]/.test(subj) && subj.includes(':')) {
      subjectPrefixed.add(subj);
      continue;
    }
    // Blank-node / literal subject — cannot attach a trust filter.
    return null;
  }
  if (subjectVars.size === 0 && subjectIris.size === 0 && subjectPrefixed.size === 0) return null;

  const extraClauses: string[] = [];
  let i = 0;
  for (const subjectVar of subjectVars) {
    const trustVar = `?__dkgTrust${i++}`;
    extraClauses.push(
      `${subjectVar} <${TRUST_LEVEL_PREDICATE}> ${trustVar} . ` +
        `FILTER(<http://www.w3.org/2001/XMLSchema#integer>(STR(${trustVar})) >= ${minTrust})`,
    );
  }
  for (const subjectIri of subjectIris) {
    const trustVar = `?__dkgTrust${i++}`;
    extraClauses.push(
      `${subjectIri} <${TRUST_LEVEL_PREDICATE}> ${trustVar} . ` +
        `FILTER(<http://www.w3.org/2001/XMLSchema#integer>(STR(${trustVar})) >= ${minTrust})`,
    );
  }
  for (const subjectPfx of subjectPrefixed) {
    const trustVar = `?__dkgTrust${i++}`;
    extraClauses.push(
      `${subjectPfx} <${TRUST_LEVEL_PREDICATE}> ${trustVar} . ` +
        `FILTER(<http://www.w3.org/2001/XMLSchema#integer>(STR(${trustVar})) >= ${minTrust})`,
    );
  }

  // the previous implementation unconditionally inserted
  // `" . "` between `inner.trim()` and the injected clauses, which
  // produced `... . . ?s <trustLevel> ...` when the original WHERE
  // already ended with a dot (the common case) — a SPARQL syntax error
  // that every rewritten query hit. Here we emit each rewritten triple
  // with its OWN dot and join them after the original inner block,
  // always with exactly one separating dot regardless of whether the
  // caller terminated their final triple pattern.
  const endsWithDot = /\.\s*$/.test(trimmedInner);
  const separator = endsWithDot ? ' ' : ' . ';
  const rewrittenBody = `${trimmedInner}${separator}${extraClauses.join(' ')}`;

  // if the WHERE started with a `VALUES ?s { … }` clause the
  // peeler set aside, re-emit it at the top of the rewritten body so
  // the bindings it introduces still drive the trust-filtered BGP.
  const rewrittenInner = valuesClause
    ? `${valuesClause} ${rewrittenBody}`
    : rewrittenBody;

  const before = sparql.slice(0, braceStart + 1);
  const after = sparql.slice(braceEnd);
  return `${before} ${rewrittenInner} ${after}`;
}

/**
 * peel a single leading top-level `VALUES ?var { … }` clause
 * off the WHERE body. Returns the clause text (verbatim, including the
 * trailing `}`) and the remainder so the caller can reason about
 * triples alone. If the WHERE does NOT start with a VALUES clause, or
 * the VALUES clause is multi-var (`VALUES (?x ?y) { (<a> "b") }`), has
 * unbalanced braces, or uses nested parentheses for row syntax, returns
 * `{ valuesClause: null, bodyAfterValues: null }` so the caller falls
 * back to refusing the query (the forbidden-tokens regex still trips
 * on `VALUES`).
 */
function peelLeadingValues(inner: string): {
  valuesClause: string | null;
  bodyAfterValues: string | null;
} {
  const withoutComments = stripSparqlLineComments(inner);
  const m = withoutComments.match(/^\s*VALUES\s+([?$][A-Za-z_]\w*)\s*\{/i);
  if (!m) return { valuesClause: null, bodyAfterValues: null };

  const openBraceRel = m[0].length - 1;
  let depth = 1;
  let i = openBraceRel + 1;
  let inString = false;
  let inIri = false;
  for (; i < withoutComments.length; i++) {
    const ch = withoutComments[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (inIri) {
      if (ch === '>') inIri = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '<') { inIri = true; continue; }
    if (ch === '(' || ch === ')') {
      // Row-tuple syntax — we can't reason about multi-var rows safely.
      return { valuesClause: null, bodyAfterValues: null };
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return { valuesClause: null, bodyAfterValues: null };

  const closeAbs = i;
  const valuesClause = withoutComments.slice(0, closeAbs + 1).trim();
  const bodyAfterValues = withoutComments.slice(closeAbs + 1);
  return { valuesClause, bodyAfterValues };
}

function mergeSharedMemoryAndDataResults(
  dataResult: StoreQueryResult,
  smResult: StoreQueryResult,
): QueryResult {
  if (dataResult.type === 'quads' || smResult.type === 'quads') {
    const mergedQuads = dedupeQuads([
      ...(dataResult.type === 'quads' ? dataResult.quads : []),
      ...(smResult.type === 'quads' ? smResult.quads : []),
    ]);
    return { bindings: [], quads: mergedQuads };
  }

  if (dataResult.type === 'boolean' || smResult.type === 'boolean') {
    const value = (dataResult.type === 'boolean' ? dataResult.value : false)
      || (smResult.type === 'boolean' ? smResult.value : false);
    return { bindings: [{ result: String(value) }] };
  }

  const mergedBindings = dedupeBindings([
    ...(dataResult.type === 'bindings' ? dataResult.bindings : []),
    ...(smResult.type === 'bindings' ? smResult.bindings : []),
  ]);
  return { bindings: mergedBindings };
}

function dedupeBindings(
  bindings: Array<Record<string, string>>,
): Array<Record<string, string>> {
  const seen = new Set<string>();
  const out: Array<Record<string, string>> = [];
  for (const row of bindings) {
    const key = bindingKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function bindingKey(row: Record<string, string>): string {
  const entries = Object.entries(row).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function dedupeQuads(quads: Quad[]): Quad[] {
  const seen = new Set<string>();
  const out: Quad[] = [];
  for (const q of quads) {
    const key = `${q.subject}\u0000${q.predicate}\u0000${q.object}\u0000${q.graph}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/**
 * True when a SELECT carries a solution-set modifier whose semantics
 * cannot be reconstructed from per-graph result slices: DISTINCT,
 * ORDER BY, LIMIT, OFFSET, GROUP BY, HAVING, or an aggregate function
 * in the projection. Used by the per-graph multi-graph fallback (the
 * inner-UNION case in `queryMultipleGraphs`) to reject shapes that
 * would otherwise return duplicate / mis-ordered / over-limit rows.
 *
 * Literals, comments, and IRI bodies are blanked first
 * (`stripLiteralsAndComments`) so a keyword appearing inside a string
 * literal or IRI (e.g. `"top 10 LIMIT"`) doesn't trigger a false
 * positive. The aggregate check is intentionally broad — any of the
 * standard SPARQL aggregate functions invalidates naive concatenation
 * because the per-graph partial aggregates can't be combined post-hoc.
 */
function hasCrossGraphUnsafeModifier(sparql: string): boolean {
  const s = stripLiteralsAndComments(sparql);
  if (/\bDISTINCT\b/i.test(s)) return true;
  if (/\bORDER\s+BY\b/i.test(s)) return true;
  if (/\bGROUP\s+BY\b/i.test(s)) return true;
  if (/\bHAVING\b/i.test(s)) return true;
  if (/\bLIMIT\b/i.test(s)) return true;
  if (/\bOFFSET\b/i.test(s)) return true;
  if (/\b(COUNT|SUM|AVG|MIN|MAX|SAMPLE|GROUP_CONCAT)\s*\(/i.test(s)) return true;
  return false;
}
