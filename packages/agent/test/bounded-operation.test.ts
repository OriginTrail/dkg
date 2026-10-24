import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';
import {
  BoundedOperationTimeoutError,
  runBoundedOperation,
  throwIfOperationAborted,
} from '../src/bounded-operation.js';

describe('runBoundedOperation', () => {
  it('does not start work when the caller is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller stopped'));
    const start = vi.fn(async () => 'unreachable');

    await expect(runBoundedOperation(start, {
      label: 'pre-aborted read',
      timeoutMs: 100,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError', message: 'caller stopped' });
    expect(start).not.toHaveBeenCalled();
  });

  it('bounds non-cooperative work with a typed timeout', async () => {
    vi.useFakeTimers();
    try {
      let operationSignal: AbortSignal | undefined;
      const result = runBoundedOperation(
        (signal) => {
          operationSignal = signal;
          return new Promise<string>(() => undefined);
        },
        { label: 'hung read', timeoutMs: 25 },
      );
      const assertion = expect(result).rejects.toEqual(
        new BoundedOperationTimeoutError('hung read', 25),
      );
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
      expect(operationSignal?.aborted).toBe(true);
      expect(operationSignal?.reason).toEqual(
        new BoundedOperationTimeoutError('hung read', 25),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a caller abort while work is pending', async () => {
    const controller = new AbortController();
    let operationSignal: AbortSignal | undefined;
    const result = runBoundedOperation(
      (signal) => {
        operationSignal = signal;
        return new Promise<string>(() => undefined);
      },
      { label: 'aborted read', timeoutMs: 1_000, signal: controller.signal },
    );
    controller.abort('cancelled');

    await expect(result).rejects.toMatchObject({ name: 'AbortError', message: 'cancelled' });
    expect(operationSignal?.aborted).toBe(true);
    expect(operationSignal?.reason).toBe('cancelled');
  });

  it('preserves dependency rejections', async () => {
    const dependencyError = new Error('RPC rejected');
    await expect(runBoundedOperation(
      async () => { throw dependencyError; },
      { label: 'failed read', timeoutMs: 100 },
    )).rejects.toBe(dependencyError);
  });
});

describe('canonical abort admission', () => {
  it('allows absent or live signals without starting any cancellation', () => {
    expect(() => throwIfOperationAborted(undefined)).not.toThrow();
    expect(() => throwIfOperationAborted(new AbortController().signal)).not.toThrow();
  });
  it('keeps an existing AbortError identity and an ordinary Error as cause', () => {
    const abort = new Error('already cancelled'); abort.name = 'AbortError';
    const existing = new AbortController(); existing.abort(abort);
    let caught: unknown; try { throwIfOperationAborted(existing.signal); } catch (error) { caught = error; }
    expect(caught).toBe(abort);
    const reason = new Error('caller closed'), ordinary = new AbortController(); ordinary.abort(reason);
    try { throwIfOperationAborted(ordinary.signal); throw new Error('work was admitted'); }
    catch (error) { expect(error).toMatchObject({ name: 'AbortError', message: 'caller closed', cause: reason }); }
  });
  it.each([['cancelled', 'cancelled'], [undefined, 'This operation was aborted'], [42, 'aborted']])('normalizes caller reason %j', (reason, message) => {
    const controller = new AbortController(); controller.abort(reason);
    expect(() => throwIfOperationAborted(controller.signal)).toThrow(expect.objectContaining({ name: 'AbortError', message }));
  });
});


describe('sync authorization cancellation at the real owner', () => {
  it('refuses an already cancelled request before checking graph privacy', async () => {
    const controller = new AbortController(); controller.abort('request closed');
    const isPrivateContextGraph = vi.fn();
    await expect(ContextGraphResolveMethods.prototype.authorizeSyncRequest.call(
      { isPrivateContextGraph } as never, {} as never, 'peer', { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError', message: 'request closed' });
    expect(isPrivateContextGraph).not.toHaveBeenCalled();
  });

  it('refuses late privacy completion after cancellation', async () => {
    const controller = new AbortController();
    const isPrivateContextGraph = vi.fn(async () => { controller.abort('privacy read retired'); return false; });
    await expect(ContextGraphResolveMethods.prototype.authorizeSyncRequest.call(
      { isPrivateContextGraph } as never, {} as never, 'peer', { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError', message: 'privacy read retired' });
  });

  it.each([false, true])('keeps signed private identity checks fenced when cancellation is %s', async cancelled => {
    const wallet = ethers.Wallet.createRandom(), controller = new AbortController();
    const request = { contextGraphId: 'private-cg', offset: 0, limit: 1, includeSharedMemory: false,
      targetPeerId: 'local-peer', requesterPeerId: 'remote-peer', requestId: 'identity-request',
      issuedAtMs: Date.now(), requesterIdentityId: '1', recovery: true };
    const digest = ContextGraphResolveMethods.prototype.computeSyncDigest(
      request.contextGraphId, 0, 1, false, 'local-peer', 'remote-peer', request.requestId, request.issuedAtMs, undefined,
    );
    const signature = ethers.Signature.from(await wallet.signMessage(digest));
    const getMemberRecoveryGate = vi.fn(async () => [wallet.address]);
    const agent = { peerId: 'local-peer', seenPrivateSyncRequestIds: new Map(),
      isPrivateContextGraph: async () => true, computeSyncDigest: ContextGraphResolveMethods.prototype.computeSyncDigest,
      chain: { verifySyncIdentity: vi.fn(async () => { if (cancelled) controller.abort('identity read retired'); return true; }) },
      getPrivateContextGraphParticipants: async () => [], getContextGraphAllowedPeers: async () => [],
      getContextGraphAgentGateAddresses: async () => [], getContextGraphAllowedDelegateePeers: async () => new Map(),
      getContextGraphAllowedDelegateeKeys: async () => new Map(), getMemberRecoveryGate,
      refreshMetaFromCurator: async () => false, log: { warn: () => {}, info: () => {} } };
    const outcome = ContextGraphResolveMethods.prototype.authorizeSyncRequest.call(agent as never,
      { ...request, requesterSignatureR: signature.r, requesterSignatureVS: signature.yParityAndS },
      'remote-peer', { signal: controller.signal });
    if (cancelled) {
      await expect(outcome).rejects.toMatchObject({ name: 'AbortError', message: 'identity read retired' });
      expect(getMemberRecoveryGate).not.toHaveBeenCalled();
      expect(agent.seenPrivateSyncRequestIds.size).toBe(0);
    } else {
      await expect(outcome).resolves.toBe(true);
      expect(getMemberRecoveryGate).toHaveBeenCalledOnce();
    }
  });
});
