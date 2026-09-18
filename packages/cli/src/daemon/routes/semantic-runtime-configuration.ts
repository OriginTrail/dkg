import { createHash } from 'node:crypto';

import { sparqlIri, validateContextGraphId } from '@origintrail-official/dkg-core';
import { decodeQueryCatalogBindings } from '@origintrail-official/dkg-core/query-catalog';
import type { SemanticProgramBinding, SemanticQueryOutputSchema } from '@origintrail-official/dkg-semantic-runtime';
import { ethers } from 'ethers';

import { loadStoredSemanticProgram, SemanticProgramError, validateBoundSemanticProgram } from '../../semantic-runtime.js';
import { validateProgramBindings, validateProgramRoutes } from '../../semantic-runtime-program-bindings.js';
import { findSavedQuery } from '../../semantic-runtime-query-adapter.js';
import { createSemanticQueryPin, queryOutputSchemaSha256 } from '../../semantic-runtime-query-pins.js';
import { readContextGraphQueryCatalogBindings } from '../query-catalog-service.js';
import { jsonResponse, normalizeContextGraphIdOrUri, readBody, safeParseJson } from '../http-utils.js';
import type { RequestContext } from './context.js';

export function canonicalProgramGraphId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new SemanticProgramError('INVALID_PROGRAM_GRAPH', 'A canonical Context Graph ID or graph URI is required', 400);
  const graph = normalizeContextGraphIdOrUri(value.trim());
  if (!validateContextGraphId(graph).valid) throw new SemanticProgramError('INVALID_PROGRAM_GRAPH', 'Invalid Context Graph ID', 400);
  return graph;
}

function operationIri(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || !/^[a-z][a-z0-9+.-]*:/i.test(value)) badRequest('Invalid operation IRI');
  try { sparqlIri(value); } catch { badRequest('Invalid operation IRI'); }
  return value;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function closed(value: Record<string, unknown>, keys: string[]): void { if (Object.keys(value).some((key) => !keys.includes(key))) badRequest('Unsupported field'); }
function badRequest(message: string): never { throw new SemanticProgramError('INVALID_PROGRAM_CONFIGURATION', message, 400); }
function pin(supplied: unknown, actual: string, name: string): string {
  if (supplied !== undefined && supplied !== actual) throw new SemanticProgramError('PROGRAM_APPROVAL_PIN_MISMATCH', `${name} differs from the stored Program or approved contract`, 409);
  return actual;
}
function address(value: unknown): string { if (typeof value !== 'string' || !ethers.isAddress(value)) badRequest('Invalid agent address'); return ethers.getAddress(value); }

/** Explicit credentials only: auth-disabled mode and implicit node identities confer no management rights. */
async function assertManager(ctx: RequestContext, kind: 'binding' | 'route', graph: string): Promise<void> {
  const auth = ctx.actor.authentication;
  if (auth.principal.kind === 'nodeOperator' && auth.acceptedToken !== undefined) return;
  if (kind === 'binding' && auth.principal.kind === 'agent') {
    try { await ctx.agent.assertContextGraphOwner(graph, auth.principal.agentAddress, 'manage Program bindings'); return; }
    catch { /* Fail closed without exposing ownership metadata to another tenant. */ }
  }
  throw new SemanticProgramError('PROGRAM_CONFIGURATION_FORBIDDEN', 'A Context Graph owner credential or explicit node-operator credential is required; routes require the node operator', 403);
}

