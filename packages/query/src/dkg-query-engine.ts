import {
  asGraphWriteRevisionSource,
  isSparqlHttpResponseError,
} from '@origintrail-official/dkg-storage';
import type {
  TripleStore,
  Quad,
  QueryResult as StoreQueryResult,
  QueryOptions as StoreQueryOptions,
} from '@origintrail-official/dkg-storage';
import {
  ExactGraphReadError,
  GraphManager,
  readExactGraphPaged,
  resolveGraphScopedOrLegacyMetadata,
} from '@origintrail-official/dkg-storage';
import {
  prepareSparql,
  type SparqlLexicalToken,
} from '@origintrail-official/dkg-rdf-utils/sparql';
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
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  buildLegacyKnowledgeAssetMetadataQuery,
  stripSparqlLiteralsAndComments,
  type ParsedGraphKnowledgeAssetMetadata,
} from '@origintrail-official/dkg-core';
import {
  validateReadOnlySparql,
  emptyResultForSparql,
  detectSparqlQueryForm,
} from './sparql-guard.js';
import {
  assertExplicitGraphIrisAllowed,
  assertNoCallerDatasetClauses,
  constrainGraphVariablesToAllowedSet,
  materializeGraphScopeForExecution,
  prepareGraphScope,
  transitionGraphScope,
  wrapWithDeduplicatedGraphValues,
  wrapWithGraph,
  wrapWithGraphValues,
  wrapWithGraphUnion,
  type GraphScopeRewriteResult,
  type PreparedGraphScope,
} from './sparql-graph-scope.js';
import { CallerSparqlRejectedError } from './caller-sparql-error.js';
import { raceAgainstCallerAbort } from './caller-abort.js';
import { ScopedContentGraphDiscoveryMemo } from './scoped-content-graph-discovery-memo.js';

export { ScopedQueryViolationError } from './scoped-query-error.js';

/** Upstream statuses that mean the SUBMITTED query was malformed. */
const MALFORMED_CALLER_QUERY_STATUSES = new Set([400, 422]);

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

function storeOptions(options: QueryOptions | undefined): StoreQueryOptions | undefined {
  if (!options?.signal && !options?.priority && !options?.source) return undefined;
  return {
    signal: options.signal,
    priority: options.priority,
    source: options.source,
  };
}

function sharedDiscoveryStoreOptions(
  options: StoreQueryOptions | undefined,
): StoreQueryOptions | undefined {
  if (!options?.priority && !options?.source) return undefined;
  return {
    priority: options.priority,
    source: options.source,
  };
}

interface StoreReadLane {
  query(sparql: string): Promise<StoreQueryResult>;
  listGraphsByPrefix(prefix: string): Promise<string[]>;
  listGraphFamily(rootGraph: string): Promise<string[]>;
}

interface QueryStoreReadContext extends StoreReadLane {
  readonly signal: AbortSignal | undefined;
  readonly shared: StoreReadLane & { readonly cacheKey: string };
}

function createStoreReadLane(
  store: TripleStore,
  options: StoreQueryOptions | undefined,
): StoreReadLane {
  return {
    query: (sparql) => store.query(sparql, options),
    listGraphsByPrefix: (prefix) => listGraphsByPrefix(store, prefix, options),
    listGraphFamily: (rootGraph) => listGraphFamily(store, rootGraph, options),
  };
}

