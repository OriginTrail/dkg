import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleSemanticRuntimeRoutes } from '../src/daemon/routes/semantic-runtime.js';
import { forkStoredSemanticProgram, invokeBoundSemanticProgram, resolveStoredSemanticProgram, SemanticProgramError } from '../src/semantic-runtime.js';
import { invokeBoundSemanticProgramOnPeer, invokeSemanticProgramOnAuthorNode } from '../src/semantic-runtime-inbox.js';

vi.mock('../src/semantic-runtime.js', async (original) => ({
  ...await original<typeof import('../src/semantic-runtime.js')>(),
  forkStoredSemanticProgram: vi.fn(),
  invokeBoundSemanticProgram: vi.fn(),
  resolveStoredSemanticProgram: vi.fn(),
}));
vi.mock('../src/semantic-runtime-inbox.js', () => ({ invokeSemanticProgramOnAuthorNode: vi.fn(), invokeBoundSemanticProgramOnPeer: vi.fn() }));

const caller = '0xauthenticated-caller';
const payload = {
  contextGraphId: 'private-graph', programIri: 'urn:program:one', invocationId: 'invocation-one',
  programLayer: 'vm', executionLayer: 'wm',
};
const forkPayload = {
  contextGraphId: 'private-graph', sourceProgramIri: 'urn:program:one', newProgramIri: 'urn:program:fork',
  sourceLayer: 'vm', targetLayer: 'swm',
};

