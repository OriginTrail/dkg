import { describe, expect, it } from 'vitest';
import { ContextGraphResolveMethods } from '../src/dkg-agent-cg-resolve.js';

const CURATOR_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const RELAY_ADDR = '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

describe('refreshMetaFromCurator', () => {
  it('passes caller abort signal to direct and relay curator dials', async () => {
    const controller = new AbortController();
    const dialSignals: Array<AbortSignal | undefined> = [];

    const agent = {
      metaRefreshTimestamps: new Map<string, number>(),
      peerId: 'local-peer',
      resolveCuratorPeerId: async () => CURATOR_PEER_ID,
      node: {
        libp2p: {
          getConnections: () => [],
          dial: async (_target: unknown, opts?: { signal?: AbortSignal }) => {
            dialSignals.push(opts?.signal);
            if (dialSignals.length === 1) {
              throw new Error('direct dial unavailable');
            }
          },
          peerStore: {
            merge: async () => undefined,
          },
        },
      },
      discovery: {
        findAgentByPeerId: async () => ({ relayAddress: RELAY_ADDR }),
      },
      fetchSyncPages: async () => {
        throw new Error('should not fetch without a connected curator');
      },
      log: {
        warn: () => undefined,
        info: () => undefined,
      },
    };

    const refreshed = await ContextGraphResolveMethods.prototype.refreshMetaFromCurator.call(
      agent as never,
      'unit-test-cg',
      { signal: controller.signal },
    );

    expect(refreshed).toBe(false);
    expect(dialSignals).toEqual([controller.signal, controller.signal]);
  });
});
