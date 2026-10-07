import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  sparqlString,
} from '@origintrail-official/dkg-core';
import { WORKSPACE_RECIPIENT_DEPENDENCIES } from './workspace-recipient-dependencies.js';
import { stripRdfLiteral } from './workspace-recipient-key-verification.js';

import { COMPLETE_KEY_ROW_LIMIT, COMPLETE_ROUTE_ROW_LIMIT, type PublicKeyRoute } from './workspace-recipient-key-candidates.js';

const { keyRoute: KEY_ROUTE } = WORKSPACE_RECIPIENT_DEPENDENCIES;

export interface WorkspaceAgentKeyEvidence {
  readonly completeness: 'complete' | 'incomplete';
  readonly keys: readonly string[];
  readonly proofs: readonly string[];
  readonly routes: readonly PublicKeyRoute[];
}

/** Retrieval only: saturated or structurally inconsistent evidence needs paging. */
export async function collectWorkspaceAgentKeyEvidence(
  store: TripleStore, agentUriValues: string, graphFilter: string,
): Promise<WorkspaceAgentKeyEvidence> {
  const result = await store.query(`SELECT ?kind ?key ?proof ?peerId WHERE {
    {
      { SELECT DISTINCT ?key WHERE {
        VALUES ?agentSubject { ${agentUriValues} }
        GRAPH ?g { ?agentSubject <${KEY_ROUTE.publicKey}> ?rawKey }
        BIND(STR(?rawKey) AS ?key) ${graphFilter}
      } LIMIT ${COMPLETE_KEY_ROW_LIMIT} }
      BIND("key" AS ?kind)
    } UNION {
      { SELECT DISTINCT ?proof WHERE {
        VALUES ?agentSubject { ${agentUriValues} }
        GRAPH ?g { ?agentSubject <${KEY_ROUTE.proof}> ?rawProof }
        BIND(STR(?rawProof) AS ?proof) ${graphFilter}
      } LIMIT ${COMPLETE_KEY_ROW_LIMIT} }
      BIND("proof" AS ?kind)
    } UNION {
      { SELECT DISTINCT ?key ?peerId WHERE {
        VALUES ?agentSubject { ${agentUriValues} }
        GRAPH ?g {
          ?agentSubject <${KEY_ROUTE.publicKey}> ?rawKey ;
            <${KEY_ROUTE.algorithm}> ${sparqlString(WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519)} .
          OPTIONAL { ?agentSubject <${KEY_ROUTE.peerId}> ?peerId }
        }
        BIND(STR(?rawKey) AS ?key) ${graphFilter}
      } LIMIT ${COMPLETE_ROUTE_ROW_LIMIT} }
      BIND("route" AS ?kind)
    }
  }`, { source: 'publisher.workspaceRecipients.completeKeyCollect' });
  if (result.type !== 'bindings') return { completeness: 'incomplete', keys: [], proofs: [], routes: [] };
  const keys: string[] = [];
  const proofs: string[] = [];
  const routes: PublicKeyRoute[] = [];
  const incomplete = (): WorkspaceAgentKeyEvidence => ({ completeness: 'incomplete', keys, proofs, routes });
  for (const row of result.bindings) {
    if (typeof row['kind'] !== 'string') return incomplete();
    const kind = stripRdfLiteral(row['kind']);
    if (kind === 'key' && typeof row['key'] === 'string') keys.push(stripRdfLiteral(row['key']));
    else if (kind === 'proof' && typeof row['proof'] === 'string') proofs.push(stripRdfLiteral(row['proof']));
    else if (kind === 'route' && typeof row['key'] === 'string'
      && (row['peerId'] === undefined || typeof row['peerId'] === 'string')) {
      routes.push({ key: stripRdfLiteral(row['key']), peerId: row['peerId'] === undefined ? undefined : stripRdfLiteral(row['peerId']) });
    } else return incomplete();
  }
  if (keys.length >= COMPLETE_KEY_ROW_LIMIT || proofs.length >= COMPLETE_KEY_ROW_LIMIT || routes.length >= COMPLETE_ROUTE_ROW_LIMIT) return incomplete();
  const keySet = new Set(keys);
  if (routes.some((route) => !keySet.has(route.key))) return incomplete();
  return { completeness: 'complete', keys, proofs, routes };
}
