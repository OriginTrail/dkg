import { afterEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { verifyAgentDelegation, type DKGAgent } from '@origintrail-official/dkg-agent';

import {
  createRemoteExecuteAdapter,
  semanticInvocationScope,
  SEMANTIC_INVOCATION_AUTHORIZATION_TTL_MS,
  SEMANTIC_RUNTIME_INBOX_SKILL_IRI,
  type SemanticInboxInvocationV2,
  type SemanticMemoryLayer,
} from '../src/semantic-runtime-remote-execute-adapter.js';

const wallet = new ethers.Wallet(`0x${'11'.repeat(32)}`);
const input = { nodeId: 'peer-target', programIri: 'urn:sr:program:child' };
const authorization = { effectId: 'urn:sr:effect:parent:1', attemptId: 'attempt-1', requestDigest: new Uint8Array(32), capabilityId: 'capability-1', policyDecisionId: 'policy-1' };
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function setup(executionLayer: SemanticMemoryLayer = 'wm', address = wallet.address) {
  const invocations: SemanticInboxInvocationV2[] = [];
  const agent = {
    peerId: 'peer-caller',
    isPrivateContextGraph: vi.fn(async () => true),
    resolveLocalAgentAddress: vi.fn(() => 'local-agent'),
    getCustodialAgentPrivateKey: vi.fn((): string | null => wallet.privateKey),
    invokeSkill: vi.fn(async (_nodeId: string, _skill: string, payload: Uint8Array, _options: unknown) => {
      const invocation = JSON.parse(new TextDecoder().decode(payload)) as SemanticInboxInvocationV2;
      invocations.push(invocation);
      const executionUal = executionLayer === 'vm' ? 'did:dkg:execution-child' : undefined;
      return {
        success: true,
        outputData: json({ invocationId: invocation.invocationId, executionIri: 'urn:sr:execution:child', executionLayer, persisted: true, ...(executionUal ? { executionUal } : {}) }),
        ...(executionUal ? { resultUal: executionUal } : {}),
      };
    }),
  };
  const adapter = createRemoteExecuteAdapter(agent as unknown as DKGAgent, 'private-context', address, 'vm', executionLayer);
  return { adapter, agent, invocations };
}

afterEach(() => vi.restoreAllMocks());

describe('wallet-authorized remote execution adapter', () => {
  it.each(['wm', 'swm', 'vm'] as const)('signs a target-bound %s invocation and accepts only its persisted receipt', async (layer) => {
    const { adapter, agent, invocations } = setup(layer, wallet.address.toLowerCase());
    const now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(adapter.enabled?.()).toBe(true);
    expect(adapter.implementationHash).toMatch(/^[a-f0-9]{64}$/);
    const result = await adapter.dispatch(authorization, input);
    const invocation = invocations[0];
    expect(invocation).toMatchObject({ version: 2, contextGraphId: 'private-context', programIri: input.programIri, programLayer: 'vm', executionLayer: layer, executionTarget: 'target-node' });
    expect(invocation.invocationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const expectedScope = semanticInvocationScope(invocation, input.nodeId);
    expect(verifyAgentDelegation(invocation.authorization, { expectedScope, nowMs: now })).toMatchObject({ agentAddress: wallet.address, delegateePeerId: 'peer-caller', issuedAtMs: now, expiresAtMs: now + SEMANTIC_INVOCATION_AUTHORIZATION_TTL_MS });
    expect(() => verifyAgentDelegation(invocation.authorization, { expectedScope: semanticInvocationScope(invocation, 'other-peer'), nowMs: now })).toThrow(/scope mismatch/);
    expect(agent.getCustodialAgentPrivateKey).toHaveBeenCalledWith('local-agent');
    expect(agent.resolveLocalAgentAddress).toHaveBeenCalledWith(wallet.address);
    expect(agent.isPrivateContextGraph).toHaveBeenCalledWith('private-context');
    expect(agent.invokeSkill).toHaveBeenCalledWith(input.nodeId, SEMANTIC_RUNTIME_INBOX_SKILL_IRI, expect.any(Uint8Array), { messageId: invocation.invocationId, timeoutMs: 600_000, requestOwned: true });
    expect(result).toEqual({ status: 'succeeded', output: JSON.stringify({ executionIri: 'urn:sr:execution:child', ...(layer === 'vm' ? { executionUal: 'did:dkg:execution-child' } : {}) }), evidenceRef: layer === 'vm' ? 'did:dkg:execution-child' : 'urn:sr:execution:child' });
  });

  it('retries a protected effect with the same invocation id and gives a new effect a different id', async () => {
    const { adapter, invocations } = setup();
    await adapter.dispatch(authorization, input);
    await adapter.dispatch({ ...authorization, attemptId: 'attempt-2' }, input);
    await adapter.dispatch({ ...authorization, effectId: 'urn:sr:effect:parent:2' }, input);
    expect(invocations[1].invocationId).toBe(invocations[0].invocationId);
    expect(invocations[2].invocationId).not.toBe(invocations[0].invocationId);
    expect(await adapter.reconcile({} as Parameters<typeof adapter.reconcile>[0], input)).toEqual({ status: 'unknown', evidenceRef: 'urn:sr:reconciliation:retry-same-invocation-required' });
  });

  it('binds every execution field into scope while normalizing UUID case and the default target', () => {
    const invocation = { version: 2 as const, contextGraphId: 'context', programIri: 'urn:program', invocationId: 'ABCDEF', programLayer: 'vm' as const, executionLayer: 'wm' as const };
    const scope = semanticInvocationScope(invocation, 'peer');
    expect(scope).toMatch(/^dkg\.semantic-runtime\.invoke\.v2:[0-9a-f]{64}$/);
    expect(semanticInvocationScope({ ...invocation, invocationId: 'abcdef', executionTarget: 'program-author' }, 'peer')).toBe(scope);
    for (const changed of [
      { ...invocation, contextGraphId: 'different' }, { ...invocation, programIri: 'urn:other' },
      { ...invocation, invocationId: 'different' }, { ...invocation, programLayer: 'wm' as const },
      { ...invocation, executionLayer: 'vm' as const }, { ...invocation, executionTarget: 'target-node' as const },
    ]) expect(semanticInvocationScope(changed, 'peer')).not.toBe(scope);
    expect(semanticInvocationScope(invocation, 'different-peer')).not.toBe(scope);
  });

  it('validates UTF-8 input bounds and returns only the typed fields', () => {
    const { adapter } = setup();
    expect(adapter.validateInput({ nodeId: 'λ'.repeat(256), programIri: 'λ'.repeat(1024), ignored: true })).toEqual({ nodeId: 'λ'.repeat(256), programIri: 'λ'.repeat(1024) });
    for (const value of [null, 'node', {}, { ...input, nodeId: 1 }, { ...input, nodeId: '' }, { ...input, nodeId: 'λ'.repeat(257) }, { nodeId: input.nodeId }, { ...input, programIri: 1 }, { ...input, programIri: '' }, { ...input, programIri: 'λ'.repeat(1025) }]) {
      expect(() => adapter.validateInput(value)).toThrow('INVALID_REMOTE_EXECUTE_ARGUMENT');
    }
  });

  it.each(['public', 'lookup failure'] as const)('fails closed for %s graph status without contacting the target', async (kind) => {
    const { adapter, agent } = setup();
    if (kind === 'public') agent.isPrivateContextGraph.mockResolvedValue(false);
    else agent.isPrivateContextGraph.mockRejectedValue(new Error('graph unavailable'));
    const error = await adapter.dispatch(authorization, input).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ message: expect.stringContaining('REMOTE_INVOCATION_PRIVATE_GRAPH_REQUIRED') });
    expect(adapter.couldHaveReachedTarget(error)).toBe(false);
    expect(agent.invokeSkill).not.toHaveBeenCalled();
  });

  it.each(['invalid principal', 'missing key', 'mismatched key'] as const)('does not send an invocation for %s', async (kind) => {
    const { adapter, agent } = setup('wm', kind === 'invalid principal' ? 'not-an-address' : wallet.address);
    if (kind === 'missing key') agent.getCustodialAgentPrivateKey.mockReturnValue(null);
    if (kind === 'mismatched key') agent.getCustodialAgentPrivateKey.mockReturnValue(`0x${'22'.repeat(32)}`);
    expect(adapter.enabled?.()).toBe(kind === 'mismatched key');
    await expect(adapter.dispatch(authorization, input)).rejects.toThrow(kind === 'mismatched key' ? /does not match agentAddress/ : /EXECUTOR_SIGNATURE_UNAVAILABLE/);
    expect(agent.invokeSkill).not.toHaveBeenCalled();
  });

  it.each([new Error('connection closed'), 'transport disconnected'])('preserves uncertain transport failures for reconciliation', async (failure) => {
    const { adapter, agent } = setup();
    agent.invokeSkill.mockRejectedValue(failure);
    const error = await adapter.dispatch(authorization, input).catch((value: unknown) => value);
    expect(error).toMatchObject({ message: `REMOTE_NODE_UNREACHABLE:${failure instanceof Error ? failure.message : failure}` });
    expect(adapter.couldHaveReachedTarget(error)).toBe(true);
    expect(adapter.couldHaveReachedTarget('unknown failure')).toBe(true);
  });

  it.each([
    [json({ code: 'PROGRAM_CONTEXT_GRAPH_FORBIDDEN', status: 403, error: 'wallet not allowed' }), 'PROGRAM_CONTEXT_GRAPH_FORBIDDEN:wallet not allowed'],
    [json({ code: 'BAD', status: 'wrong', error: 'invalid failure schema' }), 'REMOTE_INVOCATION_FAILED:remote error'],
    [new Uint8Array([0xff]), 'REMOTE_INVOCATION_FAILED:remote error'],
    [undefined, 'REMOTE_INVOCATION_FAILED:remote error'],
  ] as const)('classifies an explicit remote rejection as not dispatched to execution', async (outputData, message) => {
    const { adapter, agent } = setup();
    agent.invokeSkill.mockResolvedValue({ success: false, outputData, error: 'remote error' } as Awaited<ReturnType<typeof agent.invokeSkill>>);
    const error = await adapter.dispatch(authorization, input).catch((value: unknown) => value);
    expect(error).toMatchObject({ message });
    expect(adapter.couldHaveReachedTarget(error)).toBe(false);
  });

  it('uses a stable fallback rejection when the peer supplies no failure details', async () => {
    const { adapter, agent } = setup();
    agent.invokeSkill.mockResolvedValue({ success: false } as Awaited<ReturnType<typeof agent.invokeSkill>>);
    await expect(adapter.dispatch(authorization, input)).rejects.toThrow('REMOTE_INVOCATION_FAILED:Remote node rejected the invocation');
    for (const message of ['EXECUTOR_SIGNATURE_UNAVAILABLE', 'INVALID_REMOTE_EXECUTE_ARGUMENT', 'PROGRAM_CONTEXT_GRAPH_FORBIDDEN:denied']) {
      expect(adapter.couldHaveReachedTarget(new Error(message))).toBe(false);
    }
  });

  it.each([undefined, new Uint8Array([0xff]), new TextEncoder().encode('{'), json(null), json({})])('rejects malformed successful response bytes', async (outputData) => {
    const { adapter, agent } = setup();
    agent.invokeSkill.mockResolvedValue({ success: true, outputData } as Awaited<ReturnType<typeof agent.invokeSkill>>);
    await expect(adapter.dispatch(authorization, input)).rejects.toThrow('REMOTE_INVOCATION_RESPONSE_INVALID');
  });

  it.each([
    ['wm', { invocationId: 'different' }, undefined],
    ['wm', { executionLayer: 'swm' }, undefined],
    ['wm', { persisted: false }, undefined],
    ['wm', { executionIri: '' }, undefined],
    ['wm', { executionIri: ' \t\n' }, undefined],
    ['wm', { executionIri: 123 }, undefined],
    ['wm', { executionUal: 'did:dkg:unexpected' }, undefined],
    ['wm', {}, 'did:dkg:unexpected'],
    ['vm', { executionUal: undefined }, undefined],
    ['vm', { executionUal: '' }, ''],
    ['vm', { executionUal: ' \t\n' }, ' \t\n'],
    ['vm', { executionUal: 'did:dkg:receipt' }, 'did:dkg:different'],
  ] as const)('rejects uncorrelated, unpersisted or invalid %s execution receipts', async (layer, changes, resultUal) => {
    const { adapter, agent } = setup(layer);
    agent.invokeSkill.mockImplementation(async (_node, _skill, payload) => {
      const invocation = JSON.parse(new TextDecoder().decode(payload)) as SemanticInboxInvocationV2;
      return { success: true, outputData: json({ invocationId: invocation.invocationId, executionIri: 'urn:sr:execution:child', executionLayer: layer, persisted: true, ...changes }), ...(resultUal !== undefined ? { resultUal } : {}) };
    });
    const error = await adapter.dispatch(authorization, input).catch((value: unknown) => value);
    expect(error).toMatchObject({ message: 'REMOTE_INVOCATION_RESPONSE_INVALID' });
    expect(adapter.couldHaveReachedTarget(error)).toBe(true);
  });
});