function createQueryStoreReadContext(
  store: TripleStore,
  queryOptions: QueryOptions | undefined,
): QueryStoreReadContext {
  const options = storeOptions(queryOptions);
  const lane = createStoreReadLane(store, options);
  const sharedOptions = sharedDiscoveryStoreOptions(options);
  return {
    ...lane,
    signal: options?.signal,
    shared: {
      ...createStoreReadLane(store, sharedOptions),
      cacheKey: JSON.stringify([
        sharedOptions?.priority ?? 'normal',
        sharedOptions?.source ?? null,
      ]),
    },
  };
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
  private readonly scopedContentGraphDiscoveryMemo: ScopedContentGraphDiscoveryMemo;

  constructor(store: TripleStore) {
    this.store = store;
    this.graphManager = new GraphManager(store);
    this.scopedContentGraphDiscoveryMemo = new ScopedContentGraphDiscoveryMemo(
      asGraphWriteRevisionSource(store),
    );
  }

  async query(sparql: string, options?: QueryOptions): Promise<QueryResult> {
    const prepared = prepareSparql(sparql);
    if (prepared.normalized === null) {
      throw new Error('SPARQL rejected: malformed Unicode code-point escape');
    }
    if (prepared.wordTokens.has('SERVICE')) {
      throw new Error('SPARQL rejected: SERVICE clauses are not allowed');
    }
    const reads = createQueryStoreReadContext(this.store, options);
    const guard = validateReadOnlySparql(prepared);
    if (!guard.safe) {
      throw new Error(`SPARQL rejected: ${guard.reason}`);
    }
    // Policy checks and rewrites retain the prepared source/logical views.
    // Active UCHAR syntax is materialized once, immediately before the final
    // caller query crosses the store boundary.
    const initialGraphScope = prepareGraphScope(sparql, prepared);
    let routedScope = initialGraphScope;

    // ── V10 view-based routing ────────────────────────────────────────
    const effectiveContextGraphId = options?.contextGraphId;
    if (effectiveContextGraphId) {
      assertNoCallerDatasetClauses(initialGraphScope);
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
      const swmPerKaGraphs = swmRouted
        ? await this.discoverGraphsByPrefix(`${sharedMemoryGraph}/`, reads)
        : [];
      // Per-KA VM: published data is in …/_verifiable_memory/{addr}/{number}; bind those too
      // for GRAPH-variable scans on any route that reads the data graph.
      const dataRouted = options?.graphSuffix !== '_shared_memory';
      const vmPerKaGraphs = dataRouted
        ? await this.discoverGraphsByPrefix(
            `${dataGraph}/_verifiable_memory/`,
            reads,
          )
        : [];
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
            ...(await this.discoverGraphScopedPrivateGraphs(
              effectiveContextGraphId,
              reads,
              subGraphName,
            )),
          ]
        : [];
      const explicitAllowedGraphs = [...allowedGraphs, ...metaAllowList, ...privateAllowList];
      const shouldExpandGraphVariables =
        options?.includeContextGraphPartitions === true
        && initialGraphScope.graphVariables.length > 0;
      const variableAllowedGraphs = shouldExpandGraphVariables
        ? await this.resolveScopedGraphVariableAllowList(
            effectiveContextGraphId,
            explicitAllowedGraphs,
            { subGraphName, isSwmOnlyRoute },
            reads,
          )
        : explicitAllowedGraphs;
      // Explicit GRAPH IRIs remain limited to the static route-specific
      // allow-list. GRAPH variables only gain known same-CG content
      // partitions for callers that explicitly opt into broad count scans;
      // legacy scoped routes keep their selected memory-layer contract.
      assertExplicitGraphIrisAllowed(initialGraphScope, explicitAllowedGraphs);
      routedScope = constrainGraphVariablesToAllowedSet(
        initialGraphScope,
        variableAllowedGraphs,
      );
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
      return this.queryWithView(
        initialGraphScope,
        options.view,
        effectiveContextGraphId,
        options,
        reads,
      );
    }

    // ── Legacy routing (V9 compat) ────────────────────────────────────
    let effectiveScope = routedScope;

    if (effectiveContextGraphId) {
      const dataGraph = options?.subGraphName
        ? contextGraphSubGraphUri(effectiveContextGraphId, options.subGraphName)
        : contextGraphDataUri(effectiveContextGraphId);
      const sharedMemoryGraph = contextGraphSharedMemoryUri(effectiveContextGraphId, options?.subGraphName);
      if (options?.includeSharedMemory ?? options?.includeWorkspace) {
        // Per-KA VM: read-both the published per-KA …/_verifiable_memory/{addr}/{number} + root.
        const vmGraphsInc = await this.discoverGraphsByPrefix(
          `${dataGraph}/_verifiable_memory/`,
          reads,
        );
        const dataRewrite = vmGraphsInc.length > 0
          ? this.wrapVerifiableMemoryGraphSet(routedScope, [dataGraph, ...vmGraphsInc])
          : null;
        const dataScope = dataRewrite?.kind === 'ready'
          ? dataRewrite.scope
          : wrapWithGraph(routedScope, dataGraph);
        // Per-KA SWM: union the discovered …/_shared_memory/{addr}/{number} graphs.
        const swmGraphs = await this.discoverGraphsByPrefix(
          `${sharedMemoryGraph}/`,
          reads,
        );
        const sharedMemoryRewrite = swmGraphs.length > 0
          ? wrapWithGraphUnion(routedScope, swmGraphs)
          : null;
        const sharedMemoryScope = sharedMemoryRewrite?.kind === 'ready'
          ? sharedMemoryRewrite.scope
          : wrapWithGraph(routedScope, sharedMemoryGraph);
        // Both are graph-wrapped forms of the CALLER's query, so they carry
        // the same provenance as execAndNormalize (PR #2330 review — this
        // branch previously bypassed the marker, leaving the original 500 for
        // any `includeSharedMemory` request with malformed SPARQL).
        const dataResult = await this.execCallerQuery(dataScope, reads);
        const smResult = await this.execCallerQuery(sharedMemoryScope, reads);
        return mergeSharedMemoryAndDataResults(dataResult, smResult);
      }
      if (options?.graphSuffix === '_shared_memory') {
        // Uniform layout: SWM is per-KA …/_shared_memory/{addr}/{number}. Discover the
        // per-KA graphs under the prefix and union them (the legacy bucket is now empty).
        const swmGraphs = await this.discoverGraphsByPrefix(
          `${sharedMemoryGraph}/`,
          reads,
        );
        const rewrite = swmGraphs.length > 0
          ? wrapWithGraphUnion(routedScope, swmGraphs)
          : null;
        effectiveScope = rewrite?.kind === 'ready'
          ? rewrite.scope
          : wrapWithGraph(routedScope, sharedMemoryGraph);
      } else {
        // Per-KA VM: read-both the published per-KA …/_verifiable_memory/{addr}/{number} + root.
        const vmGraphs = await this.discoverGraphsByPrefix(
          `${dataGraph}/_verifiable_memory/`,
          reads,
        );
        const rewrite = vmGraphs.length > 0
          ? this.wrapVerifiableMemoryGraphSet(routedScope, [dataGraph, ...vmGraphs])
          : null;
        effectiveScope = rewrite?.kind === 'ready'
          ? rewrite.scope
          : wrapWithGraph(routedScope, dataGraph);
      }
    }

    const result = await this.execAndNormalize(effectiveScope, reads);

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
    initialScope: PreparedGraphScope,
    view: GetView,
    contextGraphId: string,
    options: QueryOptions,
    reads: QueryStoreReadContext,
  ): Promise<QueryResult> {
    const sparql = initialScope.source;
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
        reads,
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
      const discovered = await this.discoverGraphsByPrefix(prefix, reads);
      allGraphs.push(...discovered);
    }

    // A by-name WM read is pinned to one assertion root to avoid sibling leaks,
    // but named-graph draft content is stored under child graphs of that exact
    // root. Include only the selected assertion's scoped child family.
    if (view === 'working-memory' && options.assertionName) {
      for (const rootGraph of resolution.graphs) {
        allGraphs.push(...(await this.discoverGraphsByPrefix(
          `${rootGraph}${ASSERTION_NAMED_GRAPH_PREFIX}`,
          reads,
        )));
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
      const subNames = await this.discoverRegisteredSubGraphNames(
        contextGraphId,
        reads,
      );
      for (const sub of subNames) {
        const subResolution = resolveViewGraphs(view, contextGraphId, {
          agentAddress: options.agentAddress,
          subGraphName: sub,
        });
        allGraphs.push(...subResolution.graphs);
        for (const prefix of subResolution.graphPrefixes) {
          allGraphs.push(...(await this.discoverGraphsByPrefix(prefix, reads)));
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
      allGraphs.push(...(await this.discoverContextGraphPerCgIdDataGraphs(
        contextGraphId,
        reads,
      )));
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

    assertExplicitGraphIrisAllowed(initialScope, allGraphs);
    const constrainedScope = constrainGraphVariablesToAllowedSet(initialScope, allGraphs);

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
    let effectiveScope = constrainedScope;
    const effectiveMinTrust = options.minTrust ?? options._minTrust;
    // `SelfAttested` (0) is the floor and means no trust filter is needed.
    // Endorsed and above require explicit writer-side trust metadata.
    if (
      view === 'verifiable-memory' &&
      effectiveMinTrust !== undefined &&
      effectiveMinTrust > TrustLevel.SelfAttested
    ) {
      const rewritten = injectMinTrustFilter(constrainedScope, effectiveMinTrust);
      if (rewritten.kind === 'unsupported') {
        console.warn(
          `[DKGQueryEngine] minTrust=${effectiveMinTrust} requested for a query shape ` +
            `injectMinTrustFilter cannot safely rewrite; returning empty result (fail-closed)`,
        );
        // Preserve the query form so CONSTRUCT/DESCRIBE callers see
        // `{ bindings: [], quads: [] }` rather than a shapeless deny, and
        // ASK callers see `{ bindings: [{ result: 'false' }] }`.
        return emptyResultForSparql(constrainedScope.source);
      }
      effectiveScope = rewritten.scope;
    }

    if (allGraphs.length === 1) {
      return this.execAndNormalize(
        wrapWithGraph(effectiveScope, allGraphs[0]),
        reads,
      );
    }

    if (view === 'verifiable-memory') {
      const rewritten = this.wrapVerifiableMemoryGraphSet(effectiveScope, allGraphs);
      if (rewritten.kind === 'ready') {
        return this.execAndNormalize(rewritten.scope, reads);
      }
    }

    return this.queryMultipleGraphs(effectiveScope, allGraphs, reads);
  }

  /** Canonical graph rewrite for root + per-KA/per-cgId verifiable-memory reads. */
  private wrapVerifiableMemoryGraphSet(
    scope: PreparedGraphScope,
    graphs: string[],
  ): GraphScopeRewriteResult {
    if (graphs.length <= 1) return wrapWithGraphUnion(scope, graphs);
    const deduplicated = wrapWithDeduplicatedGraphValues(scope, graphs);
    if (deduplicated.kind === 'ready') return deduplicated;
    const values = wrapWithGraphValues(scope, graphs);
    if (values.kind === 'ready') return values;
    return wrapWithGraphUnion(scope, graphs);
  }

  private async queryMultipleGraphs(
    scope: PreparedGraphScope,
    graphs: string[],
    reads: StoreReadLane,
  ): Promise<QueryResult> {
    const sparql = scope.source;
    if (graphs.length === 0) return { bindings: [] };
    if (graphs.length === 1) {
      return this.execAndNormalize(wrapWithGraph(scope, graphs[0]), reads);
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
    const valuesRewrite = wrapWithGraphValues(scope, graphs);
    if (valuesRewrite.kind === 'ready') {
      return this.execAndNormalize(valuesRewrite.scope, reads);
    }
    // Residual shapes `wrapWithGraphValues` declines (an inner top-level
    // UNION, no locatable WHERE block, or a sentinel-variable collision) keep
    // the original union / per-graph fallback so the #789 form-aware
    // cross-graph merge below is preserved unchanged.
    const unionRewrite = wrapWithGraphUnion(scope, graphs);
    if (unionRewrite.kind === 'ready') {
      return this.execAndNormalize(unionRewrite.scope, reads);
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
        const r = await this.execAndNormalize(wrapWithGraph(scope, g), reads);
        if (r.quads) merged.push(...r.quads);
      }
      return { bindings: [], quads: dedupeQuads(merged) };
    }

    if (form === 'ASK') {
      // Boolean result: true iff the pattern matches in ANY graph.
      // Short-circuit on the first positive graph.
      for (const g of graphs) {
        const r = await this.execAndNormalize(wrapWithGraph(scope, g), reads);
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
      const r = await this.execAndNormalize(wrapWithGraph(scope, g), reads);
      all.push(...r.bindings);
    }
    return { bindings: all };
  }

  private async discoverGraphsByPrefix(
    prefix: string,
    reads: QueryStoreReadContext | StoreReadLane,
  ): Promise<string[]> {
    // GraphSetIndexStore coalesces refreshes by priority. Never let that shared
    // upstream flight capture one HTTP caller's disconnect signal; race the
    // individual caller locally while priority/source stay on the shared lane.
    const sharedReads = 'shared' in reads ? reads.shared : reads;
    const callerSignal = 'shared' in reads ? reads.signal : undefined;
    const allGraphs = await raceAgainstCallerAbort(
      sharedReads.listGraphsByPrefix(prefix),
      callerSignal,
    );
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
  private async discoverContextGraphPerCgIdDataGraphs(
    contextGraphId: string,
    reads: StoreReadLane,
  ): Promise<string[]> {
    const base = `did:dkg:context-graph:${contextGraphId}/context/`;
    const discovered = await this.discoverGraphsByPrefix(base, reads);
    return discovered.filter((g) => {
      const rest = g.slice(base.length);
      return rest.length > 0 && !rest.includes('/');
    });
  }

  /**
   * Resolve only the immutable private graphs referenced by valid current V2
   * metadata in this exact context graph. The broad `/_private/` prefix also
   * contains mutable WM drafts, so prefix-enumerating it would let an
   * `includePrivate` query cross the draft/finalized boundary. Deriving each
   * graph from the canonical UAL + assertion version keeps the allow-list
   * fail-closed and makes GRAPH-variable discovery work for rootless KAs.
   */
  private async discoverGraphScopedPrivateGraphs(
    contextGraphId: string,
    reads: StoreReadLane,
    subGraphName?: string,
  ): Promise<string[]> {
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const subGraphClause = subGraphName
      ? `?ual <http://dkg.io/ontology/subGraphName> "${escapeSparqlLiteral(subGraphName)}" .`
      : `FILTER NOT EXISTS { ?ual <http://dkg.io/ontology/subGraphName> ?_subGraphName . }`;
    const result = await reads.query(
      `SELECT DISTINCT ?ual ?scopeVersion ?kaUal ?assertionVersion ?assertionGraph ?privateCount WHERE {
        GRAPH <${assertSafeIri(metaGraph)}> {
          ?ual <http://dkg.io/ontology/contentScopeVersion> ?scopeVersion ;
               <http://dkg.io/ontology/kaUal> ?kaUal ;
               <http://dkg.io/ontology/assertionVersion> ?assertionVersion ;
               <http://dkg.io/ontology/assertionGraph> ?assertionGraph ;
               <http://dkg.io/ontology/privateTripleCount> ?privateCount ;
               <http://dkg.io/ontology/status> ?status .
          FILTER(?status IN ("confirmed", "tentative"))
          ${subGraphClause}
        }
      }`,
    );
    if (result.type !== 'bindings') return [];

    const privateRoot = subGraphName
      ? contextGraphSubGraphPrivateUri(contextGraphId, subGraphName)
      : contextGraphPrivateUri(contextGraphId);
    const graphs = new Set<string>();
    for (const row of result.bindings) {
      const ual = row['ual'];
      const metadataUal = row['kaUal'];
      const assertionGraph = row['assertionGraph'];
      const scopeVersion = parseCanonicalIntegerBinding(row['scopeVersion']);
      const assertionVersion = parseCanonicalIntegerBinding(row['assertionVersion']);
      const privateCount = parseCanonicalIntegerBinding(row['privateCount']);
      if (
        !ual
        || metadataUal !== ual
        || !assertionGraph
        || scopeVersion !== BigInt(GRAPH_KA_CONTENT_SCOPE_VERSION)
        || assertionVersion === undefined
        || assertionVersion < 1n
        || privateCount === undefined
        || privateCount < 1n
      ) {
        continue;
      }
      try {
        const scope = createGraphKnowledgeAssetScope(ual, assertionVersion);
        const expectedPublicGraph = knowledgeAssetLayerGraphUri(
          contextGraphId,
          MemoryLayer.VerifiableMemory,
          scope,
          subGraphName,
        );
        if (assertionGraph !== expectedPublicGraph) continue;
        graphs.add(assertSafeIri(
          `${privateRoot}/${scope.agentAddress}/${scope.kaNumber}/assertions/${scope.assertionVersion}`,
        ));
      } catch {
        // Invalid or non-canonical metadata never widens the private allow-list.
      }
    }
    return [...graphs];
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
    reads: StoreReadLane,
    subGraphName?: string,
  ): Promise<bigint | undefined> {
    // Mirror the writer (`assertionFinalize`): the `dkg:kaId` stamp lives in the
    // ROOT `_meta` graph, but keyed by the SUB-GRAPH-AWARE lifecycle URN
    // (`urn:dkg:assertion:{cg}:{sub}:{addr}:{name}`). Omitting the sub-graph
    // segment here made every sub-graph by-name lookup miss (Codex on PR #1132).
    const urn = assertionLifecycleUri(contextGraphId, agentAddress, assertionName, subGraphName);
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const res = await reads.query(
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
    reads: QueryStoreReadContext,
  ): Promise<string[]> {
    if (opts.isSwmOnlyRoute) {
      return staticAllowedGraphs;
    }

    const allowed = new Set(staticAllowedGraphs);
    const scopedContentGraphs = await this.resolveScopedContentGraphAllowList(
      contextGraphId,
      reads,
      opts.subGraphName,
    );
    for (const graph of scopedContentGraphs) {
      allowed.add(graph);
    }

    return [...allowed];
  }

  private async resolveScopedContentGraphAllowList(
    contextGraphId: string,
    reads: QueryStoreReadContext,
    subGraphName?: string,
  ): Promise<readonly string[]> {
    const contentKey = JSON.stringify([contextGraphId, subGraphName ?? null]);
    const graphPrefix = `did:dkg:context-graph:${contextGraphId}`;
    return this.scopedContentGraphDiscoveryMemo.get({
      contentKey,
      laneKey: reads.shared.cacheKey,
      graphPrefix,
      signal: reads.signal,
      load: () => this.discoverScopedContentGraphAllowList(
        contextGraphId,
        reads.shared,
        subGraphName,
      ),
    });
  }

  private async discoverScopedContentGraphAllowList(
    contextGraphId: string,
    reads: StoreReadLane,
    subGraphName?: string,
  ): Promise<string[]> {
    const allowed = new Set<string>();
    const registeredSubGraphs = subGraphName
      ? new Set([subGraphName])
      : await this.discoverRegisteredSubGraphNames(contextGraphId, reads);
    const registeredAssertionGraphs = await this.discoverRegisteredAssertionGraphs(
      contextGraphId,
      reads,
    );
    const knownChildContextGraphs = await this.discoverKnownChildContextGraphUris(
      contextGraphId,
      reads,
    );
    const allGraphs = await reads.listGraphFamily(
      `did:dkg:context-graph:${contextGraphId}`,
    );

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

  private async discoverRegisteredSubGraphNames(
    contextGraphId: string,
    reads: StoreReadLane,
  ): Promise<Set<string>> {
    const names = new Set<string>();
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const result = await reads.query(
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

  private async discoverRegisteredAssertionGraphs(
    contextGraphId: string,
    reads: StoreReadLane,
  ): Promise<Set<string>> {
    const graphs = new Set<string>();
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const result = await reads.query(
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

  private async discoverKnownChildContextGraphUris(
    contextGraphId: string,
    reads: StoreReadLane,
  ): Promise<Set<string>> {
    const rootPrefix = `${contextGraphDataUri(contextGraphId)}/`;
    const result = await reads.query(
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

  /**
   * Execute CALLER-derived SPARQL and mark a store rejection with provenance.
   *
   * GH#1758 — every caller-derived store execution must go through here.
   * Engine-generated queries (access checks, graph resolution, metadata scans)
   * deliberately do NOT, so the HTTP boundary can answer 400 for a malformed
   * caller query without blaming the caller when the configured backend
   * rejects an internal one.
   *
   * Only 400/422 are translated: 401/403/404/429 and 5xx mean the store
   * rejected US and stay server faults (PR #2330 review).
   */
  private async execCallerQuery(scope: PreparedGraphScope, reads: StoreReadLane) {
    const sparql = materializeGraphScopeForExecution(scope);
    try {
      return await reads.query(sparql);
    } catch (err) {
      if (isSparqlHttpResponseError(err) && MALFORMED_CALLER_QUERY_STATUSES.has(err.status)) {
        throw new CallerSparqlRejectedError(err.message, err.status, { cause: err });
      }
      throw err;
    }
  }

  private async execAndNormalize(
    scope: PreparedGraphScope,
    reads: StoreReadLane,
  ): Promise<QueryResult> {
    const result = await this.execCallerQuery(scope, reads);

    if (result.type === 'bindings') {
      if (result.bindings.length === 0) {
        const empty = emptyResultForSparql(scope.source);
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
    const resolved = await resolveGraphScopedOrLegacyMetadata(
      this.store,
      safeUal,
      () => this.resolveLegacyRootScopedKA(safeUal),
      { source: 'query.resolveKnowledgeAsset.metadata' },
    );
    if (resolved.kind === 'graph') {
      return this.resolveGraphScopedKA(safeUal, resolved.metadata);
    }
    if (resolved.kind === 'legacy') return resolved.metadata;
    throw new Error(`KA not found for UAL: ${safeUal}`);
  }

  private async resolveGraphScopedKA(
    ual: string,
    metadata: ParsedGraphKnowledgeAssetMetadata,
  ): Promise<ResolvedGraphKnowledgeAsset> {
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
      buildLegacyKnowledgeAssetMetadataQuery(ual),
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

function parseCanonicalIntegerBinding(value: string | undefined): bigint | undefined {
  const lexical = stripSparqlLiteralValue(value);
  if (!/^(?:0|[1-9][0-9]*)$/.test(lexical)) return undefined;
  try {
    return BigInt(lexical);
  } catch {
    return undefined;
  }
}

async function listGraphsByPrefix(
  store: TripleStore,
  prefix: string,
  options?: StoreQueryOptions,
): Promise<string[]> {
  return store.listGraphsByPrefix
    ? store.listGraphsByPrefix(prefix, options)
    : (await store.listGraphs(options)).filter((graph) => graph.startsWith(prefix));
}

async function listGraphFamily(
  store: TripleStore,
  rootGraph: string,
  options?: StoreQueryOptions,
): Promise<string[]> {
  const graphs = await listGraphsByPrefix(store, `${rootGraph}/`, options);
  if (await store.hasGraph(rootGraph, options)) {
    graphs.unshift(rootGraph);
  }
  return graphs;
}

/**
 * Rewrites a SPARQL query so EVERY supported subject used in its WHERE
 * block also matches `<http://dkg.io/ontology/trustLevel> ?__trustN`
 * with an integer value ≥ `minTrust`. Subjects with no trust metadata
 * are filtered out (the required triple is absent).
 *
 * The rewriter scans the WHERE block for top-level triple patterns
 * and collects every distinct variable or IRI subject so multi-subject
 * queries like `?a <p> ?o . ?b <q> ?r` have BOTH `?a` and `?b`
 * trust-filtered.
 *
 * Returns an explicit `unsupported` result when:
 *   - no `WHERE { ... }` block can be located;
 *   - braces are unbalanced;
 *   - the WHERE contains nested structure (`{`, `GRAPH`, `OPTIONAL`,
 *     `UNION`, `MINUS`, `SERVICE`, subselect) we cannot safely rewrite;
 *   - the block contains a literal, blank node, collection, or property-list
 *     subject/shape that cannot safely carry the injected metadata pattern;
 *   - no supported subject is found at all.
 * Callers treat `unsupported` as "refuse to run".
 */
type SourceSparqlToken = Extract<SparqlLexicalToken, { value: string }>;

function isSourceSparqlToken(token: SparqlLexicalToken | undefined): token is SourceSparqlToken {
  return token !== undefined && 'value' in token;
}

interface MinTrustBodyScan {
  readonly valuesClause: string | null;
  readonly bodySource: string;
  readonly bodyTokenStart: number;
  readonly bodyTokenEnd: number;
}

/**
 * Locate the flat BGP that minTrust can safely augment. All structural
 * decisions use the prepared logical token stream, so active UCHAR spelling
 * cannot hide VALUES braces or introduce a nested group at execution time.
 */
function scanMinTrustBody(scope: PreparedGraphScope): MinTrustBodyScan | null {
  const { where } = scope;
  if (!where) return null;

  const { tokens } = scope.prepared;
  const bodyEnd = where.closingTokenIndex;
  let bodyTokenStart = where.openingTokenIndex + 1;
  let bodySourceStart = where.openEnd;
  let valuesClause: string | null = null;

  const first = tokens[bodyTokenStart];
  if (isSourceSparqlToken(first) && first.kind === 'word' && first.upper === 'VALUES') {
    const variable = tokens[bodyTokenStart + 1];
    const opening = tokens[bodyTokenStart + 2];
    if (
      !isSourceSparqlToken(variable)
      || variable.kind !== 'variable'
      || !isSourceSparqlToken(opening)
      || opening.kind !== 'symbol'
      || opening.logicalValue !== '{'
    ) {
      return null;
    }

    const valuesOpeningIndex = bodyTokenStart + 2;
    const valuesClosingIndex = scope.matchingBraceTokenIndexes[valuesOpeningIndex] ?? -1;
    if (valuesClosingIndex <= valuesOpeningIndex || valuesClosingIndex >= bodyEnd) return null;

    for (let index = valuesOpeningIndex + 1; index < valuesClosingIndex; index++) {
      const token = tokens[index];
      if (
        isSourceSparqlToken(token)
        && token.kind === 'symbol'
        && ['{', '}', '(', ')'].includes(token.logicalValue)
      ) {
        return null;
      }
    }

    const closing = tokens[valuesClosingIndex];
    valuesClause = scope.source.slice(where.openEnd, closing.end).trim();
    bodyTokenStart = valuesClosingIndex + 1;
    bodySourceStart = closing.end;
  }

  const bodyDepth = scope.braceDepths[where.openingTokenIndex] + 1;
  const forbiddenWords = new Set([
    'GRAPH',
    'OPTIONAL',
    'UNION',
    'MINUS',
    'SERVICE',
    'VALUES',
    'SELECT',
  ]);
  for (let index = bodyTokenStart; index < bodyEnd; index++) {
    const token = tokens[index];
    if (scope.braceDepths[index] !== bodyDepth) return null;
    if (!isSourceSparqlToken(token)) continue;
    if (token.kind === 'symbol' && (token.logicalValue === '{' || token.logicalValue === '}')) {
      return null;
    }
    if (token.kind === 'word' && forbiddenWords.has(token.upper)) return null;
  }

  return {
    valuesClause,
    bodySource: scope.source.slice(bodySourceStart, where.close),
    bodyTokenStart,
    bodyTokenEnd: bodyEnd,
  };
}

function isDecimalPoint(
  tokens: readonly SparqlLexicalToken[],
  index: number,
): boolean {
  const previous = tokens[index - 1];
  const point = tokens[index];
  const next = tokens[index + 1];
  return isSourceSparqlToken(previous)
    && isSourceSparqlToken(point)
    && isSourceSparqlToken(next)
    && previous.end === point.start
    && point.end === next.start
    && /^\d$/u.test(previous.logicalValue)
    && /^\d$/u.test(next.logicalValue);
}

function skipMinTrustExpression(
  tokens: readonly SparqlLexicalToken[],
  start: number,
  end: number,
): number | null {
  let opening = start + 1;
  while (opening < end) {
    const token = tokens[opening];
    if (
      isSourceSparqlToken(token)
      && token.kind === 'symbol'
      && token.logicalValue === '('
    ) {
      break;
    }
    if (
      isSourceSparqlToken(token)
      && token.kind === 'symbol'
      && token.logicalValue === '.'
    ) {
      return null;
    }
    opening++;
  }
  if (opening >= end) return null;

  let depth = 0;
  for (let index = opening; index < end; index++) {
    const token = tokens[index];
    if (!isSourceSparqlToken(token) || token.kind !== 'symbol') continue;
    if (token.logicalValue === '(') depth++;
    if (token.logicalValue === ')') {
      depth--;
      if (depth === 0) return index + 1;
      if (depth < 0) return null;
    }
  }
  return null;
}

/**
 * Return each subject token in the supported flat group pattern. FILTER and
 * BIND are skipped with balanced logical parentheses, including when SPARQL's
 * optional dot is omitted before the next triple block.
 */
function minTrustSubjectTokens(
  scope: PreparedGraphScope,
  body: MinTrustBodyScan,
): SparqlLexicalToken[] | null {
  const { tokens } = scope.prepared;
  const subjects: SparqlLexicalToken[] = [];
  let expectSubject = true;
  let index = body.bodyTokenStart;
  while (index < body.bodyTokenEnd) {
    const token = tokens[index];

    if (
      isSourceSparqlToken(token)
      && token.kind === 'word'
      && (token.upper === 'FILTER' || token.upper === 'BIND')
    ) {
      const next = skipMinTrustExpression(tokens, index, body.bodyTokenEnd);
      if (next === null) return null;
      expectSubject = true;
      index = next;
      continue;
    }

    if (
      isSourceSparqlToken(token)
      && token.kind === 'symbol'
      && token.logicalValue === '.'
      && !isDecimalPoint(tokens, index)
    ) {
      expectSubject = true;
      index++;
      continue;
    }

    if (
      isSourceSparqlToken(token)
      && token.kind === 'symbol'
      && ['(', ')', '[', ']'].includes(token.logicalValue)
    ) return null;

    if (expectSubject) {
      subjects.push(token);
      expectSubject = false;
    }
    index++;
  }
  return subjects;
}

function injectMinTrustFilter(
  scope: PreparedGraphScope,
  minTrust: number,
): GraphScopeRewriteResult {
  const sparql = scope.source;
  const unsupported = (): GraphScopeRewriteResult => ({ kind: 'unsupported', original: scope });
  const bodyStart = scope.where?.openEnd ?? -1;
  const braceEnd = scope.where?.close ?? -1;
  const body = scanMinTrustBody(scope);
  if (bodyStart < 0 || braceEnd < 0 || !body) return unsupported();

  const trimmedInner = body.bodySource.trim();
  if (trimmedInner.length === 0) return unsupported();

  // The first prepared token of every flat statement is its subject. String,
  // IRI, and comment payloads are already opaque, while logicalValue exposes
  // active UCHAR spelling. This keeps subject discovery aligned with the exact
  // structure that will be materialized for the store.
  const subjectTokens = minTrustSubjectTokens(scope, body);
  if (!subjectTokens) return unsupported();
  const subjects = new Map<string, string>();
  for (const token of subjectTokens) {
    if (isSourceSparqlToken(token) && token.kind === 'variable') {
      subjects.set(`variable:${token.logicalValue.slice(1)}`, token.value);
      continue;
    }
    if (token.kind === 'iri') {
      subjects.set(
        `iri:${token.logicalValue}`,
        sparql.slice(token.start, token.end),
      );
      continue;
    }
    if (
      isSourceSparqlToken(token)
      && token.kind === 'prefixed-name'
      && !token.logicalValue.startsWith('_:')
    ) {
      subjects.set(`prefixed:${token.logicalValue}`, token.value);
      continue;
    }
    return unsupported();
  }
  if (subjects.size === 0) return unsupported();

  const extraClauses: string[] = [];
  const usedVariableNames = new Set(scope.queryVariables.map((variable) => variable.logicalName));
  let helperIndex = 0;
  for (const subject of subjects.values()) {
    let helperName: string;
    do {
      helperName = `__dkgTrust${helperIndex++}`;
    } while (usedVariableNames.has(helperName));
    usedVariableNames.add(helperName);
    const trustVar = `?${helperName}`;
    extraClauses.push(
      `${subject} <${TRUST_LEVEL_PREDICATE}> ${trustVar} . ` +
        `FILTER(<http://www.w3.org/2001/XMLSchema#integer>(STR(${trustVar})) >= ${minTrust})`,
    );
  }

  const lastBodyToken = scope.prepared.tokens[body.bodyTokenEnd - 1];
  const endsWithDot = isSourceSparqlToken(lastBodyToken)
    && lastBodyToken.kind === 'symbol'
    && lastBodyToken.logicalValue === '.';
  // Always cross a source line before injecting. Otherwise a trailing comment
  // can swallow the generated trust clauses even though it is absent from the
  // prepared token stream.
  const separator = endsWithDot ? '\n' : '\n. ';
  const rewrittenBody = `${trimmedInner}${separator}${extraClauses.join(' ')}`;
  const rewrittenInner = body.valuesClause
    ? `${body.valuesClause}\n${rewrittenBody}`
    : rewrittenBody;

  const before = sparql.slice(0, bodyStart);
  const after = sparql.slice(braceEnd);
  return {
    kind: 'ready',
    scope: transitionGraphScope(scope, `${before} ${rewrittenInner} ${after}`),
  };
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
  const s = stripSparqlLiteralsAndComments(sparql);
  if (/\bDISTINCT\b/i.test(s)) return true;
  if (/\bORDER\s+BY\b/i.test(s)) return true;
  if (/\bGROUP\s+BY\b/i.test(s)) return true;
  if (/\bHAVING\b/i.test(s)) return true;
  if (/\bLIMIT\b/i.test(s)) return true;
  if (/\bOFFSET\b/i.test(s)) return true;
  if (/\b(COUNT|SUM|AVG|MIN|MAX|SAMPLE|GROUP_CONCAT)\s*\(/i.test(s)) return true;
  return false;
}