async function prepareBinding(ctx: RequestContext, raw: Record<string, unknown>): Promise<SemanticProgramBinding> {
  closed(raw, ['operationIri', 'contextGraphId', 'enabled', 'allowedCallerAgentAddresses', 'executorAgentAddress', 'program', 'query', 'sparqlRead', 'assetCreation', 'executionLayer']);
  if (raw.enabled !== undefined && raw.enabled !== true) badRequest('Use DELETE to revoke a binding');
  if (!record(raw.program) || !Array.isArray(raw.allowedCallerAgentAddresses)) badRequest('program and allowedCallerAgentAddresses are required');
  closed(raw.program, ['contextGraphId', 'programIri', 'programLayer', 'sourceHash', 'authorAgentAddress']);
  const contextGraphId = canonicalProgramGraphId(raw.contextGraphId);
  const sourceGraph = canonicalProgramGraphId(raw.program.contextGraphId);
  const sourceProgramIri = operationIri(raw.program.programIri);
  if (typeof raw.program.programLayer !== 'string' || !['wm', 'swm', 'vm'].includes(raw.program.programLayer)) badRequest('program.programLayer must be wm, swm or vm');
  const executor = address(raw.executorAgentAddress);
  const principal = ctx.actor.authentication.principal;
  const reader = principal.kind === 'agent' ? principal.agentAddress : executor;
  if (!await ctx.agent.canReadContextGraph(sourceGraph, { callerAgentAddress: reader, allowSubscriptionFallback: false })) {
    throw new SemanticProgramError('PROGRAM_SOURCE_ACCESS_DENIED', 'The manager must be able to read the source Program', 403);
  }
  // Read under the manager's identity first; graph ownership must not let an
  // agent borrow another local wallet to inspect that wallet's private WM.
  const program = await loadStoredSemanticProgram(ctx.agent, sourceGraph, sourceProgramIri,
    raw.program.programLayer as SemanticProgramBinding['program']['programLayer'], reader);
  const binding: SemanticProgramBinding = {
    ...raw as unknown as SemanticProgramBinding,
    operationIri: operationIri(raw.operationIri), contextGraphId, enabled: true,
    allowedCallerAgentAddresses: [...new Set(raw.allowedCallerAgentAddresses.map(address))].sort(), executorAgentAddress: executor,
    executionLayer: (raw.executionLayer ?? 'wm') as SemanticProgramBinding['executionLayer'],
    program: { contextGraphId: sourceGraph, programIri: program.programIri, programLayer: program.layer,
      sourceHash: pin(raw.program.sourceHash, createHash('sha256').update(program.source, 'utf8').digest('hex'), 'sourceHash'),
      authorAgentAddress: pin(raw.program.authorAgentAddress === undefined ? undefined : address(raw.program.authorAgentAddress), address(program.authorAgentAddress), 'authorAgentAddress') },
  };
  if (raw.query !== undefined) {
    if (!record(raw.query)) badRequest('query must be an object');
    closed(raw.query, ['selector', 'queryIri', 'definitionSha256', 'outputSchema', 'outputSchemaSha256']);
    if (typeof raw.query.selector !== 'string') badRequest('query.selector is required');
    if (!await ctx.agent.canReadContextGraph(contextGraphId, { callerAgentAddress: executor, allowSubscriptionFallback: false })) {
      throw new SemanticProgramError('PROGRAM_EXECUTOR_ACCESS_DENIED', 'Executor cannot read the data graph', 403);
    }
    const rows = await readContextGraphQueryCatalogBindings(ctx.agent, contextGraphId, { callerAgentAddress: executor, source: 'semantic-runtime-query-catalog' });
    const item = findSavedQuery(decodeQueryCatalogBindings(rows, { contextGraphId }), raw.query.selector);
    if (!item) throw new SemanticProgramError('PROGRAM_QUERY_UNAVAILABLE', 'The selected saved query is unavailable', 409);
    binding.query = createSemanticQueryPin(raw.query.selector, item, raw.query.outputSchema as SemanticQueryOutputSchema);
    for (const field of ['queryIri', 'definitionSha256', 'outputSchemaSha256'] as const) pin(raw.query[field], binding.query[field], field);
  }
  if (raw.sparqlRead !== undefined) {
    if (!record(raw.sparqlRead)) badRequest('sparqlRead must be an object');
    const outputSchemaSha256 = queryOutputSchemaSha256(raw.sparqlRead.outputSchema as SemanticQueryOutputSchema);
    binding.sparqlRead = { ...raw.sparqlRead, outputSchemaSha256: pin(raw.sparqlRead.outputSchemaSha256, outputSchemaSha256, 'outputSchemaSha256') } as SemanticProgramBinding['sparqlRead'];
  }
  validateProgramBindings([binding]);
  return binding;
}

