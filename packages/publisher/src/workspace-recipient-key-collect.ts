import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519,
  sparqlString,
} from '@origintrail-official/dkg-core';
import { WORKSPACE_RECIPIENT_DEPENDENCIES } from './workspace-recipient-dependencies.js';
import { loadVerifiedRevokedKeyIds, stringBinding, stripRdfLiteral, type EncryptionKeyMaterial } from './workspace-recipient-key-verification.js';

import { COMPLETE_KEY_ROW_LIMIT, COMPLETE_ROUTE_ROW_LIMIT, type PublicKeyRoute, type PublicKeyCandidate, RECIPIENT_KEY_HISTORY_PAGE_SIZE, RECIPIENT_KEY_CANDIDATE_LIMIT } from './workspace-recipient-key-candidates.js';

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

/** Normalized retrieval source; validation never sees query bindings or paging cursors. */
export interface WorkspaceAgentKeySource {
  keyPages(): AsyncIterable<readonly string[]>;
  proofPages(): AsyncIterable<readonly string[]>;
  readRetirements(candidates: readonly EncryptionKeyMaterial[]): Promise<Set<string>>;
  routes(candidates: readonly PublicKeyCandidate[]): Promise<readonly PublicKeyRoute[]>;
  hasUnsupportedAlgorithm(candidates: readonly PublicKeyCandidate[]): Promise<boolean>;
  finalRevocations(candidates: readonly EncryptionKeyMaterial[]): Promise<Set<string>>;
}

async function* onePage(values: readonly string[]): AsyncIterable<readonly string[]> {
  if (values.length > 0) yield values;
}

async function* keysetPages(
  store: TripleStore, checksum: string, agentUriValues: string, graphFilter: string,
  column: 'key' | 'proof', predicate: string,
): AsyncIterable<readonly string[]> {
  let cursor: string | undefined;
  while (true) {
    const cursorFilter = cursor === undefined ? '' : `FILTER (?${column} > ${sparqlString(cursor)})`;
    const page = await store.query(`SELECT DISTINCT ?${column} WHERE {
      VALUES ?agentSubject { ${agentUriValues} }
      GRAPH ?g { ?agentSubject <${predicate}> ?rawValue }
      BIND (STR(?rawValue) AS ?${column})
      ${graphFilter} ${cursorFilter}
    } ORDER BY ?${column} LIMIT ${RECIPIENT_KEY_HISTORY_PAGE_SIZE}`);
    if (page.type !== 'bindings' || page.bindings.length === 0) return;
    const values = page.bindings.flatMap((row) => {
      const value = stringBinding(row[column]);
      if (value === undefined && column === 'proof') return [];
      return [value === undefined ? '' : stripRdfLiteral(value)];
    });
    yield values;
    const lastValue = stringBinding(page.bindings.at(-1)?.[column]);
    const nextCursor = lastValue === undefined ? undefined : stripRdfLiteral(lastValue);
    if (!nextCursor || (cursor !== undefined && nextCursor <= cursor)) {
      throw new Error(`Non-monotonic public encryption-key ${column === 'proof' ? 'proof ' : ''}history for DKG agent ${checksum}`);
    }
    cursor = nextCursor;
    if (page.bindings.length < RECIPIENT_KEY_HISTORY_PAGE_SIZE) return;
  }
}

/** Select bounded or paged retrieval once, retaining the final fresh-read policy of each. */
export async function createWorkspaceAgentKeySource(
  store: TripleStore, checksum: string, agentUriValues: string, graphFilter: string,
): Promise<WorkspaceAgentKeySource> {
  const evidence = await collectWorkspaceAgentKeyEvidence(store, agentUriValues, graphFilter);
  const readRevocations = (candidates: readonly EncryptionKeyMaterial[]) =>
    loadVerifiedRevokedKeyIds(store, checksum, candidates, graphFilter);
  const hasUnsupportedAlgorithm = async (candidates: readonly PublicKeyCandidate[]): Promise<boolean> => {
    const result = await store.query(`ASK {
      VALUES ?agentSubject { ${agentUriValues} }
      VALUES ?key { ${candidates.map((candidate) => sparqlString(candidate.encodedPublicKey)).join(' ')} }
      GRAPH ?g { ?agentSubject <${KEY_ROUTE.publicKey}> ?rawKey ; <${KEY_ROUTE.algorithm}> ?algorithm }
      ${graphFilter}
      FILTER (STR(?rawKey) = ?key && STR(?algorithm) != ${sparqlString(WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519)})
    }`);
    return result.type === 'boolean' && result.value;
  };
  if (evidence.completeness === 'complete') {
    let freshRevocations = new Set<string>();
    return {
      keyPages: () => onePage(evidence.keys),
      proofPages: () => onePage(evidence.proofs),
      readRetirements: async (candidates) => {
        // All positive evidence was read together; this is the last store read on success.
        freshRevocations = await readRevocations(candidates);
        return freshRevocations;
      },
      routes: async (candidates) => {
        const keys = new Set(candidates.map((candidate) => candidate.encodedPublicKey));
        return evidence.routes.filter((route) => keys.has(route.key));
      },
      hasUnsupportedAlgorithm,
      finalRevocations: async () => freshRevocations,
    };
  }
  return {
    keyPages: () => keysetPages(store, checksum, agentUriValues, graphFilter, 'key', KEY_ROUTE.publicKey),
    proofPages: () => keysetPages(store, checksum, agentUriValues, graphFilter, 'proof', KEY_ROUTE.proof),
    readRetirements: readRevocations,
    hasUnsupportedAlgorithm,
    finalRevocations: readRevocations,
    routes: async (candidates) => {
      const rowLimit = RECIPIENT_KEY_CANDIDATE_LIMIT + candidates.length + 1;
      const result = await store.query(`SELECT DISTINCT ?key ?peerId WHERE {
        VALUES ?agentSubject { ${agentUriValues} }
        VALUES ?key { ${candidates.map((candidate) => sparqlString(candidate.encodedPublicKey)).join(' ')} }
        GRAPH ?g {
          ?agentSubject <${KEY_ROUTE.publicKey}> ?rawKey ;
            <${KEY_ROUTE.algorithm}> ${sparqlString(WORKSPACE_AGENT_ENCRYPTION_KEY_ALGORITHM_X25519)} .
          OPTIONAL { ?agentSubject <${KEY_ROUTE.peerId}> ?peerId }
        }
        ${graphFilter} FILTER (STR(?rawKey) = ?key)
      } LIMIT ${rowLimit}`);
      if (result.type !== 'bindings') return [];
      if (result.bindings.length >= rowLimit) {
        throw new Error(`Too many public encryption-key candidates for DKG agent ${checksum}`);
      }
      return result.bindings.flatMap((row) => {
        const key = stringBinding(row['key']);
        const peer = stringBinding(row['peerId']);
        return key ? [{ key: stripRdfLiteral(key), peerId: peer ? stripRdfLiteral(peer) : undefined }] : [];
      });
    },
  };
}