function request(method: string, pathname: string, body: unknown = payload) {
  const url = new URL(pathname, 'http://localhost');
  const res: any = new EventEmitter();
  res.writeHead = vi.fn((status: number) => { res.statusCode = status; return res; });
  res.end = vi.fn((data: string) => { res.body = JSON.parse(data); res.writableEnded = true; });
  const req = Object.assign(new EventEmitter(), {
    method, aborted: false, __dkgPrebufferedBody: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const ctx: any = {
    req, res, path: url.pathname, url, agent: {}, semanticRuntimeHost: {},
    config: { semanticRuntime: { enabled: true }, llm: { apiKey: 'test' } },
    actor: { effectiveAgentAddress: caller },
  };
  return { ctx, res };
}

beforeEach(() => vi.resetAllMocks());

describe('semantic runtime HTTP routes', () => {
  it('ignores unrelated routes and refuses disabled runtime access', async () => {
    const unrelated = request('GET', '/api/status');
    await handleSemanticRuntimeRoutes(unrelated.ctx);
    expect(unrelated.res.end).not.toHaveBeenCalled();
    const disabled = request('POST', '/api/programs/execute');
    disabled.ctx.semanticRuntimeHost = null;
    await handleSemanticRuntimeRoutes(disabled.ctx);
    expect(disabled.res.statusCode).toBe(409);
    expect(disabled.res.body.code).toBe('SEMANTIC_RUNTIME_DISABLED');
    expect(invokeSemanticProgramOnAuthorNode).not.toHaveBeenCalled();
  });

  it('resolves using the authenticated wallet and selected Program layer', async () => {
    vi.mocked(resolveStoredSemanticProgram).mockResolvedValue({ executable: true } as any);
    const { ctx, res } = request('GET', '/api/semantic-runtime/resolve?contextGraphId=private-graph&programIri=urn:program:one&programLayer=vm');
    await handleSemanticRuntimeRoutes(ctx);
    expect(resolveStoredSemanticProgram).toHaveBeenCalledWith(ctx.agent, 'private-graph', 'urn:program:one', 'vm', ctx.config.semanticRuntime, ctx.config.llm, caller);
    expect(res.statusCode).toBe(200);
    expect(res.body.executable).toBe(true);
  });

  it('forwards invocation and fork authority from the request actor, ignoring a caller field in JSON', async () => {
    vi.mocked(invokeSemanticProgramOnAuthorNode).mockResolvedValue({ persisted: true } as any);
    const invoked = request('POST', '/api/programs/execute', { ...payload, callerAgentAddress: 'attacker' });
    await handleSemanticRuntimeRoutes(invoked.ctx);
    expect(invokeSemanticProgramOnAuthorNode).toHaveBeenCalledWith(invoked.ctx.agent, invoked.ctx.semanticRuntimeHost, 'private-graph', 'urn:program:one', 'invocation-one', 'vm', 'wm', invoked.ctx.config.semanticRuntime, invoked.ctx.config.llm, caller);
    expect(invoked.res.statusCode).toBe(200);

    vi.mocked(forkStoredSemanticProgram).mockResolvedValue({ persisted: true } as any);
    const forked = request('POST', '/api/semantic-runtime/programs/fork', { ...forkPayload, callerAgentAddress: 'attacker' });
    await handleSemanticRuntimeRoutes(forked.ctx);
    expect(forkStoredSemanticProgram).toHaveBeenCalledWith(forked.ctx.agent, 'private-graph', 'urn:program:one', 'urn:program:fork', 'vm', 'swm', caller);
    expect(forked.res.statusCode).toBe(201);
  });

  it.each([
    ['GET', '/api/semantic-runtime/resolve', {}],
    ['POST', '/api/programs/execute', { ...payload, executionLayer: 'outside' }],
    ['POST', '/api/programs/execute', '{invalid'],
    ['POST', '/api/semantic-runtime/programs/fork', { ...forkPayload, targetLayer: 'outside' }],
  ])('rejects malformed %s %s before dispatch', async (method, pathname, body) => {
    const { ctx, res } = request(method as string, pathname as string, body);
    await handleSemanticRuntimeRoutes(ctx);
    expect(res.statusCode).toBe(400);
    expect(resolveStoredSemanticProgram).not.toHaveBeenCalled();
    expect(invokeSemanticProgramOnAuthorNode).not.toHaveBeenCalled();
    expect(forkStoredSemanticProgram).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'invoke', 'fork'] as const)('preserves semantic errors and rethrows unexpected %s failures', async (operation) => {
    const mock = operation === 'resolve' ? vi.mocked(resolveStoredSemanticProgram)
      : operation === 'invoke' ? vi.mocked(invokeSemanticProgramOnAuthorNode) : vi.mocked(forkStoredSemanticProgram);
    const pathname = operation === 'resolve'
      ? '/api/semantic-runtime/resolve?contextGraphId=private-graph&programIri=urn:program:one&programLayer=vm'
      : operation === 'fork' ? '/api/semantic-runtime/programs/fork' : '/api/programs/execute';
    const makeRequest = () => request(operation === 'resolve' ? 'GET' : 'POST', pathname, operation === 'fork' ? forkPayload : payload);
    mock.mockRejectedValueOnce(new SemanticProgramError('PROGRAM_CONTEXT_GRAPH_FORBIDDEN', 'denied', 403));
    const denied = makeRequest();
    await handleSemanticRuntimeRoutes(denied.ctx);
    expect(denied.res.statusCode).toBe(403);
    expect(denied.res.body).toEqual({ code: 'PROGRAM_CONTEXT_GRAPH_FORBIDDEN', error: 'denied' });
    const unexpected = new Error('storage unavailable');
    mock.mockRejectedValueOnce(unexpected);
    await expect(handleSemanticRuntimeRoutes(makeRequest().ctx)).rejects.toBe(unexpected);
  });
});

describe('tenant-bound execute route', () => {
  const operator = '0ximplicit-operator';
  const body = { contextGraphId: payload.contextGraphId, programIri: payload.programIri, invocationId: '123e4567-e89b-42d3-a456-426614174099' };
  function boundContext(input: unknown = body) {
    const result = request('POST', '/api/programs/execute', input);
    result.ctx.actor.authenticatedAgentAddress = caller;
    result.ctx.config.semanticRuntime!.programBindings = [{
      contextGraphId: body.contextGraphId, operationIri: body.programIri,
      enabled: true, allowedCallerAgentAddresses: [caller],
      program: { programLayer: 'vm' },
    } as any];
    return result;
  }

  it('selects the configured operation with three fields and the authenticated caller', async () => {
    const { ctx, res } = boundContext();
    vi.mocked(invokeBoundSemanticProgram).mockResolvedValue({ persisted: true } as any);
    await handleSemanticRuntimeRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(invokeBoundSemanticProgram).toHaveBeenCalledWith(ctx.agent, ctx.semanticRuntimeHost,
      body.contextGraphId, body.programIri, body.invocationId, ctx.config.semanticRuntime, caller);
    expect(invokeSemanticProgramOnAuthorNode).not.toHaveBeenCalled();
  });

  it.each([
    { executionLayer: 'vm' }, { programLayer: 'wm' }, { callerAgentAddress: operator },
    { executorAgentAddress: operator }, { parameters: { device: 'other-device' } },
    { programContextGraphId: 'other-catalog' },
  ])('rejects client overrides %j', async (overrides) => {
    const { ctx, res } = boundContext({ ...body, ...overrides });
    await handleSemanticRuntimeRoutes(ctx);
    expect(res.statusCode).toBe(400);
    expect(invokeBoundSemanticProgram).not.toHaveBeenCalled();
    expect(invokeSemanticProgramOnAuthorNode).not.toHaveBeenCalled();
  });

  it('passes no default operator identity when there is no authenticated agent', async () => {
    const { ctx, res } = boundContext();
    ctx.actor = { ...ctx.actor, authenticatedAgentAddress: undefined, effectiveAgentAddress: operator };
    vi.mocked(invokeBoundSemanticProgram).mockRejectedValue(new SemanticProgramError('PROGRAM_INVOCATION_FORBIDDEN', 'Access denied', 403));
    await handleSemanticRuntimeRoutes(ctx);
    expect(invokeBoundSemanticProgram).toHaveBeenCalledWith(ctx.agent, ctx.semanticRuntimeHost,
      body.contextGraphId, body.programIri, body.invocationId, ctx.config.semanticRuntime, undefined);
    expect(res.statusCode).toBe(403);
    expect(invokeSemanticProgramOnAuthorNode).not.toHaveBeenCalled();
  });

  it('never falls back to author-node invocation for a disabled or wrong-tenant operation', async () => {
    const { ctx, res } = boundContext({ ...body, contextGraphId: 'other-tenant' });
    ctx.config.semanticRuntime!.programBindings![0].enabled = false;
    vi.mocked(invokeBoundSemanticProgram).mockRejectedValue(new SemanticProgramError('PROGRAM_INVOCATION_FORBIDDEN', 'Access denied', 403));
    await handleSemanticRuntimeRoutes(ctx);
    expect(res.statusCode).toBe(403);
    expect(invokeSemanticProgramOnAuthorNode).not.toHaveBeenCalled();
  });
});


it('does not dispatch the replaced invocation endpoint', async () => {
  const { ctx, res } = request('POST', '/api/semantic-runtime/invoke');
  await handleSemanticRuntimeRoutes(ctx);
  expect(res.end).not.toHaveBeenCalled();
  expect(invokeBoundSemanticProgram).not.toHaveBeenCalled();
  expect(invokeSemanticProgramOnAuthorNode).not.toHaveBeenCalled();
});

describe('signed outbound operation route', () => {
  const body = { contextGraphId: 'dmaast-kamstrup', programIri: 'urn:dmaast:operation:read-w10', invocationId: '123e4567-e89b-42d3-a456-426614174099' };
  function routed(input: unknown = body) {
    const result = request('POST', '/api/programs/execute', input);
    result.ctx.actor.authenticatedAgentAddress = caller;
    result.ctx.config.semanticRuntime.programRoutes = [{ contextGraphId: body.contextGraphId, operationIri: body.programIri, targetPeerId: 'peer-kamstrup' }];
    return result;
  }

  it('routes the existing three-field API request using only the authenticated caller', async () => {
    const { ctx, res } = routed();
    vi.mocked(invokeBoundSemanticProgramOnPeer).mockResolvedValue({ persisted: true } as any);
    await handleSemanticRuntimeRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(invokeBoundSemanticProgramOnPeer).toHaveBeenCalledWith(ctx.agent, ctx.config.semanticRuntime,
      body.contextGraphId, body.programIri, body.invocationId, caller);
    expect(invokeSemanticProgramOnAuthorNode).not.toHaveBeenCalled();
    expect(invokeBoundSemanticProgram).not.toHaveBeenCalled();
  });

  it.each([
    { targetPeerId: 'attacker' }, { callerAgentAddress: 'attacker' }, { programLayer: 'vm' },
    { executionLayer: 'wm' }, { parameters: { device: 'other-device' } }, { authorization: {} },
  ])('rejects untrusted routing/signing overrides %j', async (override) => {
    const { ctx, res } = routed({ ...body, ...override });
    await handleSemanticRuntimeRoutes(ctx);
    expect(res.statusCode).toBe(400);
    expect(invokeBoundSemanticProgramOnPeer).not.toHaveBeenCalled();
  });

  it('never supplies the default operator as a signing fallback', async () => {
    const { ctx, res } = routed();
    ctx.actor.authenticatedAgentAddress = undefined;
    ctx.actor.effectiveAgentAddress = 'default-operator';
    vi.mocked(invokeBoundSemanticProgramOnPeer).mockRejectedValue(new SemanticProgramError('PROGRAM_INVOCATION_FORBIDDEN', 'denied', 403));
    await handleSemanticRuntimeRoutes(ctx);
    expect(res.statusCode).toBe(403);
    expect(invokeBoundSemanticProgramOnPeer).toHaveBeenCalledWith(ctx.agent, ctx.config.semanticRuntime,
      body.contextGraphId, body.programIri, body.invocationId, undefined);
  });

  it('does not fall back to ordinary Program invocation for a wrong tenant', async () => {
    const { ctx, res } = routed({ ...body, contextGraphId: 'unconfigured-tenant' });
    vi.mocked(invokeBoundSemanticProgram).mockRejectedValue(new SemanticProgramError('PROGRAM_INVOCATION_FORBIDDEN', 'denied', 403));
    await handleSemanticRuntimeRoutes(ctx);
    expect(res.statusCode).toBe(403);
    expect(invokeBoundSemanticProgramOnPeer).not.toHaveBeenCalled();
    expect(invokeSemanticProgramOnAuthorNode).not.toHaveBeenCalled();
  });
});
