import {
  assertionLifecycleUri, assertSafeIri, contextGraphAssertionUri, contextGraphMetaUri,
  parseAssertionSealQuads,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { parsePromoteOperationIntent, type PromoteOperationIntent } from './promote-operation-intent.js';

export type PersistedPromoteOperation = { kind: 'absent' } | { kind: 'legacy'; operationId: string }
  | { kind: 'complete'; intent: PromoteOperationIntent };

/** Also used by the bounded compare-after-insert claim check. */
export function parsePromoteLifecycleLiteral(raw: string | undefined, lifecycle: string, code: string): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'string' && value.length > 0) return value;
  } catch { /* Report the existing typed corruption contract below. */ }
  throw Object.assign(new Error(`Graph-scoped assertion lifecycle <${lifecycle}> contains malformed state`), { code });
}

/** Read under the lifecycle lock. Decode operation metadata only after stale-marker cleanup. */
export async function readAssertionPromoteEvidence(
  store: TripleStore, contextGraphId: string, name: string, agentAddress: string, subGraphName?: string,
) {
  const subject = assertSafeIri(contextGraphAssertionUri(contextGraphId, agentAddress, name, subGraphName));
  const lifecycle = assertSafeIri(assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName));
  const graph = assertSafeIri(contextGraphMetaUri(contextGraphId));
  const result = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> {
    VALUES ?s { <${subject}> <${lifecycle}> } ?s ?p ?o
  } }`);
  const fail = (code: string, detail: string): never => {
    throw Object.assign(new Error(`Graph-scoped assertion lifecycle <${lifecycle}> ${detail}`), { code });
  };
  if (result.type !== 'quads') fail('KA_LIFECYCLE_STATE_CORRUPT', 'could not be read safely');
  const quads = result.type === 'quads' ? result.quads : [];
  const rows = (predicate: string) => quads.filter(q => q.subject === lifecycle && q.predicate === `http://dkg.io/ontology/${predicate}`);
  const literal = (predicate: string, code: string): string | undefined => {
    const matches = rows(predicate);
    if (matches.length > 1) fail(`${code}_CONFLICT`, `has conflicting ${predicate} values`);
    return parsePromoteLifecycleLiteral(matches[0]?.object, lifecycle, `${code}_CORRUPT`);
  };
  let operation: PersistedPromoteOperation | undefined;
  return {
    seal: parseAssertionSealQuads(quads, subject),
    hasPersistedIntent: rows('promoteOperationIntent').length > 0,
    readLayer: () => literal('memoryLayer', 'KA_LIFECYCLE_LAYER'),
    readOperation: (): PersistedPromoteOperation => {
      if (operation) return operation;
      // Check both cardinalities before literal parsing, retaining the original error precedence.
      if (rows('shareOperationId').length > 1) fail('KA_SHARE_OPERATION_ID_CONFLICT', 'has conflicting durable share operation IDs');
      if (rows('promoteOperationIntent').length > 1) fail('KA_PROMOTE_OPERATION_INTENT_CONFLICT', 'has conflicting durable promote intent');
      const operationId = literal('shareOperationId', 'KA_SHARE_OPERATION_ID');
      const rawIntent = literal('promoteOperationIntent', 'KA_PROMOTE_OPERATION_INTENT');
      if (!operationId && rawIntent) fail('KA_PROMOTE_OPERATION_INTENT_CONFLICT', 'has promote intent without an operation ID');
      operation = operationId
        ? rawIntent ? { kind: 'complete', intent: parsePromoteOperationIntent(rawIntent, operationId) }
          : { kind: 'legacy', operationId }
        : { kind: 'absent' };
      return operation;
    },
  };
}
