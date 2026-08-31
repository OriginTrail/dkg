import {
  invokeStoredSemanticProgram,
  resolveStoredSemanticProgram,
  SemanticProgramError,
} from '../../semantic-runtime.js';
import { jsonResponse, readBody, safeParseJson } from '../http-utils.js';
import type { RequestContext } from './context.js';

export async function handleSemanticRuntimeRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path, url, agent, config, requestToken, semanticRuntimeHost } = ctx;
  const isResolve = req.method === 'GET' && path === '/api/semantic-runtime/resolve';
  const isInvoke = req.method === 'POST' && path === '/api/semantic-runtime/invoke';
  if (!isResolve && !isInvoke) return;

  if (!semanticRuntimeHost) {
    return jsonResponse(res, 409, {
      code: 'SEMANTIC_RUNTIME_DISABLED',
      error: 'Semantic runtime is not enabled',
    });
  }
  const callerAgentAddress = requestToken ? agent.resolveAgentByToken(requestToken) : undefined;
  if (isResolve) {
    const contextGraphId = url.searchParams.get('contextGraphId');
    const programIri = url.searchParams.get('programIri');
    if (!contextGraphId || !programIri) {
      return jsonResponse(res, 400, { error: 'contextGraphId and programIri are required' });
    }
    try {
      return jsonResponse(res, 200, await resolveStoredSemanticProgram(
        agent,
        contextGraphId,
        programIri,
        config.semanticRuntime,
        config.llm,
        callerAgentAddress,
      ));
    } catch (error) {
      if (error instanceof SemanticProgramError) {
        return jsonResponse(res, error.status, { code: error.code, error: error.message });
      }
      throw error;
    }
  }

  const body = safeParseJson(await readBody(req), res);
  if (!body) return;
  if (
    typeof body.contextGraphId !== 'string'
    || typeof body.programIri !== 'string'
    || typeof body.invocationId !== 'string'
  ) {
    return jsonResponse(res, 400, {
      error: 'contextGraphId, programIri, and invocationId must be strings',
    });
  }

  try {
    return jsonResponse(res, 200, await invokeStoredSemanticProgram(
      agent,
      semanticRuntimeHost,
      body.contextGraphId,
      body.programIri,
      body.invocationId,
      config.semanticRuntime,
      config.llm,
      callerAgentAddress,
    ));
  } catch (error) {
    if (error instanceof SemanticProgramError) {
      return jsonResponse(res, error.status, { code: error.code, error: error.message });
    }
    throw error;
  }
}
