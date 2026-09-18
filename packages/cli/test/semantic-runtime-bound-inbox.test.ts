import { signAgentDelegation } from '@origintrail-official/dkg-agent';
import { ethers } from 'ethers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { boundSemanticInvocationScope } from '../src/semantic-runtime-bound-invocation.js';
import { invokeBoundSemanticProgramOnPeer, registerSemanticRuntimeInboxSkill, SEMANTIC_RUNTIME_INBOX_SKILL_IRI } from '../src/semantic-runtime-inbox.js';
import { invokeBoundSemanticProgram, validateSemanticRuntimeConfig } from '../src/semantic-runtime.js';

vi.mock('../src/semantic-runtime.js', async (original) => ({
  ...await original<typeof import('../src/semantic-runtime.js')>(),
  invokeBoundSemanticProgram: vi.fn(),
}));

const key = `0x${'01'.padStart(64, '0')}`;
const caller = new ethers.Wallet(key).address;
const graph = 'dmaast-kamstrup';
const operation = 'urn:dmaast:operation:read-w10';
const id = '123e4567-e89b-42d3-a456-426614174099';
const route = { contextGraphId: graph, operationIri: operation, targetPeerId: 'peer-kamstrup' };
const unsigned = { version: 3 as const, kind: 'bound-operation' as const, contextGraphId: graph, operationIri: operation, invocationId: id };
const result = { invocationId: id, executionIri: `urn:sr:execution:${id}`, executionLayer: 'wm' as const, persisted: true as const, outputs: ['approved W10 result'] };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

async function signed(overrides: Record<string, unknown> = {}) {
  const issuedAtMs = Date.now();
  return { ...unsigned, authorization: await signAgentDelegation({
    agentAddress: caller, agentPrivateKey: key, delegateePeerId: 'peer-idener',
    scope: boundSemanticInvocationScope(unsigned, route.targetPeerId),
    issuedAtMs, expiresAtMs: issuedAtMs + 300_000, ...overrides,
  }) };
}

function fixture() {
  let handler: (request: any, peer: string) => Promise<any>;
  const target: any = {
    peerId: route.targetPeerId,
    registerSkill: vi.fn((_skill, fn) => { handler = fn; }),
    isPrivateContextGraph: vi.fn(async () => false),
    canReadContextGraph: vi.fn(async () => false),
    query: vi.fn(),
  };
  const config = { enabled: true, programRoutes: [{ ...route }] };
  registerSemanticRuntimeInboxSkill(target, {} as any, { enabled: true }, undefined);
  const receive = async (value: unknown, peer = 'peer-idener') => {
    const response = await handler({ inputData: encode(value), skillUri: SEMANTIC_RUNTIME_INBOX_SKILL_IRI }, peer);
    return { ...response, body: JSON.parse(new TextDecoder().decode(response.outputData)) };
  };
  const sender: any = {
    peerId: 'peer-idener',
    resolveLocalAgentAddress: vi.fn((address) => address),
    getCustodialAgentPrivateKey: vi.fn((address) => address === caller ? key : undefined),
    invokeSkill: vi.fn(async (_target, _skill, data, _options) => handler({ inputData: data }, 'peer-idener')),
  };
  const invoke = (identity: string | undefined = caller) => invokeBoundSemanticProgramOnPeer(sender, config, graph, operation, id, identity);
  return { target, sender, config, receive, invoke };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(invokeBoundSemanticProgram).mockResolvedValue(result);
});

