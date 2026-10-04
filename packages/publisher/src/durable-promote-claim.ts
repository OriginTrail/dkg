// SPDX-License-Identifier: Apache-2.0

import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import { SHARE_OPERATION_ID_PRED, PROMOTE_OPERATION_INTENT_PRED } from './metadata.js';
import { parsePromoteOperationIntent, serializePromoteOperationIntent, type PromoteOperationIntent } from './promote-operation-intent.js';

export type DurablePromoteClaim =
  | { readonly kind: 'absent' }
  | { readonly kind: 'legacy'; readonly operationId: string }
  | { readonly kind: 'modern'; readonly operationId: string; readonly serializedIntent: string; readonly intent: PromoteOperationIntent }
  | { readonly kind: 'corrupt'; readonly error: Error };

function corruptClaim(subject: string, code: string, detail: string): never {
  throw Object.assign(new Error(`Graph-scoped assertion lifecycle <${subject}> ${detail}`), { code });
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
  try {
    if (ids.type !== 'bindings' || intents.type !== 'bindings') {
      corruptClaim(subject, 'KA_LIFECYCLE_STATE_CORRUPT', 'could not be read safely');
    }
    if (ids.bindings.length > 1) {
      corruptClaim(subject, 'KA_SHARE_OPERATION_ID_CONFLICT', 'has conflicting durable share operation IDs');
    }
    if (intents.bindings.length > 1) {
      corruptClaim(subject, 'KA_PROMOTE_OPERATION_INTENT_CONFLICT', 'has conflicting durable promote intent');
    }
    if (ids.bindings.length === 0) {
      if (intents.bindings.length !== 0) {
        corruptClaim(subject, 'KA_PROMOTE_OPERATION_INTENT_CONFLICT', 'has promote intent without an operation ID');
      }
      return { kind: 'absent' };
    }
    const operationId = parsePromoteLifecycleLiteral(ids.bindings[0]?.['shareOperationId'], 'KA_SHARE_OPERATION_ID_CORRUPT', subject);
    if (operationId === undefined) corruptClaim(subject, 'KA_SHARE_OPERATION_ID_CORRUPT', 'contains malformed state');
    if (intents.bindings.length === 0) return { kind: 'legacy', operationId };
    const serializedIntent = parsePromoteLifecycleLiteral(intents.bindings[0]?.['promoteIntent'], 'KA_PROMOTE_OPERATION_INTENT_CORRUPT', subject);
    if (serializedIntent === undefined) corruptClaim(subject, 'KA_PROMOTE_OPERATION_INTENT_CORRUPT', 'contains malformed state');
    return { kind: 'modern', operationId, serializedIntent,
      intent: parsePromoteOperationIntent(serializedIntent, operationId) };
  } catch (error) {
    // Preserve the original precise corruption error for source inspection;
    // ownership checks need only the classified, already decoded outcome.
    return { kind: 'corrupt', error: error as Error };
  }
}

/** One exact ownership invariant for admission and post-confirmation revalidation. */
export function durablePromoteClaimMatches(claim: DurablePromoteClaim, intent: PromoteOperationIntent): boolean {
  return claim.kind === 'modern' && claim.operationId === intent.operationId
    && claim.serializedIntent === serializePromoteOperationIntent(intent);
}
