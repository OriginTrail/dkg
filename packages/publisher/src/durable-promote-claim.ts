// SPDX-License-Identifier: Apache-2.0

import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { SHARE_OPERATION_ID_PRED, PROMOTE_OPERATION_INTENT_PRED } from './metadata.js';
import { serializePromoteOperationIntent, type PromoteOperationIntent } from './promote-operation-intent.js';

export interface DurablePromoteClaim {
  readonly readable: boolean;
  readonly operationIds: readonly (string | undefined)[];
  readonly intents: readonly (string | undefined)[];
}

export function parsePromoteLifecycleLiteral(raw: string | undefined, code: string, lifecycleSubject: string): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'string' && value.length > 0) return value;
  } catch {
    // Fall through to the typed corruption error below.
  }
  throw Object.assign(
    new Error(`Graph-scoped assertion lifecycle <${lifecycleSubject}> contains malformed state`),
    { code },
  );
}

/** Separate bounded reads avoid a Cartesian product on conflicting durable rows. */
export async function readDurablePromoteClaim(store: TripleStore, graph: string, subject: string): Promise<DurablePromoteClaim> {
  const [ids, intents] = await Promise.all([
    store.query(`SELECT ?shareOperationId WHERE { GRAPH <${assertSafeIri(graph)}> {
      <${assertSafeIri(subject)}> <${SHARE_OPERATION_ID_PRED}> ?shareOperationId
    } } LIMIT 2`),
    store.query(`SELECT ?promoteIntent WHERE { GRAPH <${assertSafeIri(graph)}> {
      <${assertSafeIri(subject)}> <${PROMOTE_OPERATION_INTENT_PRED}> ?promoteIntent
    } } LIMIT 2`),
  ]);
  return { readable: ids.type === 'bindings' && intents.type === 'bindings',
    operationIds: ids.type === 'bindings' ? ids.bindings.map(row => row['shareOperationId']) : [],
    intents: intents.type === 'bindings' ? intents.bindings.map(row => row['promoteIntent']) : [] };
}

export function decodeDurablePromoteClaim(claim: DurablePromoteClaim, subject: string) {
  return {
    operationId: claim.operationIds.length === 1
      ? parsePromoteLifecycleLiteral(claim.operationIds[0], 'KA_SHARE_OPERATION_ID_CORRUPT', subject) : undefined,
    serializedIntent: claim.intents.length === 1
      ? parsePromoteLifecycleLiteral(claim.intents[0], 'KA_PROMOTE_OPERATION_INTENT_CORRUPT', subject) : undefined,
  };
}

/** One exact ownership invariant for admission and post-confirmation revalidation. */
export function durablePromoteClaimMatches(claim: DurablePromoteClaim, subject: string, intent: PromoteOperationIntent): boolean {
  if (!claim.readable || claim.operationIds.length !== 1 || claim.intents.length !== 1) return false;
  const decoded = decodeDurablePromoteClaim(claim, subject);
  return decoded.operationId === intent.operationId && decoded.serializedIntent === serializePromoteOperationIntent(intent);
}
