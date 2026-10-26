import { ethers } from 'ethers';
import { DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS, contextGraphDataGraphUri, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { ContextGraphSub, ContextGraphSubscriptionStore, ContextGraphWritePreflightProbe } from './dkg-agent-types.js';
import { stripLiteral } from './dkg-agent-utils.js';
import { classifyWritePreflightFailure, type WritePreflightFailure, type WritePreflightFailureSite } from './write-preflight-attribution.js';

/** Read-only dependencies of this point probe; the agent mixin remains its adapter. */
export interface WritePreflightHost {
  readonly store: Pick<TripleStore, 'query'>;
  contextGraphExists(contextGraphId: string): Promise<boolean>;
  contextGraphHasLocalContent(contextGraphId: string): Promise<boolean>;
  curatorDidMatchesChecksumAgent(curator: string, checksumAddress: string): boolean;
  callerIsAllowlistedAgentParticipant(contextGraphId: string, checksumAddress: string): Promise<boolean>;
}

interface WritePreflightSubscriptions {
  readonly store?: Pick<ContextGraphSubscriptionStore, 'load'>;
  readonly current: (contextGraphId: string) => Pick<ContextGraphSub, 'subscribed' | 'synced'> | undefined;
}

export async function probeContextGraphWritePreflight(
    host: WritePreflightHost,
    subscriptions: WritePreflightSubscriptions,
    contextGraphId: string,
    opts?: { callerAgentAddress?: string | null },
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
    // One bounded point projection over the three trusted metadata sources.
    // Facts are intentionally collected independently: the established
    // ContextGraphMetaProjection model permits the declaration to live in one
    // source and policy/curator/gates in another. Requiring every source to
    // repeat rdf:type would both reject valid gate-only graphs and, worse,
    // ignore a cross-source private-policy ratchet. Gate presence uses EXISTS
    // so this path returns at most one gate row per source instead of expanding
    // a potentially large allowlist.
    const declarationPromise = host.store.query(`
      SELECT ?kind ?value WHERE {
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
            GRAPH ?sourceGraph {
              ?sourceSubject ?gatePredicate ?gateValue .
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
    const [existsRead, hasLocalContentRead, persistedSubscriptionRead, declarationRead] =
      await Promise.allSettled([
        host.contextGraphExists(contextGraphId),
        host.contextGraphHasLocalContent(contextGraphId),
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
    const hasLocalContent = hasLocalContentRead.status === 'fulfilled'
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
    if (declarationResult && declarationResult.type === 'bindings') {
      let sawPublic = false;
      let sawPrivate = false;
      let sawGate = false;
      for (const row of declarationResult.bindings as Record<string, string>[]) {
        const kind = typeof row['kind'] === 'string'
          ? stripLiteral(row['kind']).trim().toLowerCase()
          : '';
        const value = row['value'];
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

    let checksum: string | null = null;
    const rawCaller = opts?.callerAgentAddress?.trim();
    if (rawCaller) {
      const didPrefix = 'did:dkg:agent:';
      const rawAddress = rawCaller.startsWith(didPrefix) ? rawCaller.slice(didPrefix.length) : rawCaller;
      if (ethers.isAddress(rawAddress)) checksum = ethers.getAddress(rawAddress);
    }

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
            callerAuthorized = await host.callerIsAllowlistedAgentParticipant(contextGraphId, checksum);
          } catch (err) {
            noteStoreFailure('caller-access', err);
          }
        }
      }
    }

    const inMemorySubscription = subscriptions.current(contextGraphId);
    return {
      // Required typed boundary: `storeAvailable` is the inverse of
      // `storeUnavailable`, emitted unconditionally so consumers cannot read
      // any store-derived fact below without first establishing the store was
      // up. The optional `storeUnavailable`/`storeErrorMessage` pair is kept
      // for the 503-diagnostics path (unchanged wire behaviour).
      storeAvailable: !storeUnavailable,
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
