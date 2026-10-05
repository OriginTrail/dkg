import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { ensureCuratorConnected } from '../src/curator-peer-connection.js';

const CURATOR_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const CONTEXT = { kind: 'sync', id: 'curator-connection-test', startedAt: 0 } as OperationContext;

function useControlledTimeouts(): () => void {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
  return () => {
    timeout.mockRestore();
    vi.useRealTimers();
  };
}

function rejectOnAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) {
      reject(new Error('connection attempt must receive an abort signal'));
      return;
    }
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

describe('curator connection deadlines', () => {
  it('advances from a stalled cached-peer dial to the resolver after five seconds', async () => {
    const restoreTimeouts = useControlledTimeouts();
    try {
      let connected = false;
      const events: string[] = [];
      let markDialStarted: () => void = () => undefined;
      const dialStarted = new Promise<void>((resolve) => { markDialStarted = resolve; });
      const agent = {
        node: {
          libp2p: {
            getConnections: () => connected
              ? [{ remotePeer: { toString: () => CURATOR_PEER_ID } }]
              : [],
            dial: (_target: unknown, options?: { signal?: AbortSignal }) => {
              events.push('cached dial');
              markDialStarted();
              return rejectOnAbort(options?.signal);
            },
            peerStore: { merge: async () => undefined },
          },
        },
        peerResolver: {
          connect: async () => {
            events.push('resolver');
            connected = true;
            return { status: 'connected' as const, resolvedAddresses: [] };
          },
        },
        log: { warn: vi.fn() },
      };
      const result = ensureCuratorConnected(agent as never, CURATOR_PEER_ID, undefined, CONTEXT, () => undefined);
      await dialStarted;
      await vi.advanceTimersByTimeAsync(4_999);
      expect(events).toEqual(['cached dial']);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe(true);
      expect(events).toEqual(['cached dial', 'resolver']);
    } finally {
      restoreTimeouts();
    }
  });

  it('settles false when resolution remains pending past fifteen seconds', async () => {
    const restoreTimeouts = useControlledTimeouts();
    try {
      let markResolverStarted: () => void = () => undefined;
      const resolverStarted = new Promise<void>((resolve) => { markResolverStarted = resolve; });
      const agent = {
        node: {
          libp2p: {
            getConnections: () => [],
            dial: async () => { throw new Error('cached address unavailable'); },
            peerStore: { merge: async () => undefined },
          },
        },
        peerResolver: {
          connect: (_peerId: string, options: { signal?: AbortSignal }) => {
            markResolverStarted();
            return rejectOnAbort(options.signal);
          },
        },
        log: { warn: vi.fn() },
      };
      let settled = false;
      const result = Promise.resolve(
        ensureCuratorConnected(agent as never, CURATOR_PEER_ID, undefined, CONTEXT, () => undefined),
      ).then((connected) => {
        settled = true;
        return connected;
      });
      await resolverStarted;
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe(false);
      expect(agent.log.warn).toHaveBeenCalledTimes(1);
    } finally {
      restoreTimeouts();
    }
  });
});
