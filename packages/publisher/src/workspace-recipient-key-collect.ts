import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE,
  decodeWorkspaceEncryptionKey, encodeWorkspaceEncryptionKey, workspaceAgentEncryptionKeyId, sparqlString,
} from '@origintrail-official/dkg-core';
import type { WorkspaceAgentRecipient } from './workspace-agent-recipients.js';
import { WORKSPACE_RECIPIENT_DEPENDENCIES } from './workspace-recipient-dependencies.js';
import { loadVerifiedRevokedKeyIds, stripRdfLiteral, verifyAgentEncryptionKeyProof } from './workspace-recipient-key-verification.js';

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
      } LIMIT 65 }
      BIND("key" AS ?kind)
    } UNION {
      { SELECT DISTINCT ?proof WHERE {
        VALUES ?agentSubject { ${agentUriValues} }
        GRAPH ?g { ?agentSubject <${KEY_ROUTE.proof}> ?rawProof }
        BIND(STR(?rawProof) AS ?proof) ${graphFilter}
      } LIMIT 65 }
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
      } LIMIT 129 }
      BIND("route" AS ?kind)
    }
  }`, { source: 'publisher.workspaceRecipients.completeKeyCollect' });
  if (result.type !== 'bindings') return null;
  const keys: string[] = [];
  const proofs: string[] = [];
  const routes: Array<{ key: string; peerId?: string }> = [];
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
  if (keys.length === 0 || keys.length >= 65 || proofs.length >= 65 || routes.length >= 129) return null;
  const keySet = new Set(keys);
  if (routes.some((route) => !keySet.has(route.key))) return null;
  const candidates = new Map<string, WorkspaceAgentRecipient>();
  for (const key of keys) {
    try {
      const publicKeyBytes = decodeWorkspaceEncryptionKey(key);
      if (encodeWorkspaceEncryptionKey(publicKeyBytes) !== key) continue;
      candidates.set(key, {
        purpose: WORKSPACE_RECIPIENT_ENCRYPTION_KEY_PURPOSE, recipientId: agentUri,
        recipientKeyId: workspaceAgentEncryptionKeyId(checksum, publicKeyBytes),
        encryptionKeyAlgorithm: WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
        publicKeyBytes, agentAddress: checksum,
      });
    } catch { /* The paged path retains its exact malformed-candidate behavior. */ }
  }
  if (candidates.size === 0) return null;
  // This is the final store read of a successful collect. Wallet verification
  // and fanout construction below are synchronous; revocations are never memoized here.
  const revoked = await loadVerifiedRevokedKeyIds(store, checksum, [...candidates.values()], graphFilter);
  const verified = new Map<string, WorkspaceAgentRecipient>();
  for (const [key, candidate] of candidates) {
    if (revoked.has(candidate.recipientKeyId)) continue;
    if (proofs.some((proof) => verifyAgentEncryptionKeyProof(checksum, candidate.publicKeyBytes!, proof))) {
      verified.set(key, candidate);
    }
  }
  const variants = new Map<string, Map<string | undefined, WorkspaceAgentRecipient>>();
  for (const route of routes) {
    const candidate = verified.get(route.key);
    if (!candidate) continue;
    if (requiredPeerId !== undefined && route.peerId !== requiredPeerId) {
      throw new Error(`Public encryption key for DKG agent ${checksum} is not bound to the required peer`);
    }
    let peers = variants.get(candidate.recipientKeyId);
    if (!peers) { peers = new Map(); variants.set(candidate.recipientKeyId, peers); }
    if (route.peerId === undefined) {
      if (peers.size === 0) peers.set(undefined, candidate);
    } else {
      peers.delete(undefined);
      peers.set(route.peerId, { ...candidate, peerId: route.peerId });
    }
  }
  const recipients = [...variants.values()].flatMap((peers) => [...peers.values()]);
  if (recipients.length === 0) return null;
  if (recipients.length > 64) throw new Error(`Too many public encryption-key candidates for DKG agent ${checksum}`);
  return recipients;
}
