import { CclResourceNotFoundError } from '@origintrail-official/dkg-agent';
import {
  jsonResponse,
  readBody,
  SMALL_BODY_BYTES,
} from '../http-utils.js';
import type { RequestContext } from './context.js';

async function dispatchCclRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, url, path, requestAgentAddress } = ctx;

  if (req.method === 'POST' && path === '/api/ccl/policy/publish') {
    const body = await readBody(req, SMALL_BODY_BYTES * 4);
    const {
      contextGraphId,
      name,
      version,
      content,
      description,
      contextType,
      language,
      format,
    } = JSON.parse(body);
    if (!contextGraphId || !name || !version || !content) {
      return jsonResponse(res, 400, {
        error: 'Missing required fields: contextGraphId, name, version, content',
      });
    }
    const result = await agent.publishCclPolicy({
      contextGraphId,
      name,
      version,
      content,
      description,
      contextType,
      language,
      format,
    });
    return jsonResponse(res, 200, result);
  }

  if (req.method === 'POST' && path === '/api/ccl/policy/approve') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { contextGraphId, policyUri, contextType } = JSON.parse(body);
    if (!contextGraphId || !policyUri) {
      return jsonResponse(res, 400, {
        error: 'Missing required fields: contextGraphId, policyUri',
      });
    }
    try {
      const result = await agent.approveCclPolicy({
        contextGraphId,
        policyUri,
        contextType,
        callerAgentAddress: requestAgentAddress,
      });
      return jsonResponse(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Only the contextGraph owner can manage policies/.test(message)) {
        return jsonResponse(res, 403, { error: message });
      }
      throw err;
    }
  }

  if (req.method === 'POST' && path === '/api/ccl/policy/revoke') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const { contextGraphId, policyUri, contextType } = JSON.parse(body);
    if (!contextGraphId || !policyUri) {
      return jsonResponse(res, 400, {
        error: 'Missing required fields: contextGraphId, policyUri',
      });
    }
    try {
      const result = await agent.revokeCclPolicy({
        contextGraphId,
        policyUri,
        contextType,
        callerAgentAddress: requestAgentAddress,
      });
      return jsonResponse(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Only the contextGraph owner can manage policies/.test(message)) {
        return jsonResponse(res, 403, { error: message });
      }
      throw err;
    }
  }

  if (req.method === 'GET' && path === '/api/ccl/policy/list') {
    const policies = await agent.listCclPolicies({
      contextGraphId: url.searchParams.get('contextGraphId') ?? undefined,
      name: url.searchParams.get('name') ?? undefined,
      contextType: url.searchParams.get('contextType') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      includeBody: url.searchParams.get('includeBody') === 'true',
    });
    return jsonResponse(res, 200, { policies });
  }

  if (req.method === 'GET' && path === '/api/ccl/policy/resolve') {
    const contextGraphId = url.searchParams.get('contextGraphId');
    const name = url.searchParams.get('name');
    if (!contextGraphId || !name) {
      return jsonResponse(res, 400, {
        error: 'Missing required query params: contextGraphId, name',
      });
    }
    const policy = await agent.resolveCclPolicy({
      contextGraphId,
      name,
      contextType: url.searchParams.get('contextType') ?? undefined,
      includeBody: url.searchParams.get('includeBody') === 'true',
    });
    return jsonResponse(res, 200, { policy });
  }

  if (req.method === 'POST' && path === '/api/ccl/eval') {
    const body = await readBody(req, SMALL_BODY_BYTES * 8);
    const {
      contextGraphId,
      name,
      facts,
      contextType,
      view,
      snapshotId,
      scopeUal,
      publishResult,
    } = JSON.parse(body);
    if (!contextGraphId || !name) {
      return jsonResponse(res, 400, {
        error: 'Missing required fields: contextGraphId, name',
      });
    }
    if (facts != null && !Array.isArray(facts)) {
      return jsonResponse(res, 400, {
        error: 'facts must be an array when provided',
      });
    }
    const result = publishResult
      ? await agent.evaluateAndPublishCclPolicy({
        contextGraphId,
        name,
        facts,
        contextType,
        view,
        snapshotId,
        scopeUal,
      })
      : await agent.evaluateCclPolicy({
        contextGraphId,
        name,
        facts,
        contextType,
        view,
        snapshotId,
        scopeUal,
      });
    return jsonResponse(res, 200, result);
  }

  if (req.method === 'GET' && path === '/api/ccl/results') {
    const contextGraphId = url.searchParams.get('contextGraphId');
    if (!contextGraphId) {
      return jsonResponse(res, 400, {
        error: 'Missing required query param: contextGraphId',
      });
    }
    const evaluations = await agent.listCclEvaluations({
      contextGraphId,
      policyUri: url.searchParams.get('policyUri') ?? undefined,
      snapshotId: url.searchParams.get('snapshotId') ?? undefined,
      view: url.searchParams.get('view') ?? undefined,
      contextType: url.searchParams.get('contextType') ?? undefined,
      resultKind:
        (url.searchParams.get('resultKind') as 'derived' | 'decision' | null)
        ?? undefined,
      resultName: url.searchParams.get('resultName') ?? undefined,
    });
    return jsonResponse(res, 200, { evaluations });
  }
}

/** One feature-owned error boundary for all CCL HTTP routes. */
export async function handleCclRoutes(ctx: RequestContext): Promise<void> {
  try {
    await dispatchCclRoutes(ctx);
  } catch (err) {
    if (!(err instanceof CclResourceNotFoundError)) throw err;
    jsonResponse(ctx.res, 404, {
      error: err.message,
      code: err.code,
      resource: err.resource,
    });
  }
}
