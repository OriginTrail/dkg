import type { AssertionPullFromOptions } from '@origintrail-official/dkg-publisher';
import type { RequestContext } from './context.js';
import { jsonResponse } from '../http-utils.js';

/** The named route's shared preflight has already authenticated and resolved this actor lane. */
export async function handleKnowledgeAssetPullFrom(
  ctx: Pick<RequestContext, 'agent' | 'res'>,
  parsed: Record<string, unknown>,
  contextGraphId: string,
  name: string,
  subGraphName: string | undefined,
  agentAddress: string | undefined,
): Promise<void> {
  const { agent, res } = ctx;
  const sourceLayer = parsed.layer;
  if (sourceLayer !== 'swm' && sourceLayer !== 'vm') {
    return jsonResponse(res, 400, { error: 'pull-from requires "layer": "swm" | "vm"' });
  }
  const options: AssertionPullFromOptions = { subGraphName,
    onConflict: parsed.onConflict === 'replace' ? 'replace' : 'reject' };
  if (parsed.recoverExact !== undefined) {
    const pin = parsed.recoverExact;
    if (!pin || typeof pin !== 'object' || Array.isArray(pin)
      || typeof (pin as Record<string, unknown>).kaUal !== 'string'
      || !(pin as Record<string, unknown>).kaUal
      || typeof (pin as Record<string, unknown>).assertionVersion !== 'string'
      || !/^[1-9]\d*$/.test((pin as Record<string, string>).assertionVersion)
      || typeof (pin as Record<string, unknown>).merkleRoot !== 'string'
      || !/^0x[0-9a-fA-F]{64}$/.test((pin as Record<string, string>).merkleRoot)
      || (parsed.onConflict !== undefined && parsed.onConflict !== 'reject')) {
      return jsonResponse(res, 400, { code: 'INVALID_PULL_RECOVERY_OPTIONS',
        error: 'recoverExact requires kaUal, assertionVersion and merkleRoot strings and onConflict:"reject".' });
    }
    options.recoverExact = { kaUal: (pin as Record<string, string>).kaUal,
      assertionVersion: (pin as Record<string, string>).assertionVersion,
      merkleRoot: (pin as Record<string, string>).merkleRoot };
  }
  try {
    const result = await agent.assertion.pullFrom(contextGraphId, name, sourceLayer,
      { ...options, ...(agentAddress ? { agentAddress } : {}) });
    return jsonResponse(res, 200, { wmDraft: 'open', seededFrom: { layer: sourceLayer }, ...result });
  } catch (error: any) {
    if (['WM_DRAFT_CONFLICT', 'WM_DRAFT_NOT_EXACT', 'WM_RECOVERY_SOURCE_UNAVAILABLE',
      'UNSEALED_PULL_FROM_BLOCKED', 'PULL_FROM_EMPTY_SOURCE', 'LEGACY_KA_READ_ONLY'].includes(error?.code)) {
      return jsonResponse(res, 409, { code: error.code, error: error.message });
    }
    throw error;
  }
}
