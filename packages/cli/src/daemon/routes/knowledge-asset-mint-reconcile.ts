// SPDX-License-Identifier: Apache-2.0
import { validateAssertionName } from '@origintrail-official/dkg-core';
import { KA_MINT_RECONCILE_INCOMPLETE_CODE, KA_MINT_RECONCILE_REFUSED_CODE } from '@origintrail-official/dkg-agent';
import type { RequestContext } from './context.js';
import { requireNodeAdmin } from '../node-admin-guard.js';
import { jsonResponse, readBody, safeParseJson, SMALL_BODY_BYTES, validateOptionalSubGraphName,
  resolveRequiredWriteContextGraphId, respondIfChainRpcTransportError, respondIfStoreUnavailable } from '../http-utils.js';
import { respondAmbiguousAssertionAuthor, respondMintAdoptionRefused } from './knowledge-assets-error-mapping.js';

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
/** Caller preconditions: no record to complete, not a finalized complete share, or a graph this node cannot publish to. */
const PRECONDITION_CODES = new Set([KA_MINT_RECONCILE_REFUSED_CODE, 'PUBLISH_NOT_FULL_SHARE', 'CG_NOT_REGISTERED']);

/**
 * Record one named asset whose publish transaction mined after the node
 * stopped waiting for it. Verifies the seal's reserved id on chain and adopts
 * that mint, resuming an interrupted earlier attempt; never sends a
 * transaction, ACK request or member ciphertext.
 */
export async function handleKnowledgeAssetMintReconcile(
  { agent, authentication, req, res }: RequestContext,
  name: string,
  preflight: Parameters<typeof resolveRequiredWriteContextGraphId>[3],
): Promise<void> {
  if (!requireNodeAdmin(authentication, res, 'POST /api/knowledge-assets/:name/vm/reconcile', 'record an existing mint')) return;
  const valid = validateAssertionName(name);
  if (!valid.valid) return jsonResponse(res, 400, { error: `Invalid "name": ${valid.reason}` });
  const parsed = safeParseJson(await readBody(req, SMALL_BODY_BYTES), res);
  if (!parsed) return;
  if (parsed.txHash !== undefined && (typeof parsed.txHash !== 'string' || !TX_HASH.test(parsed.txHash))) {
    return jsonResponse(res, 400, { error: '"txHash" must be a 0x-prefixed 32-byte transaction hash' });
  }
  if (!validateOptionalSubGraphName(parsed.subGraphName, res)) return;
  const contextGraphId = await resolveRequiredWriteContextGraphId(agent, parsed.contextGraphId, res, preflight);
  if (!contextGraphId) return;
  try {
    return jsonResponse(res, 200, await agent.reconcileKnowledgeAssetMint({
      contextGraphId, name, subGraphName: parsed.subGraphName, txHash: parsed.txHash,
    }));
  } catch (error: any) {
    if (respondMintAdoptionRefused(res, error) || respondAmbiguousAssertionAuthor(res, error)) return;
    if (respondIfStoreUnavailable(res, error) || respondIfChainRpcTransportError(res, error)) return;
    const message = error?.message ?? String(error);
    if (error?.code === KA_MINT_RECONCILE_INCOMPLETE_CODE) {
      return jsonResponse(res, 503, { code: error.code, error: message, retryable: true });
    }
    if (PRECONDITION_CODES.has(error?.code) || /is not finalized|No quads in shared memory|has no private payload/.test(message)) {
      return jsonResponse(res, 409, { code: error?.code ?? 'VM_PUBLISH_PRECONDITION', error: message });
    }
    return jsonResponse(res, 500, { error: message });
  }
}
