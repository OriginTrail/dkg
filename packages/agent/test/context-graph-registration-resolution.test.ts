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
  it('falls back to the current resolver when the finalized index reader is unavailable', async () => {
    const fixture = selectedFixture(17n);
    const resolveFinalized = vi.fn(async () => {
      throw new Error('reader unavailable');
    });
    Object.assign(fixture.agent.chain, {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphIdByNameHash: resolveFinalized,
      },
    });

    await expect(fixture.agent.getContextGraphOnChainId(LOCAL_ID, {
      consistency: 'finalized-authority-index',
    })).resolves.toBe('17');

    expect(resolveFinalized).toHaveBeenCalledWith(NAME_HASH, {
      signal: undefined,
    });
    expect(fixture.resolveContextGraphIdByNameHash).toHaveBeenCalledOnce();
  });

  it('propagates finalized-reader cancellation without calling the current resolver', async () => {
    const fixture = selectedFixture(17n);
    const controller = new AbortController();
    const abortReason = new Error('listing enrichment cancelled');
    const resolveFinalized = vi.fn(async () => {
      throw new Error('reader stopped');
    });
    Object.assign(fixture.agent.chain, {
      contextGraphAuthorityIndexRevisionReader: {
        resolveFinalizedContextGraphIdByNameHash: resolveFinalized,
      },
    });
    controller.abort(abortReason);

    await expect(fixture.agent.getContextGraphOnChainId(LOCAL_ID, {
      consistency: 'finalized-authority-index',
      signal: controller.signal,
    })).rejects.toBe(abortReason);

    expect(resolveFinalized).toHaveBeenCalledWith(NAME_HASH, {
      signal: controller.signal,
    });
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

  it('keeps the hot deadline for an existing authoritative binding candidate', async () => {
    vi.useFakeTimers();
    try {
      const fixture = selectedFixture();
      fixture.subscription.onChainId = '42';
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
