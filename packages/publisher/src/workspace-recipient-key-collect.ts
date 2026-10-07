import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  sparqlString,
} from '@origintrail-official/dkg-core';
import type { WorkspaceAgentRecipient } from './workspace-agent-recipients.js';
import { WORKSPACE_RECIPIENT_DEPENDENCIES } from './workspace-recipient-dependencies.js';
import { loadVerifiedRevokedKeyIds, stripRdfLiteral } from './workspace-recipient-key-verification.js';

import { decodePublicKeyCandidate, candidateRecipient, candidateHasProof, projectPublicKeyRoutes,
  COMPLETE_KEY_ROW_LIMIT, COMPLETE_ROUTE_ROW_LIMIT, type PublicKeyRoute } from './workspace-recipient-key-candidates.js';

const { keyRoute: KEY_ROUTE } = WORKSPACE_RECIPIENT_DEPENDENCIES;

/** Complete bounded positive snapshot followed by a fresh global revocation read.
 * null means the existing paged collect must decide; no truncated result escapes.
 */
export async function collectCompleteWorkspaceAgentKeys(
  store: TripleStore, checksum: string, agentUri: string, agentUriValues: string,
  graphFilter: string, requiredPeerId?: string,
): Promise<WorkspaceAgentRecipient[] | null> {
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
  if (result.type !== 'bindings') return null;
  const keys: string[] = [];
  const proofs: string[] = [];
  const routes: PublicKeyRoute[] = [];
  for (const row of result.bindings) {
    if (typeof row['kind'] !== 'string') return null;
    const kind = stripRdfLiteral(row['kind']);
    if (kind === 'key' && typeof row['key'] === 'string') keys.push(stripRdfLiteral(row['key']));
    else if (kind === 'proof' && typeof row['proof'] === 'string') proofs.push(stripRdfLiteral(row['proof']));
    else if (kind === 'route' && typeof row['key'] === 'string'
      && (row['peerId'] === undefined || typeof row['peerId'] === 'string')) {
      routes.push({ key: stripRdfLiteral(row['key']), peerId: row['peerId'] === undefined ? undefined : stripRdfLiteral(row['peerId']) });
    } else return null;
  }
  if (keys.length === 0 || keys.length >= COMPLETE_KEY_ROW_LIMIT || proofs.length >= COMPLETE_KEY_ROW_LIMIT || routes.length >= COMPLETE_ROUTE_ROW_LIMIT) return null;
  const keySet = new Set(keys);
  if (routes.some((route) => !keySet.has(route.key))) return null;
  const candidates = keys.flatMap((key) => {
    const candidate = decodePublicKeyCandidate(checksum, key);
    return candidate ? [candidate] : [];
  });
  if (candidates.length === 0) return null;
  // This is the final store read on a successful collect. Proof and route policy below is synchronous.
  const revoked = await loadVerifiedRevokedKeyIds(store, checksum, candidates.map((candidate) => candidateRecipient(candidate, checksum, agentUri)), graphFilter);
  const verified = candidates.filter((candidate) => !revoked.has(candidate.recipientKeyId)
    && proofs.some((proof) => candidateHasProof(candidate, checksum, proof)));
  const variants = projectPublicKeyRoutes(checksum, agentUri, verified, routes, requiredPeerId);
  const recipients = [...variants.values()].flatMap((peers) => [...peers.values()]);
  return recipients.length === 0 ? null : recipients;
}