export async function handleSemanticRuntimeConfigurationRoutes(ctx: RequestContext): Promise<boolean> {
  const kind = ctx.path === '/api/programs/bindings' ? 'binding' : ctx.path === '/api/programs/routes' ? 'route' : undefined;
  if (!kind) return false;
  try {
    const auth = ctx.actor.authentication;
    if (auth.principal.kind === 'anonymous' || (kind === 'route' && auth.principal.kind !== 'nodeOperator')) {
      throw new SemanticProgramError('PROGRAM_CONFIGURATION_FORBIDDEN', 'An explicit management credential is required', 403);
    }
    const method = ctx.req.method;
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method ?? '')) { jsonResponse(ctx.res, 405, { error: 'Use GET, POST, PUT or DELETE' }); return true; }
    let body: Record<string, unknown> = {};
    if (method !== 'GET') {
      const parsed = safeParseJson(await readBody(ctx.req, 262_144), ctx.res);
      if (!parsed) return true;
      if (!record(parsed)) badRequest('JSON object required');
      body = parsed;
      closed(body, method === 'DELETE' ? ['contextGraphId', 'operationIri', 'expectedRevision'] : [kind, 'expectedRevision']);
    }
    const candidate = method === 'POST' || method === 'PUT' ? body[kind] : undefined;
    if ((method === 'POST' || method === 'PUT') && !record(candidate)) badRequest(`${kind} object is required`);
    const raw = candidate as Record<string, unknown> | undefined;
    const graph = canonicalProgramGraphId(method === 'GET' ? ctx.url.searchParams.get('contextGraphId') : raw?.contextGraphId ?? body.contextGraphId);
    const operation = method === 'GET' && !ctx.url.searchParams.has('operationIri') ? undefined
      : operationIri(method === 'GET' ? ctx.url.searchParams.get('operationIri') : raw?.operationIri ?? body.operationIri);
    await assertManager(ctx, kind, graph);
    const runtime = ctx.semanticRuntimeHost ?? await ctx.ensureSemanticRuntime?.();
    if (!runtime || !ctx.config.semanticRuntime) throw new SemanticProgramError('SEMANTIC_RUNTIME_DISABLED', 'Semantic runtime is explicitly disabled or unavailable', 409);
    const configuration = runtime.configuration;
    if (method === 'GET') {
      const entry = operation ? configuration.inspect(kind, graph, operation) : configuration.list(kind, graph);
      await assertManager(ctx, kind, graph);
      jsonResponse(ctx.res, entry ? 200 : 404, entry ?? { code: 'PROGRAM_CONFIGURATION_NOT_FOUND' });
      return true;
    }
    const current = configuration.inspect(kind, graph, operation!);
    if (method === 'POST' && current) throw new SemanticProgramError('PROGRAM_CONFIGURATION_CONFLICT', 'An entry already exists; update with PUT and its current revision', 409);
    if (method === 'DELETE' && !current) throw new SemanticProgramError('PROGRAM_CONFIGURATION_NOT_FOUND', 'No binding or route exists', 404);
    const expected = method === 'POST' ? 0 : body.expectedRevision;
    if (!Number.isSafeInteger(expected) || (expected as number) < 0 || (method === 'POST' && body.expectedRevision !== undefined)) badRequest('PUT and DELETE require expectedRevision from GET; POST omits it');
    if ((current?.revision ?? 0) !== expected) throw new SemanticProgramError('PROGRAM_CONFIGURATION_CONFLICT', 'The entry changed; inspect its current revision', 409);
    const updatedBy = auth.principal.kind === 'agent' ? `did:dkg:agent:${auth.principal.agentAddress}` : 'node-operator';
    let value;
    let resolution;
    if (method === 'DELETE') value = kind === 'binding' && current && 'binding' in current ? { ...current.binding, enabled: false } : null;
    else if (kind === 'binding') {
      value = await prepareBinding(ctx, raw!);
      value.authorizationRevision = (expected as number) + 1;
      resolution = await validateBoundSemanticProgram(ctx.agent, runtime, ctx.config.semanticRuntime, value, () => assertManager(ctx, kind, graph));
    } else {
      value = { ...raw, contextGraphId: graph, operationIri: operation! } as NonNullable<typeof ctx.config.semanticRuntime.programRoutes>[number];
      validateProgramRoutes([value]);
    }
    await assertManager(ctx, kind, graph);
    const effective = configuration.write(kind, graph, operation!, value, expected as number, updatedBy);
    jsonResponse(ctx.res, method === 'POST' ? 201 : 200, { ...effective, ...(resolution ? { resolution } : {}) });
  } catch (error) {
    if (error instanceof SemanticProgramError) jsonResponse(ctx.res, error.status, { code: error.code, error: error.message });
    else if (error instanceof Error && error.message === 'PROGRAM_CONFIGURATION_CONFLICT') jsonResponse(ctx.res, 409, { code: error.message, error: 'Configuration changed during validation; inspect the current revision' });
    else if (error instanceof Error && /^(INVALID_|EMPTY_|DUPLICATE_|SEMANTIC_QUERY_|PROGRAM_CONFIGURATION_LIMIT)/.test(error.message)) jsonResponse(ctx.res, 400, { code: error.message, error: 'Invalid Program configuration or output contract' });
    else throw error;
  }
  return true;
}
