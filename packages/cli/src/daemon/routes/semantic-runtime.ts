import {
  forkStoredSemanticProgram,
  isSemanticMemoryLayer,
  resolveStoredSemanticProgram,
  SemanticProgramError,
} from '../../semantic-runtime.js';
import { invokeSemanticProgramOnAuthorNode } from '../../semantic-runtime-inbox.js';
import { jsonResponse, readBody, safeParseJson } from '../http-utils.js';
import type { RequestContext } from './context.js';

export async function handleSemanticRuntimeRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path, url, agent, config, semanticRuntimeHost } = ctx;
  const isResolve = req.method === 'GET' && path === '/api/semantic-runtime/resolve';
  const isInvoke = req.method === 'POST' && path === '/api/semantic-runtime/invoke';
  const isFork = req.method === 'POST' && path === '/api/semantic-runtime/programs/fork';
  if (!isResolve && !isInvoke && !isFork) return;

  if (!semanticRuntimeHost) {
    return jsonResponse(res, 409, {
      code: 'SEMANTIC_RUNTIME_DISABLED',
      error: 'Semantic runtime is not enabled',
    });
  }
  const callerAgentAddress = ctx.actor.effectiveAgentAddress;
  if (isResolve) {
    const contextGraphId = url.searchParams.get('contextGraphId');
    const programIri = url.searchParams.get('programIri');
    const programLayer = url.searchParams.get('programLayer');
    if (!contextGraphId || !programIri || !isSemanticMemoryLayer(programLayer)) {
      return jsonResponse(res, 400, {
        error: 'contextGraphId, programIri, and programLayer (wm, swm, or vm) are required',
      });
    }
    try {
      return jsonResponse(res, 200, await resolveStoredSemanticProgram(
        agent,
        contextGraphId,
        programIri,
        programLayer,
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
  if (isFork) {
    if (
      typeof body.contextGraphId !== 'string'
      || typeof body.sourceProgramIri !== 'string'
      || typeof body.newProgramIri !== 'string'
      || !isSemanticMemoryLayer(body.sourceLayer)
      || !isSemanticMemoryLayer(body.targetLayer)
    ) {
      return jsonResponse(res, 400, {
        error: 'contextGraphId, sourceProgramIri, newProgramIri, sourceLayer, and targetLayer are required; layers must be wm, swm, or vm',
      });
    }
    try {
      return jsonResponse(res, 201, await forkStoredSemanticProgram(
        agent,
        body.contextGraphId,
        body.sourceProgramIri,
        body.newProgramIri,
        body.sourceLayer,
        body.targetLayer,
        callerAgentAddress,
      ));
    } catch (error) {
      if (error instanceof SemanticProgramError) {
        return jsonResponse(res, error.status, { code: error.code, error: error.message });
      }
      throw error;
    }
  }
  if (
    typeof body.contextGraphId !== 'string'
    || typeof body.programIri !== 'string'
    || typeof body.invocationId !== 'string'
    || !isSemanticMemoryLayer(body.programLayer)
    || !isSemanticMemoryLayer(body.executionLayer)
  ) {
    return jsonResponse(res, 400, {
      error: 'contextGraphId, programIri, invocationId, programLayer, and executionLayer are required; layers must be wm, swm, or vm',
    });
  }

  try {
    return jsonResponse(res, 200, await invokeSemanticProgramOnAuthorNode(
      agent,
      semanticRuntimeHost,
      body.contextGraphId,
      body.programIri,
      body.invocationId,
      body.programLayer,
      body.executionLayer,
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
