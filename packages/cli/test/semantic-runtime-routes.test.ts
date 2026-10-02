import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleSemanticRuntimeRoutes } from '../src/daemon/routes/semantic-runtime.js';
import { forkStoredSemanticProgram, resolveStoredSemanticProgram, SemanticProgramError } from '../src/semantic-runtime.js';
import { invokeSemanticProgramOnAuthorNode } from '../src/semantic-runtime-inbox.js';

vi.mock('../src/semantic-runtime.js', async (original) => ({
  ...await original<typeof import('../src/semantic-runtime.js')>(),
  forkStoredSemanticProgram: vi.fn(),
  resolveStoredSemanticProgram: vi.fn(),
}));
vi.mock('../src/semantic-runtime-inbox.js', () => ({ invokeSemanticProgramOnAuthorNode: vi.fn() }));

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
    const disabled = request('POST', '/api/semantic-runtime/invoke');
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
    const invoked = request('POST', '/api/semantic-runtime/invoke', { ...payload, callerAgentAddress: 'attacker' });
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
    ['POST', '/api/semantic-runtime/invoke', { ...payload, executionLayer: 'outside' }],
    ['POST', '/api/semantic-runtime/invoke', '{invalid'],
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
      : `/api/semantic-runtime/${operation === 'fork' ? 'programs/fork' : 'invoke'}`;
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