describe('signed bound operation inbox', () => {
  it('signs locally and dispatches to the binding executor without raw graph membership', async () => {
    const f = fixture();
    await expect(f.invoke()).resolves.toEqual(result);
    expect(f.sender.invokeSkill).toHaveBeenCalledWith(route.targetPeerId, SEMANTIC_RUNTIME_INBOX_SKILL_IRI,
      expect.any(Uint8Array), expect.objectContaining({ messageId: expect.any(String), requestOwned: true }));
    const firstDeliveryId = f.sender.invokeSkill.mock.calls[0][3].messageId;
    await f.invoke();
    expect(f.sender.invokeSkill.mock.calls[1][3].messageId).not.toBe(firstDeliveryId);
    expect(firstDeliveryId).not.toBe(id);
    expect(invokeBoundSemanticProgram).toHaveBeenCalledWith(f.target, {}, graph, operation, id, { enabled: true }, caller);
    expect(f.target.isPrivateContextGraph).not.toHaveBeenCalled();
    expect(f.target.query).not.toHaveBeenCalled();
  });

  it.each(['swm', 'vm'] as const)('returns the tenant-selected %s layer and its persistence evidence', async (layer) => {
    const value = { ...result, executionLayer: layer, ...(layer === 'vm' ? { executionUal: 'did:dkg:asset:execution' } : {}) };
    vi.mocked(invokeBoundSemanticProgram).mockResolvedValue(value);
    await expect(fixture().invoke()).resolves.toEqual(value);
  });

  it.each([
    { contextGraphId: 'dmaast-jpb' }, { operationIri: 'urn:dmaast:operation:other' },
    { invocationId: '223e4567-e89b-42d3-a456-426614174099' },
  ])('rejects signed-payload tampering %j before execution', async (mutation) => {
    const f = fixture();
    const response = await f.receive({ ...await signed(), ...mutation });
    expect(response.body.code).toBe('INVOCATION_AUTHORIZATION_INVALID');
    expect(invokeBoundSemanticProgram).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'program' }, { version: 2 }, { invocationId: 'invalid' },
    { parameters: { device: 'W20' } }, { programIri: 'urn:other' },
    { executorAgentAddress: caller }, { executionLayer: 'vm' }, { authorization: [] },
  ])('rejects incompatible or extra request fields %j', async (mutation) => {
    const response = await fixture().receive({ ...await signed(), ...mutation });
    expect(response.body.code).toBe('INVALID_INBOX_INVOCATION');
    expect(invokeBoundSemanticProgram).not.toHaveBeenCalled();
  });

  it('binds the delegation to both destination and sending peer', async () => {
    const f = fixture();
    const request = await signed();
    expect((await f.receive(request, 'peer-attacker')).body.code).toBe('INVOCATION_SENDER_MISMATCH');
    f.target.peerId = 'peer-jpb';
    expect((await f.receive(request)).body.code).toBe('INVOCATION_AUTHORIZATION_INVALID');
    expect(invokeBoundSemanticProgram).not.toHaveBeenCalled();
  });

  it.each(['expired', 'future', 'unbounded', 'too-long', 'invalid-signature', 'different-agent'])('rejects %s authorization', async (fault) => {
    const now = Date.now();
    const overrides = fault === 'expired' ? { issuedAtMs: now - 10_000, expiresAtMs: now - 1 }
      : fault === 'future' ? { issuedAtMs: now + 60_000, expiresAtMs: now + 120_000 }
      : fault === 'unbounded' ? { expiresAtMs: undefined }
      : fault === 'too-long' ? { issuedAtMs: now, expiresAtMs: now + 300_001 } : {};
    const request = await signed(overrides);
    if (fault === 'invalid-signature') request.authorization.signature = '0x00';
    if (fault === 'different-agent') request.authorization.agentAddress = ethers.Wallet.createRandom().address;
    expect((await fixture().receive(request)).body.code).toBe('INVOCATION_AUTHORIZATION_INVALID');
    expect(invokeBoundSemanticProgram).not.toHaveBeenCalled();
  });

  it('requires an authenticated agent with its own local signing key and an exact configured route', async () => {
    const f = fixture();
    await expect(invokeBoundSemanticProgramOnPeer(f.sender, f.config, graph, operation, id, undefined))
      .rejects.toMatchObject({ code: 'PROGRAM_INVOCATION_FORBIDDEN' });
    await expect(f.invoke(ethers.Wallet.createRandom().address)).rejects.toMatchObject({ code: 'CALLER_SIGNATURE_UNAVAILABLE' });
    f.config.programRoutes = [];
    await expect(f.invoke()).rejects.toMatchObject({ code: 'PROGRAM_INVOCATION_FORBIDDEN' });
    expect(f.sender.invokeSkill).not.toHaveBeenCalled();
  });

  it.each([
    { invocationId: '223e4567-e89b-42d3-a456-426614174099' }, { executionIri: 'urn:other' },
    { executionLayer: 'vm' }, { executionUal: 'did:dkg:wrong' }, { persisted: false }, { outputs: [42] },
  ])('rejects inconsistent remote execution evidence %j', async (mutation) => {
    const f = fixture();
    f.sender.invokeSkill.mockResolvedValue({ success: true, outputData: encode({ ...result, ...mutation }) });
    await expect(f.invoke()).rejects.toMatchObject({ code: 'REMOTE_INVOCATION_RESPONSE_INVALID' });
  });

  it('reports an unreachable tenant without falling back to another transport', async () => {
    const f = fixture();
    f.sender.invokeSkill.mockRejectedValue(new Error('offline'));
    await expect(f.invoke()).rejects.toMatchObject({ code: 'PROGRAM_TARGET_NODE_UNREACHABLE', status: 503 });
    expect(invokeBoundSemanticProgram).not.toHaveBeenCalled();
  });

  it('validates operator routes before use', () => {
    expect(() => validateSemanticRuntimeConfig({ enabled: true, programRoutes: [route] })).not.toThrow();
    expect(() => validateSemanticRuntimeConfig({ programRoutes: [route, route] })).toThrow('DUPLICATE_PROGRAM_ROUTE');
    for (const change of [{ targetPeerId: '' }, { targetPeerId: 'peer with spaces' }, { callerAgentAddress: caller }, { contextGraphId: '' }, { operationIri: 'not-an-iri' }]) {
      expect(() => validateSemanticRuntimeConfig({ programRoutes: [{ ...route, ...change }] })).toThrow();
    }
  });
});
