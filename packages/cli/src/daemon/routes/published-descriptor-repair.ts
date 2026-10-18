// SPDX-License-Identifier: Apache-2.0
import { validateAssertionName } from '@origintrail-official/dkg-core';
import type { RequestContext } from './context.js';
import { requireNodeAdmin } from '../node-admin-guard.js';
import { jsonResponse, readBody, safeParseJson, SMALL_BODY_BYTES,
  validateOptionalSubGraphName, resolveRequiredWriteContextGraphId } from '../http-utils.js';

/** Targeted local metadata repair; never sends or requeues a publication. */
export async function handlePublishedDescriptorRepair(
  { agent, authentication, req, res }: RequestContext,
  name: string,
  preflight: Parameters<typeof resolveRequiredWriteContextGraphId>[3],
): Promise<void> {
  if (!requireNodeAdmin(authentication, res, 'repair-descriptor', 'repair a published descriptor')) return;
  const valid = validateAssertionName(name);
  if (!valid.valid) return jsonResponse(res, 400, { error: `Invalid "name": ${valid.reason}` });
  const parsed = safeParseJson(await readBody(req, SMALL_BODY_BYTES), res);
  if (!parsed) return;
  if (typeof parsed.kaUal !== 'string' || (parsed.dryRun !== undefined && typeof parsed.dryRun !== 'boolean')) {
    return jsonResponse(res, 400, { error: 'kaUal is required; dryRun must be boolean' });
  }
  if (!validateOptionalSubGraphName(parsed.subGraphName, res)) return;
  const contextGraphId = await resolveRequiredWriteContextGraphId(agent, parsed.contextGraphId, res, preflight);
  if (!contextGraphId) return;
  try {
    return jsonResponse(res, 200, await agent.repairPublishedKnowledgeAssetDescriptor({
      contextGraphId, name, kaUal: parsed.kaUal, subGraphName: parsed.subGraphName, dryRun: parsed.dryRun !== false,
    }));
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'KA_DESCRIPTOR_REPAIR_REFUSED';
    return jsonResponse(res, code === 'KA_DESCRIPTOR_REPAIR_BUSY' ? 503 : 409, {
      code, error: error instanceof Error ? error.message : String(error),
    });
  }
}
