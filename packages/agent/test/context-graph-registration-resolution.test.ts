import { describe, expect, it, vi } from 'vitest';
import {
  CHAIN_POLICY_READ_TIMEOUT_MS,
  CONTEXT_GRAPH_NAME_HASH_RESOLUTION_TIMEOUT_MS,
} from '../src/dkg-agent-constants.js';
import {
  LOCAL_ID,
  NAME_HASH,
  selectedFixture,
} from './context-graph-registration-binding.fixture.js';

describe('Context Graph registration resolution deadlines', () => {
  it('marks only a positive cold reverse-name-hash RPC result as pool evidence', async () => {
    const positive = selectedFixture();
    const markPositive = vi.fn();
    await expect(positive.agent.resolveCurrentNameHashContextGraphBinding(
      LOCAL_ID,
      { onRpcRead: markPositive },
    )).resolves.toMatchObject({
      onChainId: '42',
      provenance: 'reverse-name-hash',
    });
    expect(markPositive).toHaveBeenCalledOnce();

    const negative = selectedFixture();
    negative.resolveContextGraphIdByNameHash.mockResolvedValueOnce(null);
    const markNegative = vi.fn();
    await expect(negative.agent.resolveCurrentNameHashContextGraphBinding(
      LOCAL_ID,
      { onRpcRead: markNegative },
    )).resolves.toBeUndefined();
    expect(markNegative).not.toHaveBeenCalled();
  });

  it('suspends current and finalized authority discovery while registration is in flight', async () => {
    const fixture = selectedFixture();
    Reflect.set(fixture.agent, 'contextGraphRegistrationsInFlight', new Set([LOCAL_ID]));

    await expect(fixture.agent.resolveCurrentNameHashContextGraphBinding(LOCAL_ID))
      .rejects.toThrow('chain binding discovery is suspended');
    await expect(fixture.agent.resolveFinalizedContextGraphAuthorityTargetV1(LOCAL_ID))
      .rejects.toThrow('finalized authority discovery is suspended');

    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('keeps an explicitly local-created unregistered graph independent of chain RPC', async () => {
    const fixture = selectedFixture();
    fixture.agent.localContextGraphProvenance.recordLocalCreate(LOCAL_ID);
    fixture.query.mockResolvedValueOnce({
      type: 'bindings',
      bindings: [{ status: '"unregistered"' }],
    });
    fixture.resolveContextGraphIdByNameHash.mockRejectedValueOnce(
      new Error('chain RPC is unavailable'),
    );

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
      .resolves.toEqual({ kind: 'unregistered' });
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('reconciles a durable pending registration against chain authority', async () => {
    const fixture = selectedFixture();
    fixture.agent.localContextGraphProvenance.recordLocalCreate(LOCAL_ID);
    fixture.query.mockResolvedValueOnce({
      type: 'bindings',
      bindings: [{ status: '"pending"' }],
    });

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
      .resolves.toEqual({
        kind: 'registered',
        onChainId: 42n,
        provenance: 'reverse-name-hash',
      });
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledOnce();
  });

  it('rejects local-first proof when a numeric chain binding exists', async () => {
    const fixture = selectedFixture();
    fixture.agent.localContextGraphProvenance.recordLocalCreate(LOCAL_ID);
    fixture.subscription.onChainId = '42';
    fixture.query.mockResolvedValue({
      type: 'bindings',
      bindings: [{ status: '"unregistered"' }],
    });

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
      .resolves.toMatchObject({
        kind: 'registered',
        onChainId: 42n,
      });

    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
    expect(fixture.query.mock.calls.some(([, options]) =>
      options?.source === 'agent.contextGraph.registrationStatus'
    )).toBe(false);
  });

  it('does not infer unregistered when the durable local marker is missing', async () => {
    const fixture = selectedFixture();
    fixture.agent.localContextGraphProvenance.recordLocalCreate(LOCAL_ID);

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
      .resolves.toEqual({
        kind: 'registered',
        onChainId: 42n,
        provenance: 'reverse-name-hash',
      });
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledOnce();
  });

  it('uses the cold deadline by default for a local graph with no binding candidate', async () => {
    vi.useFakeTimers();
    try {
      const fixture = selectedFixture();
      const resolveDirect = vi.spyOn(fixture.agent, 'resolveContextGraphOnChainIdBinding')
        .mockImplementation((_contextGraphId, options) => new Promise((_, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        }));

      const binding = fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID);
      await vi.advanceTimersByTimeAsync(CHAIN_POLICY_READ_TIMEOUT_MS);
      const operationSignal = resolveDirect.mock.calls[0]?.[1]?.signal;
      expect(operationSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(
        CONTEXT_GRAPH_NAME_HASH_RESOLUTION_TIMEOUT_MS - CHAIN_POLICY_READ_TIMEOUT_MS,
      );

      expect(operationSignal?.aborted).toBe(true);
      await expect(binding).resolves.toMatchObject({
        kind: 'unavailable',
        reason: 'local-chain-binding-unavailable',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an existing authoritative binding on the zero-RPC fast path', async () => {
    const fixture = selectedFixture();
    fixture.subscription.onChainId = '42';
    const resolveDirect = vi.spyOn(
      fixture.agent,
      'resolveContextGraphOnChainIdBinding',
    );

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
      .resolves.toEqual({
        kind: 'registered',
        onChainId: 42n,
        provenance: 'authoritative',
      });
    expect(resolveDirect).not.toHaveBeenCalled();
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('uses a freshly loaded durable-row binding before the subscription is installed', async () => {
    const fixture = selectedFixture();
    fixture.agent.subscribedContextGraphs.clear();
    fixture.agent.wireIdToLocalCgId.clear();
    const resolveDirect = vi.spyOn(
      fixture.agent,
      'resolveContextGraphOnChainIdBinding',
    );

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID, {
      durableSubscriptionBinding: {
        contextGraphId: LOCAL_ID,
        onChainId: '42',
      },
    })).resolves.toEqual({
      kind: 'registered',
      onChainId: 42n,
      provenance: 'authoritative',
    });

    expect(resolveDirect).not.toHaveBeenCalled();
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('still performs the fresh live policy and roster read after using the durable binding', async () => {
    const fixture = selectedFixture();
    fixture.agent.subscribedContextGraphs.clear();
    fixture.agent.wireIdToLocalCgId.clear();
    const participant = '0x1000000000000000000000000000000000000001';
    const readLiveAuthority = vi.spyOn(
      fixture.agent,
      'resolveLiveOnChainAccessPolicyState',
    ).mockResolvedValue({
      kind: 'available',
      accessPolicy: 1,
      participantAgents: [participant],
    });

    await expect(fixture.agent.resolveRegisteredContextGraphAuthority(LOCAL_ID, {
      durableSubscriptionBinding: {
        contextGraphId: LOCAL_ID,
        onChainId: '42',
      },
    })).resolves.toEqual({
      kind: 'private',
      onChainId: 42n,
      participantAgents: [participant],
    });

    expect(readLiveAuthority).toHaveBeenCalledWith(
      '42',
      expect.objectContaining({ operationName: 'system' }),
      { signal: undefined },
    );
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('lets registration-in-flight override a durable-row binding hint', async () => {
    const fixture = selectedFixture();
    Reflect.set(fixture.agent, 'contextGraphRegistrationsInFlight', new Set([LOCAL_ID]));

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID, {
      durableSubscriptionBinding: {
        contextGraphId: LOCAL_ID,
        onChainId: '42',
      },
    })).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'local-chain-binding-unavailable',
    });
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('lets a durable-row binding override local-first inference without installing the row', async () => {
    const fixture = selectedFixture();
    fixture.agent.subscribedContextGraphs.clear();
    fixture.agent.wireIdToLocalCgId.clear();
    fixture.agent.localContextGraphProvenance.recordLocalCreate(LOCAL_ID);
    fixture.query.mockResolvedValue({
      type: 'bindings',
      bindings: [{ status: '"unregistered"' }],
    });

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID, {
      durableSubscriptionBinding: {
        contextGraphId: LOCAL_ID,
        onChainId: '42',
      },
    })).resolves.toEqual({
      kind: 'registered',
      onChainId: 42n,
      provenance: 'authoritative',
    });
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it('fails closed when a durable-row binding belongs to a different graph', async () => {
    const fixture = selectedFixture();
    fixture.agent.subscribedContextGraphs.clear();
    fixture.agent.wireIdToLocalCgId.clear();

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID, {
      durableSubscriptionBinding: {
        contextGraphId: `${LOCAL_ID}-other`,
        onChainId: '42',
      },
    })).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'local-chain-binding-unavailable',
    });
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it.each([
    ['non-canonical id', '042'],
    ['zero id', '0'],
    ['uint256 overflow', (1n << 256n).toString(10)],
  ] as const)('repairs a malformed durable-row binding only through the finalized index: %s', async (
    _case,
    onChainId,
  ) => {
    const fixture = selectedFixture();
    fixture.agent.subscribedContextGraphs.clear();
    fixture.agent.wireIdToLocalCgId.clear();
    const persistedNameHash = `0x${'cd'.repeat(32)}`;
    const resolveFinalized = vi.fn(async () => 73n);
    const whenIdle = vi.fn(async () => undefined);
    Object.assign(fixture.agent.chain, {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphIdByNameHash: resolveFinalized,
        whenIdle,
      },
    });

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID, {
      durableSubscriptionBinding: {
        contextGraphId: LOCAL_ID,
        onChainId,
        onChainHash: persistedNameHash,
      },
    })).resolves.toEqual({
      kind: 'registered',
      onChainId: 73n,
      provenance: 'name-hash',
    });
    expect(resolveFinalized).toHaveBeenCalledWith(persistedNameHash, expect.any(Object));
    expect(whenIdle).toHaveBeenCalledOnce();
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('does not repair an invalid durable binding through a legacy scalar resolver', async () => {
    const fixture = selectedFixture();
    fixture.agent.subscribedContextGraphs.clear();
    fixture.agent.wireIdToLocalCgId.clear();

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID, {
      durableSubscriptionBinding: { contextGraphId: LOCAL_ID, onChainId: '042' },
    })).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'chain-name-binding-unavailable',
    });
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('rejects invalid durable repair when an index reader has no finalized capability', async () => {
    const fixture = selectedFixture();
    fixture.agent.subscribedContextGraphs.clear();
    fixture.agent.wireIdToLocalCgId.clear();
    const whenIdle = vi.fn(async () => undefined);
    Object.assign(fixture.agent.chain, {
      contextGraphAuthorityIndexRevisionReader: { whenIdle },
    });

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID, {
      durableSubscriptionBinding: { contextGraphId: LOCAL_ID, onChainId: '042' },
    })).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'chain-name-binding-unavailable',
      detail: expect.stringContaining('requires the finalized Context Graph authority index'),
    });
    expect(whenIdle).toHaveBeenCalledOnce();
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('retains compatibility lookup for a valid row on a capability-less index reader', async () => {
    const fixture = selectedFixture();
    const whenIdle = vi.fn(async () => undefined);
    Object.assign(fixture.agent.chain, {
      contextGraphAuthorityIndexRevisionReader: { whenIdle },
    });

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID))
      .resolves.toEqual({
        kind: 'registered',
        onChainId: 42n,
        provenance: 'reverse-name-hash',
      });
    expect(whenIdle).toHaveBeenCalledOnce();
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledOnce();
  });

  it('does not turn invalid durable state into accepted finalized absence', async () => {
    const fixture = selectedFixture();
    fixture.agent.subscribedContextGraphs.clear();
    fixture.agent.wireIdToLocalCgId.clear();
    const resolveFinalized = vi.fn(async () => null);
    Object.assign(fixture.agent.chain, {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphIdByNameHash: resolveFinalized,
        whenIdle: vi.fn(async () => undefined),
      },
    });

    await expect(fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID, {
      durableSubscriptionBinding: { contextGraphId: LOCAL_ID, onChainId: '0' },
      allowAcceptedRfc64FinalizedAbsence: true,
    })).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'finalized-name-absence-unaccepted',
    });
    expect(resolveFinalized).toHaveBeenCalledOnce();
    expect(fixture.resolveContextGraphIdByNameHash).not.toHaveBeenCalled();
  });

  it('rejects uint256 overflow at authoritative and reverse binding write boundaries', () => {
    const fixture = selectedFixture();
    const overflow = (1n << 256n).toString(10);
    const authoritative = {};
    const reverse = {};
    const alreadyInvalid = { onChainId: overflow };

    expect(() => fixture.agent.contextGraphBindingState.bindAuthoritative(
      LOCAL_ID,
      authoritative,
      overflow,
    )).toThrow('Invalid Context Graph on-chain id');
    expect(() => fixture.agent.contextGraphBindingState.bindReverseCandidate(
      LOCAL_ID,
      reverse,
      overflow,
      NAME_HASH,
    )).toThrow('Invalid Context Graph on-chain id');
    expect(() => fixture.agent.contextGraphBindingState.bindReverseCandidate(
      LOCAL_ID,
      alreadyInvalid,
      '42',
      NAME_HASH,
    )).toThrow('Invalid Context Graph on-chain id');
    expect(authoritative).toEqual({});
    expect(reverse).toEqual({});
    expect(alreadyInvalid).toEqual({ onChainId: overflow });
  });

  it('keeps the hot deadline for an existing reverse binding candidate', async () => {
    vi.useFakeTimers();
    try {
      const fixture = selectedFixture();
      fixture.agent.bindSubscriptionReverseNameHashOnChainId(
        LOCAL_ID,
        fixture.subscription,
        '42',
        NAME_HASH,
      );
      const resolveDirect = vi.spyOn(fixture.agent, 'resolveContextGraphOnChainIdBinding')
        .mockImplementation((_contextGraphId, options) => new Promise((_, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        }));

      const binding = fixture.agent.resolveContextGraphRegistrationBinding(LOCAL_ID);
      await vi.advanceTimersByTimeAsync(CHAIN_POLICY_READ_TIMEOUT_MS - 1);
      const operationSignal = resolveDirect.mock.calls[0]?.[1]?.signal;
      expect(operationSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(operationSignal?.aborted).toBe(true);
      await expect(binding).resolves.toMatchObject({
        kind: 'unavailable',
        reason: 'local-chain-binding-unavailable',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not apply the hot-path policy deadline to a cold reverse-index build', async () => {
    vi.useFakeTimers();
    try {
      const fixture = selectedFixture();
      fixture.agent.subscribedContextGraphs.clear();
      fixture.agent.wireIdToLocalCgId.clear();
      fixture.agent.contextGraphNameCommitment = () => NAME_HASH;
      let complete!: (value: bigint | null) => void;
      fixture.resolveContextGraphIdByNameHash.mockReturnValueOnce(
        new Promise<bigint | null>((resolve) => { complete = resolve; }),
      );
  
      const binding = fixture.agent.resolveContextGraphRegistrationBinding(
        'cold-cleartext',
        { registrationTimeoutMs: CONTEXT_GRAPH_NAME_HASH_RESOLUTION_TIMEOUT_MS },
      );
      await vi.advanceTimersByTimeAsync(2_501);
  
      const operationSignal = fixture.resolveContextGraphIdByNameHash.mock.calls[0]?.[1]?.signal;
      expect(operationSignal?.aborted).toBe(false);
      complete(42n);
      await expect(binding).resolves.toEqual({
        kind: 'registered',
        onChainId: 42n,
        provenance: 'name-hash',
      });
    } finally {
      vi.useRealTimers();
    }
  });
  
  it('bounds a bootstrap reverse-index build at the explicit finite deadline', async () => {
    vi.useFakeTimers();
    try {
      const fixture = selectedFixture();
      fixture.agent.subscribedContextGraphs.clear();
      fixture.agent.wireIdToLocalCgId.clear();
      fixture.agent.contextGraphNameCommitment = () => NAME_HASH;
      fixture.resolveContextGraphIdByNameHash.mockReturnValueOnce(
        new Promise<bigint | null>(() => undefined),
      );
  
      const binding = fixture.agent.resolveContextGraphRegistrationBinding(
        'cold-cleartext',
        { registrationTimeoutMs: CONTEXT_GRAPH_NAME_HASH_RESOLUTION_TIMEOUT_MS },
      );
      await vi.advanceTimersByTimeAsync(CONTEXT_GRAPH_NAME_HASH_RESOLUTION_TIMEOUT_MS - 1);
      const operationSignal = fixture.resolveContextGraphIdByNameHash.mock.calls[0]?.[1]?.signal;
      expect(operationSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
  
      expect(operationSignal?.aborted).toBe(true);
      await expect(binding).resolves.toMatchObject({
        kind: 'unavailable',
        reason: 'chain-name-binding-unavailable',
      });
    } finally {
      vi.useRealTimers();
    }
  });
  
  it.each([
    ['policy-read', CHAIN_POLICY_READ_TIMEOUT_MS],
    ['bootstrap-scan', CONTEXT_GRAPH_NAME_HASH_RESOLUTION_TIMEOUT_MS],
  ] as const)('applies the %s deadline to a direct local binding read', async (
    _registrationResolution,
    timeoutMs,
  ) => {
    vi.useFakeTimers();
    try {
      const fixture = selectedFixture();
      const resolveDirect = vi.spyOn(fixture.agent, 'resolveContextGraphOnChainIdBinding')
        .mockImplementation((_contextGraphId, options) => new Promise((_, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        }));
  
      const binding = fixture.agent.resolveContextGraphRegistrationBinding(
        LOCAL_ID,
        { registrationTimeoutMs: timeoutMs },
      );
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      const operationSignal = resolveDirect.mock.calls[0]?.[1]?.signal;
      expect(operationSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
  
      expect(operationSignal?.aborted).toBe(true);
      await expect(binding).resolves.toMatchObject({
        kind: 'unavailable',
        reason: 'local-chain-binding-unavailable',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
