import { createOperationContext, DKG_ONTOLOGY, MemoryLayer, type OperationContext } from '@origintrail-official/dkg-core';
import { contextGraphDataGraphUri, contextGraphMetaGraphUri, contextGraphWorkspaceGraphUri, contextGraphWorkspaceMetaGraphUri } from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { serializeWorkspacePublicSnapshotQuads, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import type { SyncRequestEnvelope } from '../auth/request-build.js';

interface RegisterSyncHandlerParams {
  /**
   * Substrate `register` callable. In production this is bound to
   * `Messenger.register`, so the wrapped handler receives an
   * envelope-unwrapped payload + a string `peerId` and benefits from
   * receiver-side idempotency dedup + envelope versioning (rc.9
   * PR-E migration to `/dkg/10.0.1/sync`).
   *
   * In tests this can be any callable matching the signature; the
   * caller doesn't need to provide a real ProtocolRouter or full
   * Messenger.
   *
   * Before PR-E this was `router: { register }` with a peerId
   * `{ toString(): string }` object — Codex caught that bumping the
   * advertised `/sync` protocol ID without also moving the sender/
   * receiver onto the substrate left the new ID without
   * ReliableEnvelope/dedup/outbox semantics. Migrating the handler
   * here is half of the fix (the other half is the requester-side
   * `sendReliable` swap in dkg-agent.ts:fetchSyncPages).
   */
  register: (
    protocolId: string,
    handler: (data: Uint8Array, peerId: string) => Promise<Uint8Array>,
  ) => void;
  protocolSync: string;
  syncDeniedResponse: string;
  syncPageSize: number;
  sharedMemoryTtlMs: number;
  store: TripleStore;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
  peerId: string;
  parseSyncRequest: (data: Uint8Array) => SyncRequestEnvelope;
  authorizeSyncRequest: (request: SyncRequestEnvelope, remotePeerId: string) => Promise<boolean>;
  logWarn: (ctx: OperationContext, message: string) => void;
  logDebug: (ctx: OperationContext, message: string) => void;
}

export function registerSyncHandler(params: RegisterSyncHandlerParams): void {
  const {
    register,
    protocolSync,
    syncDeniedResponse,
    syncPageSize,
    sharedMemoryTtlMs,
    store,
    publicSnapshotStore,
    parseSyncRequest,
    authorizeSyncRequest,
    logWarn,
    logDebug,
  } = params;

  register(protocolSync, async (data, peerId) => {
    const handlerStartedAt = Date.now();
    const request = parseSyncRequest(data);
    const offset = Math.max(0, Math.min(Number.isSafeInteger(Number(request.offset)) ? Number(request.offset) : 0, 1_000_000));
    const limit = Math.max(1, Math.min(Number.isSafeInteger(Number(request.limit)) ? Number(request.limit) : syncPageSize, syncPageSize));
    const phase = request.phase ?? 'data';
    const isWorkspace = request.includeSharedMemory;
    const contextGraphId = request.contextGraphId;
    if (!contextGraphId || typeof contextGraphId !== 'string') {
      return new TextEncoder().encode('');
    }
    const nquads: string[] = [];

    const authStartedAt = Date.now();
    const authorized = await authorizeSyncRequest(request, peerId);
    const authDurationMs = Date.now() - authStartedAt;
    if (!authorized) {
      logWarn(createOperationContext('sync'), `Denied sync request for "${contextGraphId}" from peer ${peerId} (phase=${phase})`);
      return new TextEncoder().encode(syncDeniedResponse);
    }

    if (isWorkspace) {
      const wsGraph = contextGraphWorkspaceGraphUri(contextGraphId);
      const wsMetaGraph = contextGraphWorkspaceMetaGraphUri(contextGraphId);
      const cutoff = sharedMemoryTtlMs > 0 ? new Date(Date.now() - sharedMemoryTtlMs).toISOString() : null;

      if (phase === 'snapshot') {
        const snapshotRef = request.snapshotRef?.trim();
        if (!snapshotRef || !publicSnapshotStore) {
          return new TextEncoder().encode('');
        }
        const snapshot = await publicSnapshotStore.getSnapshot(snapshotRef);
        if (!snapshot) {
          return new TextEncoder().encode('');
        }
        const page = snapshot.slice(offset, offset + limit);
        if (page.length === 0) {
          return new TextEncoder().encode('');
        }
        nquads.push(serializeWorkspacePublicSnapshotQuads(page).trimEnd());
        logDebug(createOperationContext('sync'), `Sync responder SWM snapshot for "${contextGraphId}" ref=${snapshotRef}: auth=${authDurationMs}ms quads=${page.length}`);
      } else if (phase === 'meta') {
        const metaQuery = cutoff != null
          ? `SELECT ?s ?p ?o WHERE {
              GRAPH <${wsMetaGraph}> { ?s ?p ?o }
              FILTER EXISTS {
                GRAPH <${wsMetaGraph}> {
                  ?s <http://dkg.io/ontology/publishedAt> ?ts .
                  FILTER(?ts >= "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
                }
              }
            } ORDER BY ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`
          : `SELECT ?s ?p ?o WHERE { GRAPH <${wsMetaGraph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`;

        const queryStartedAt = Date.now();
        const metaResult = await store.query(metaQuery);
        const queryDurationMs = Date.now() - queryStartedAt;
        const serializeStartedAt = Date.now();
        if (metaResult.type === 'bindings') {
          for (const b of metaResult.bindings) {
            const obj = b['o'].startsWith('"') ? b['o'] : `<${b['o']}>`;
            nquads.push(`<${b['s']}> <${b['p']}> ${obj} <${wsMetaGraph}> .`);
          }
        }
        const serializeDurationMs = Date.now() - serializeStartedAt;
        logDebug(createOperationContext('sync'), `Sync responder SWM meta for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
      } else {
        const wsQuery = cutoff != null
          ? `SELECT DISTINCT ?s ?p ?o WHERE {
  GRAPH <${wsMetaGraph}> {
    ?op <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://dkg.io/ontology/WorkspaceOperation> .
    ?op <http://dkg.io/ontology/publishedAt> ?ts .
    ?op <http://dkg.io/ontology/rootEntity> ?re .
    FILTER(?ts >= "${cutoff}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
  }
  GRAPH <${wsGraph}> { ?s ?p ?o }
  FILTER(?s = ?re || STRSTARTS(STR(?s), CONCAT(STR(?re), "/.well-known/genid/")))
} ORDER BY ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`
          : `SELECT ?s ?p ?o WHERE { GRAPH <${wsGraph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`;

        const queryStartedAt = Date.now();
        const wsResult = await store.query(wsQuery);
        const queryDurationMs = Date.now() - queryStartedAt;
        if (wsResult.type !== 'bindings' || wsResult.bindings.length === 0) {
          return new TextEncoder().encode('');
        }
        const serializeStartedAt = Date.now();
        for (const b of wsResult.bindings) {
          const obj = b['o'].startsWith('"') ? b['o'] : `<${b['o']}>`;
          nquads.push(`<${b['s']}> <${b['p']}> ${obj} <${wsGraph}> .`);
        }
        const serializeDurationMs = Date.now() - serializeStartedAt;
        logDebug(createOperationContext('sync'), `Sync responder SWM data for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
      }

      if (nquads.length === 0) return new TextEncoder().encode('');
    } else {
      const dataGraph = contextGraphDataGraphUri(contextGraphId);
      const metaGraph = contextGraphMetaGraphUri(contextGraphId);

      if (phase === 'meta') {
        const DKG_NS = 'http://dkg.io/ontology/';
        const cgEntity = `did:dkg:context-graph:${contextGraphId}`;
        const queryStartedAt = Date.now();
        const metaResult = await store.query(
          `SELECT ?s ?p ?o WHERE {
            GRAPH <${metaGraph}> { ?s ?p ?o }
            FILTER(
              STR(?s) = "${cgEntity}" ||
              STRSTARTS(STR(?s), "did:dkg:activity:") ||
              STRSTARTS(STR(?s), "did:dkg:join-request:") ||
              EXISTS {
                GRAPH <${metaGraph}> {
                  ?lc <${DKG_NS}memoryLayer> ?layer .
                  FILTER(?layer != "${MemoryLayer.WorkingMemory}")
                  {
                    FILTER(?lc = ?s)
                  } UNION {
                    ?lc <${DKG_NS}assertionGraph> ?s .
                  } UNION {
                    ?lc <${DKG_NS}assertionName> ?aname .
                    FILTER(
                      CONTAINS(STR(?s), "/assertion/") &&
                      STRENDS(STR(?s), CONCAT("/", STR(?aname)))
                    )
                  }
                }
              } ||
              EXISTS {
                GRAPH <${metaGraph}> {
                  { ?evt_src <http://www.w3.org/ns/prov#generated> ?parent }
                  UNION
                  { ?evt_src <http://www.w3.org/ns/prov#used> ?parent }
                  FILTER(?evt_src = ?s)
                  ?parent <${DKG_NS}memoryLayer> ?elayer .
                  FILTER(?elayer != "${MemoryLayer.WorkingMemory}")
                }
              }
            )
          } ORDER BY ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`,
        );
        const queryDurationMs = Date.now() - queryStartedAt;
        const serializeStartedAt = Date.now();
        if (metaResult.type === 'bindings') {
          for (const b of metaResult.bindings) {
            const obj = b['o'].startsWith('"') ? b['o'] : `<${b['o']}>`;
            nquads.push(`<${b['s']}> <${b['p']}> ${obj} <${metaGraph}> .`);
          }
        }
        const serializeDurationMs = Date.now() - serializeStartedAt;
        logDebug(createOperationContext('sync'), `Sync responder durable meta for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
      } else {
        const cgUriPrefix = `did:dkg:context-graph:${contextGraphId}`;
        const innerMetaGraph = `${cgUriPrefix}/_meta`;
        const DKG_NS = 'http://dkg.io/ontology/';
        // Exclude only the TOP-LEVEL `${cgUriPrefix}/_meta` graph (handled by the
        // 'meta' phase above). Per-cgId meta graphs like
        // `${cgUriPrefix}/context/<cgId>/_meta` MUST be sent by the data phase —
        // they carry KC metadata (merkleRoot, batchId, tokenId, partOf,
        // publication, ...) that the RS prover's kc-extractor.ts queries to
        // resolve a challenge into a concrete chunk. The previous
        // `!STRENDS(?g, "/_meta")` filter dropped them on the floor, so
        // non-publisher peers received the per-cgId data but no per-cgId meta
        // and emitted `kc-not-synced` for every challenge they were assigned
        // against KCs they hadn't published themselves.
        const queryStartedAt = Date.now();
        const dataResult = await store.query(
          `SELECT ?s ?p ?o ?g WHERE {
            GRAPH ?g { ?s ?p ?o }
            FILTER(
              (STR(?g) = "${cgUriPrefix}" || STRSTARTS(STR(?g), "${cgUriPrefix}/")) &&
              STR(?g) != "${innerMetaGraph}" &&
              !CONTAINS(STR(?g), "/_private")
            )
            FILTER(
              !CONTAINS(STR(?g), "/assertion/") ||
              EXISTS {
                GRAPH <${innerMetaGraph}> {
                  ?lifecycle <${DKG_NS}assertionGraph> ?g .
                  ?lifecycle <${DKG_NS}memoryLayer> ?layer .
                  FILTER(?layer != "${MemoryLayer.WorkingMemory}")
                }
              }
            )
          } ORDER BY ?g ?s ?p ?o OFFSET ${offset} LIMIT ${limit}`,
        );
        const queryDurationMs = Date.now() - queryStartedAt;
        if (dataResult.type !== 'bindings' || dataResult.bindings.length === 0) {
          return new TextEncoder().encode('');
        }
        const serializeStartedAt = Date.now();
        for (const b of dataResult.bindings) {
          const obj = b['o'].startsWith('"') ? b['o'] : `<${b['o']}>`;
          const graph = b['g'] ?? dataGraph;
          nquads.push(`<${b['s']}> <${b['p']}> ${obj} <${graph}> .`);
        }
        const serializeDurationMs = Date.now() - serializeStartedAt;
        logDebug(createOperationContext('sync'), `Sync responder durable data for "${contextGraphId}": auth=${authDurationMs}ms query=${queryDurationMs}ms serialize=${serializeDurationMs}ms`);
      }
    }

    const totalDurationMs = Date.now() - handlerStartedAt;
    if (totalDurationMs > 100) {
      logDebug(createOperationContext('sync'), `Sync responder total for "${contextGraphId}" (phase=${phase}, workspace=${isWorkspace}): ${totalDurationMs}ms`);
    }
    return new TextEncoder().encode(nquads.join('\n'));
  });
}
