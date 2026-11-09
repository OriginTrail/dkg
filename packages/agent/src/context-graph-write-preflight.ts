import { ethers } from 'ethers';
import { DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS, contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { ContextGraphSub, ContextGraphSubscriptionStore, ContextGraphWritePreflightProbe } from './dkg-agent-types.js';
import { strip, stripLiteral } from './dkg-agent-utils.js';
import { agentsGraphMayState, ontologyGraphMayState } from './context-graph-meta-sources.js';
import { classifyWritePreflightFailure, type WritePreflightFailure, type WritePreflightFailureSite } from './write-preflight-attribution.js';

/** Read-only dependencies of this point probe; the agent mixin remains its adapter. */
export interface WritePreflightHost {
  readonly store: Pick<TripleStore, 'query'>;
  contextGraphExists(contextGraphId: string): Promise<boolean>;
  contextGraphHasLocalContent(contextGraphId: string): Promise<boolean>;
  curatorDidMatchesChecksumAgent(curator: string, checksumAddress: string): boolean;
  callerIsAllowlistedAgentParticipant(
    contextGraphId: string,
    checksumAddress: string,
    options?: { onChainLookup?: () => void },
  ): Promise<boolean>;
}

/** What a probe call may carry besides the context graph id. */
export interface WritePreflightProbeOptions {
  callerAgentAddress?: string | null;
  /** Daemon writability checks may omit content discovery when fresh facts suffice.
   * Full probes remain the default; omitted content is unknown, not false. */
  contentCheck?: 'always' | 'when-needed-for-write';
  /**
   * Called when the caller's authorization consulted the chain (an on-chain identity-ID entry of
   * the allowlist). Such an answer can change without any local write, so a result cache must not keep it.
   */
  onChainLookup?: () => void;
}

/**
 * The checksum address a probe judges the caller by, or null when the call names no usable caller
 * (a `did:dkg:agent:` prefix is dropped; a string that is not an address names nobody). Two calls for the
 * same context graph with equal results here get equal probe results.
 */
export function normalizeWritePreflightCaller(callerAgentAddress: string | null | undefined): string | null {
  const rawCaller = callerAgentAddress?.trim();
  if (!rawCaller) return null;
  const didPrefix = 'did:dkg:agent:';
  const rawAddress = rawCaller.startsWith(didPrefix) ? rawCaller.slice(didPrefix.length) : rawCaller;
  return ethers.isAddress(rawAddress) ? ethers.getAddress(rawAddress) : null;
}

/** The predicate each kind of declaration row reads; a gate row reads the graph's own `_meta` only. */
const DECLARATION_ROW_PREDICATES: Readonly<Partial<Record<string, string>>> = {
  declared: DKG_ONTOLOGY.RDF_TYPE,
  access: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
  curator: DKG_ONTOLOGY.DKG_CURATOR,
};

interface WritePreflightSubscriptions {
  readonly locallyCreated?: boolean;
  readonly store?: Pick<ContextGraphSubscriptionStore, 'load'>;
  readonly current: (contextGraphId: string) => Pick<ContextGraphSub, 'subscribed' | 'synced'> | undefined;
}

export async function probeContextGraphWritePreflight(
    host: WritePreflightHost,
    subscriptions: WritePreflightSubscriptions,
    contextGraphId: string,
    opts?: WritePreflightProbeOptions,
  ): Promise<ContextGraphWritePreflightProbe> {
    const contextGraphUri = `did:dkg:context-graph:${contextGraphId}`;
    const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
    const agentsGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.AGENTS);
    const cgMetaGraph = contextGraphMetaGraphUri(contextGraphId);
    const metaSubjectUri = contextGraphDataGraphUri(contextGraphId);
    const subscriptionStore = subscriptions.store;

    const persistedSubscriptionPromise = subscriptionStore?.load
      ? subscriptionStore.load(contextGraphId)
      : Promise.resolve(null);
    // One bounded point projection over the three metadata sources.
    // Facts are intentionally collected independently: the established
    // ContextGraphMetaProjection model permits the declaration to live in one
    // source and policy/curator/gates in another. Requiring every source to
    // repeat rdf:type would both reject valid gate-only graphs and, worse,
    // ignore a cross-source private-policy ratchet. As in that projection, the
    // gates come from the graph's own `_meta`, and the rows of a shared graph pass
    // the projection's source rules, applied below. Gate presence uses EXISTS so
    // this path returns at most one gate row per source instead of expanding a
    // potentially large allowlist.
    const declarationPromise = host.store.query(`
      SELECT ?kind ?value ?sourceGraph WHERE {
        VALUES (?sourceGraph ?sourceSubject) {
          (<${ontologyGraph}> <${contextGraphUri}>)
          (<${agentsGraph}> <${contextGraphUri}>)
          (<${cgMetaGraph}> <${metaSubjectUri}>)
        }
        {
          GRAPH ?sourceGraph {
            ?sourceSubject <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
          }
          BIND("declared" AS ?kind)
        } UNION {
          GRAPH ?sourceGraph {
            ?sourceSubject <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?value .
          }
          BIND("access" AS ?kind)
        } UNION {
          GRAPH ?sourceGraph {
            ?sourceSubject <${DKG_ONTOLOGY.DKG_CURATOR}> ?value .
          }
          BIND("curator" AS ?kind)
        } UNION {
          FILTER EXISTS {
            VALUES ?gatePredicate {
              <${DKG_ONTOLOGY.DKG_ALLOWED_AGENT}>
              <${DKG_ONTOLOGY.DKG_ALLOWED_PEER}>
              <${DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT}>
              <${DKG_ONTOLOGY.DKG_PARTICIPANT_IDENTITY_ID}>
            }
            GRAPH <${cgMetaGraph}> {
              <${metaSubjectUri}> ?gatePredicate ?gateValue .
            }
          }
          BIND("gate" AS ?kind)
        }
      }
    `, { source: 'agent.writePreflight.declaration' });

    // Track B (write-preflight resilience): these four reads were previously
    // combined with `Promise.all`, so a single failing store read (slow-store
    // abort timeout, "the store is closed" after an Oxigraph worker crash)
    // threw the WHOLE probe away — including the in-memory subscription
    // snapshot below, which needs zero store I/O. The daemon's write
    // preflight was then left with no evidence at all and 503'd every write
    // until the store recovered. Settle each read individually instead:
    // store-derived fields degrade to `undefined` (UNKNOWN — never a
    // definitive deny) and `storeUnavailable` carries the first failure
    // message for diagnostics, while the in-memory registry state always
    // survives.
    // The daemon can defer the content read until authorization and the
    // final subscription snapshot establish whether it is needed at all.
    const deferContent = opts?.contentCheck === 'when-needed-for-write';
    const [existsRead, hasLocalContentRead, persistedSubscriptionRead, declarationRead] =
      await Promise.allSettled([
        host.contextGraphExists(contextGraphId),
        deferContent ? Promise.resolve(undefined) : host.contextGraphHasLocalContent(contextGraphId),
        persistedSubscriptionPromise,
        declarationPromise,
      ]);

    let storeUnavailable = false;
    let storeErrorMessage: string | undefined;
    const failureAttribution: WritePreflightFailure[] = [];
    const noteStoreFailure = (site: WritePreflightFailureSite, reason: unknown): undefined => {
      failureAttribution.push({ site, kind: classifyWritePreflightFailure(reason) });
      storeUnavailable = true;
      if (storeErrorMessage === undefined) {
        storeErrorMessage = reason instanceof Error ? reason.message : String(reason);
      }
      return undefined;
    };
    const exists = existsRead.status === 'fulfilled'
      ? existsRead.value
      : noteStoreFailure('existence', existsRead.reason);
    let hasLocalContent = hasLocalContentRead.status === 'fulfilled'
      ? hasLocalContentRead.value
      : noteStoreFailure('content', hasLocalContentRead.reason);
    const persistedSubscription = persistedSubscriptionRead.status === 'fulfilled'
      ? persistedSubscriptionRead.value
      : noteStoreFailure('subscription', persistedSubscriptionRead.reason);
    const declarationResult = declarationRead.status === 'fulfilled'
      ? declarationRead.value
      : noteStoreFailure('declaration', declarationRead.reason);

    let accessPolicy: 'public' | 'private' | undefined;
    // Tri-state: stays `undefined` (unknown) when the metadata projection read
    // failed, so a store outage can never masquerade as "no declaration".
    let declarationFound: boolean | undefined = declarationResult === undefined ? undefined : false;
    const curators: string[] = [];
    const sourceMayState = (sourceGraph: string | undefined, kind: string, value: string | undefined): boolean => {
      const predicate = DECLARATION_ROW_PREDICATES[kind];
      if (predicate === undefined) return true;
      const source = typeof sourceGraph === 'string' ? strip(sourceGraph) : undefined;
      if (source === cgMetaGraph) return true;
      if (source === ontologyGraph) return ontologyGraphMayState(predicate);
      // The agents graph, and any source this query does not name, as strictly.
      return agentsGraphMayState(predicate, typeof value === 'string' ? stripLiteral(strip(value)) : '');
    };
    if (declarationResult && declarationResult.type === 'bindings') {
      let sawPublic = false;
      let sawPrivate = false;
      let sawGate = false;
      for (const row of declarationResult.bindings as Record<string, string>[]) {
        const kind = typeof row['kind'] === 'string'
          ? stripLiteral(row['kind']).trim().toLowerCase()
          : '';
        const value = row['value'];
        if (!sourceMayState(row['sourceGraph'], kind, value)) continue;
        if (kind === 'declared') declarationFound = true;
        if (kind === 'access' && typeof value === 'string') {
          const normalized = stripLiteral(value).trim().toLowerCase();
          if (normalized === 'private') sawPrivate = true;
          if (normalized === 'public') sawPublic = true;
        }
        if (kind === 'curator' && typeof value === 'string' && value.trim()) {
          curators.push(value);
        }
        if (kind === 'gate') sawGate = true;
      }
      if (sawPrivate) accessPolicy = 'private';
      else if (sawPublic) accessPolicy = 'public';
      // Match list/projection semantics: an explicit public policy wins, but
      // legacy/implicit allowlist gates make a graph private when no policy
      // literal exists. This is a bounded point query for one canonical id.
      else if (sawGate) accessPolicy = 'private';
    }

    const checksum = normalizeWritePreflightCaller(opts?.callerAgentAddress);

    let callerAuthorized: boolean | undefined;
    if (checksum && declarationFound) {
      if (accessPolicy === 'public') {
        callerAuthorized = true;
      } else if (accessPolicy === 'private') {
        const curatorMatch = curators.some((curator) =>
          host.curatorDidMatchesChecksumAgent(curator, checksum),
        );
        if (curatorMatch) {
          callerAuthorized = true;
        } else {
          // The allowlist lookup is a store read too — the store can die
          // between the settled reads above and here. Leave authorization
          // UNKNOWN (never a deny) and flag the store instead of throwing
          // the whole probe away.
          try {
            callerAuthorized = opts?.onChainLookup
              ? await host.callerIsAllowlistedAgentParticipant(contextGraphId, checksum, { onChainLookup: opts.onChainLookup })
              : await host.callerIsAllowlistedAgentParticipant(contextGraphId, checksum);
          } catch (err) {
            noteStoreFailure('caller-access', err);
          }
        }
      }
    }

    let inMemorySubscription = subscriptions.current(contextGraphId);
    // Authorization may have awaited an allowlist/chain read. Decide only
    // from the subscription that exists now, not a snapshot from probe start.
    // These are the exact positive facts the daemon needs for a synced graph;
    // content cannot add writability evidence in this case.
    const contentIsRedundant = !storeUnavailable && exists === true && declarationFound === true
      && accessPolicy !== undefined && (!checksum || callerAuthorized === true)
      && inMemorySubscription?.subscribed === true && inMemorySubscription.synced === true;
    if (deferContent && !contentIsRedundant) {
      try {
        hasLocalContent = await host.contextGraphHasLocalContent(contextGraphId);
      } catch (err) {
        noteStoreFailure('content', err);
      }
      inMemorySubscription = subscriptions.current(contextGraphId);
    }
    // No await between deciding to omit content and copying this snapshot.

    return {
      // Required typed boundary: `storeAvailable` is the inverse of
      // `storeUnavailable`, emitted unconditionally so consumers cannot read
      // any store-derived fact below without first establishing the store was
      // up for every attempted read. The writability mode can omit a
      // redundant content read; it never suppresses an attempted read failure.
      // The optional `storeUnavailable`/`storeErrorMessage` pair is kept
      // for the 503-diagnostics path (unchanged wire behaviour).
      storeAvailable: !storeUnavailable,
      locallyCreated: subscriptions.locallyCreated === true,
      ...(exists !== undefined ? { exists } : {}),
      ...(hasLocalContent !== undefined ? { hasLocalContent } : {}),
      ...(inMemorySubscription
        ? { inMemorySubscription: {
            subscribed: inMemorySubscription.subscribed,
            synced: inMemorySubscription.synced,
          } }
        : {}),
      ...(persistedSubscription
        ? { persistedSubscription: {
            subscribed: persistedSubscription.subscribed,
            synced: persistedSubscription.synced,
          } }
        : {}),
      ...(declarationFound !== undefined ? { declarationFound } : {}),
      ...(accessPolicy ? { accessPolicy } : {}),
      ...(curators[0] ? { curator: curators[0] } : {}),
      ...(callerAuthorized !== undefined ? { callerAuthorized } : {}),
      ...(storeUnavailable
        ? {
            storeUnavailable: true,
            failureAttribution,
            ...(storeErrorMessage !== undefined ? { storeErrorMessage } : {}),
          }
        : {}),
    };
  }
