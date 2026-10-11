// SPDX-License-Identifier: Apache-2.0
import {
  ConfirmedCatalogObligationErrorV1, parseConfirmedCatalogObligationRecoveryV1,
} from '@origintrail-official/dkg-agent';
import type { RequestContext } from './context.js';
import { actorFromRequestContext } from './context.js';
import { jsonResponse } from '../http-utils.js';

/** A confirmed transaction is not a request to publish again. Keep the exact retry evidence in JSON. */
export function confirmedCatalogObligationResponse(error: unknown) {
  if (!(error instanceof ConfirmedCatalogObligationErrorV1)) return null;
  const recovery = error.recoveryEvidence;
  if (recovery === undefined) return null;
  return { code: error.code, error: error.message, status: 'confirmed' as const,
    catalogObligationPending: true, ual: recovery.seal.kaUal,
    authorAddress: recovery.seal.authorAddress, merkleRoot: recovery.seal.assertionMerkleRoot,
    txHash: recovery.transactionHash, blockNumber: recovery.blockNumber,
    confirmedTransaction: error.transaction, recovery,
    retryAction: 'observe_confirmed_catalog_obligation',
    retryUrl: `/api/knowledge-assets/${encodeURIComponent(recovery.assertionCoordinate)}/vm/observe-confirmed` };
}

/** The ordinary CG write preflight has already run; retain the credential's author custody as well. */
export async function handleConfirmedCatalogObligationRecovery(
  ctx: RequestContext, contextGraphId: string, name: string, parsed: Record<string, unknown>,
): Promise<void> {
  const evidence = parsed.recovery;
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
    return jsonResponse(ctx.res, 400, { code: 'CONFIRMED_CATALOG_RECOVERY_INVALID', error: 'Missing confirmed catalog recovery evidence' });
  }
  const actor = actorFromRequestContext(ctx);
  if (actor.authentication.principal.kind === 'anonymous' && actor.authentication.mode !== 'disabled') {
    return jsonResponse(ctx.res, 403, { error: 'Confirmed catalog recovery requires a credential' });
  }
  let candidate: ReturnType<typeof parseConfirmedCatalogObligationRecoveryV1>;
  try {
    candidate = parseConfirmedCatalogObligationRecoveryV1(evidence);
  } catch {
    return jsonResponse(ctx.res, 409, { code: 'CONFIRMED_CATALOG_RECOVERY_INVALID', error: 'Invalid confirmed catalog recovery evidence' });
  }
  if (actor.authenticatedAgentAddress !== undefined
    && candidate.seal?.authorAddress !== actor.authenticatedAgentAddress.toLowerCase()) {
    return jsonResponse(ctx.res, 403, { error: 'Confirmed catalog recovery belongs to another author' });
  }
  if (candidate.contextGraphId !== contextGraphId || candidate.assertionCoordinate !== name
    || candidate.subGraphName !== null || parsed.subGraphName !== undefined) {
    return jsonResponse(ctx.res, 400, { code: 'CONFIRMED_CATALOG_RECOVERY_INVALID', error: 'Recovery does not match the selected knowledge asset' });
  }
  try {
    await ctx.agent.recoverRfc64ConfirmedCatalogObligationV1(candidate);
    jsonResponse(ctx.res, 200, { status: 'confirmed', catalogObligationPending: false,
      txHash: candidate.transactionHash, ual: candidate.seal.kaUal });
  } catch (error) {
    jsonResponse(ctx.res, (error as { code?: string }).code === 'CONFIRMED_CATALOG_RECOVERY_INVALID' ? 409 : 503,
      { code: (error as { code?: string }).code ?? 'CONFIRMED_CATALOG_OBLIGATION_PENDING',
        error: 'Confirmed catalog observation could not complete', recovery: candidate,
        retryAction: 'observe_confirmed_catalog_obligation' });
  }
}
