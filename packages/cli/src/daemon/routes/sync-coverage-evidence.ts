import { jsonResponse } from '../http-utils.js';
import type { RequestContext } from './context.js';

function parseAfterSequence(value: string | null): number | null {
  if (value === null || value === '') return 0;
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Bounded node-admin evidence for actual Edge/Core automatic sync work. */
export async function handleSyncCoverageEvidenceRoutes(ctx: RequestContext): Promise<void> {
  const {
    req,
    res,
    agent,
    config,
    validTokens,
    path,
    requestToken,
    url,
  } = ctx;

  if (req.method !== 'GET' || path !== '/api/diagnostics/sync-coverage-evidence') return;

  const authEnabled = config.auth?.enabled !== false;
  const isNodeAdminCaller = !authEnabled || (
    !!requestToken
    && validTokens.has(requestToken)
    && !agent.resolveAgentByToken(requestToken)
  );
  if (!isNodeAdminCaller) {
    return jsonResponse(res, 403, {
      error:
        'GET /api/diagnostics/sync-coverage-evidence requires a node-level admin token '
        + '(~/.dkg/auth.token); agent-scoped tokens cannot inspect node-wide sync work.',
    });
  }

  const afterSequence = parseAfterSequence(url.searchParams.get('afterSequence'));
  if (afterSequence === null) {
    return jsonResponse(res, 400, {
      error: 'afterSequence must be a non-negative safe integer',
    });
  }

  return jsonResponse(res, 200, agent.getSyncCoverageEvidence(afterSequence));
}
