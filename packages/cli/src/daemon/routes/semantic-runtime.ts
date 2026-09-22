import { availableProgramAgents, programCaller } from './program-agent.js';
import { canonicalProgramInputs } from '../../semantic-runtime-bound-invocation.js';
import {
  forkStoredSemanticProgram,
  loadStoredSemanticProgram,
  invokeBoundSemanticProgram,
  isSemanticMemoryLayer,
  resolveStoredSemanticProgram,
  SemanticProgramError,
} from '../../semantic-runtime.js';
import { invokeBoundSemanticProgramOnPeer, invokeSemanticProgramOnAuthorNode } from '../../semantic-runtime-inbox.js';
import { jsonResponse, readBody, safeParseJson } from '../http-utils.js';
import type { RequestContext } from './context.js';
import { canonicalProgramGraphId, handleSemanticRuntimeConfigurationRoutes } from './semantic-runtime-configuration.js';

export async function handleSemanticRuntimeRoutes(ctx: RequestContext): Promise<void> {
  const programPath = ctx.path.startsWith('/api/programs/') || ctx.path.startsWith('/api/semantic-runtime/');
  if (!programPath) return;
  let authenticatedCaller: string | undefined;
  try {
    if (ctx.req.method === 'GET' && ctx.path === '/api/programs/agents')
      return jsonResponse(ctx.res, 200, availableProgramAgents(ctx));
    authenticatedCaller = programCaller(ctx);
  } catch (error) {
    if (error instanceof SemanticProgramError) return jsonResponse(ctx.res, error.status, { code: error.code, error: error.message });
    throw error;
  }
  if (await handleSemanticRuntimeConfigurationRoutes(ctx)) return;
  const { req, res, path, url, agent, config, semanticRuntimeHost } = ctx;
  const isResolve = req.method === 'GET' && path === '/api/semantic-runtime/resolve';
  const isSource = req.method === 'GET' && path === '/api/programs/source';
  const isInvoke = req.method === 'POST' && path === '/api/programs/execute';
  const isFork = req.method === 'POST' && path === '/api/semantic-runtime/programs/fork';
  if (!isResolve && !isSource && !isInvoke && !isFork) return;

  if (!semanticRuntimeHost) {
    return jsonResponse(res, 409, {
      code: 'SEMANTIC_RUNTIME_DISABLED',
      error: 'Semantic runtime is not enabled',
    });
  }
  const callerAgentAddress = authenticatedCaller ?? ctx.actor.effectiveAgentAddress;
  if (isResolve || isSource) {
    const contextGraphId = url.searchParams.get('contextGraphId');
    const programIri = url.searchParams.get('programIri');
    const programLayer = url.searchParams.get('programLayer');
    if (!contextGraphId || !programIri || !isSemanticMemoryLayer(programLayer)) {
      return jsonResponse(res, 400, {
        error: 'contextGraphId, programIri, and programLayer (wm, swm, or vm) are required',
      });
    }
    try {
      if (isSource) {
        if (!authenticatedCaller) throw new SemanticProgramError('PROGRAM_SOURCE_ACCESS_DENIED', 'Reading Program source requires an authenticated agent', 403);
        return jsonResponse(res, 200, await loadStoredSemanticProgram(agent, canonicalProgramGraphId(contextGraphId),
          programIri, programLayer, authenticatedCaller));
      }
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
  // The explicit operation form never falls back to direct Program execution,
  // even if a route has been removed or a binding has never been installed.
  if (Object.hasOwn(body, 'operationIri')) {
    if (typeof body.operationIri !== 'string' || typeof body.contextGraphId !== 'string' || typeof body.invocationId !== 'string'
      || Object.keys(body).some((key) => !['contextGraphId', 'operationIri', 'invocationId', 'authorization', 'inputs'].includes(key))) {
      return jsonResponse(res, 400, { error: 'Bound invocation requires contextGraphId, operationIri and invocationId, with optional client-signed authorization' });
    }
    try {
      if (Object.hasOwn(body, 'inputs')) {
        try { canonicalProgramInputs(body.inputs); }
        catch { throw new SemanticProgramError('INVALID_PROGRAM_INPUTS', 'inputs must be a bounded JSON array', 400); }
      }
      const graph = canonicalProgramGraphId(body.contextGraphId);
      const route = config.semanticRuntime?.programRoutes?.find((entry) => entry.contextGraphId === graph && entry.operationIri === body.operationIri);
      if (!config.semanticRuntime) throw new SemanticProgramError('SEMANTIC_RUNTIME_DISABLED', 'Semantic runtime is unavailable', 409);
      if (!route && Object.hasOwn(body, 'authorization')) {
        throw new SemanticProgramError('PROGRAM_INVOCATION_FORBIDDEN', 'Forwarded authorization requires an exact outbound route', 403);
      }
      const result = route
        ? await invokeBoundSemanticProgramOnPeer(agent, config.semanticRuntime, graph, body.operationIri, body.invocationId, authenticatedCaller, body.authorization, body.inputs)
        : await invokeBoundSemanticProgram(agent, semanticRuntimeHost, graph, body.operationIri, body.invocationId, config.semanticRuntime, authenticatedCaller, body.inputs);
      return jsonResponse(res, 200, result);
    } catch (error) {
      if (error instanceof SemanticProgramError) return jsonResponse(res, error.status, { code: error.code, error: error.message });
      throw error;
    }
  }
  // A configured operation never falls back to the caller's general graph rights.
  if (config.semanticRuntime?.programBindings?.some((binding) => binding.operationIri === body.programIri)
    || config.semanticRuntime?.programRoutes?.some((route) => route.operationIri === body.programIri)) {
    const binding = config.semanticRuntime.programBindings?.find((item) =>
      item.operationIri === body.programIri && item.contextGraphId === body.contextGraphId);
    const route = config.semanticRuntime.programRoutes?.find((item) =>
      item.operationIri === body.programIri && item.contextGraphId === body.contextGraphId);
    if (typeof body.contextGraphId !== 'string' || typeof body.invocationId !== 'string'
      || Object.keys(body).some((key) => !['contextGraphId', 'programIri', 'invocationId', 'programLayer', 'executionLayer'].includes(key))
      || (route && (body.programLayer !== undefined || body.executionLayer !== undefined))
      || (body.programLayer !== undefined && body.programLayer !== binding?.program.programLayer)
      || (body.executionLayer !== undefined && body.executionLayer !== (binding?.executionLayer ?? 'wm'))) {
      return jsonResponse(res, 400, { error: 'Provide contextGraphId, programIri and invocationId; the tenant fixes the Program and execution layers' });
    }
    try {
      if (route) {
        return jsonResponse(res, 200, await invokeBoundSemanticProgramOnPeer(
          agent, config.semanticRuntime, body.contextGraphId, body.programIri,
          body.invocationId, authenticatedCaller,
        ));
      }
      return jsonResponse(res, 200, await invokeBoundSemanticProgram(
        agent, semanticRuntimeHost, body.contextGraphId, body.programIri, body.invocationId,
        config.semanticRuntime, authenticatedCaller,
      ));
    } catch (error) {
      if (error instanceof SemanticProgramError) return jsonResponse(res, error.status, { code: error.code, error: error.message });
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
