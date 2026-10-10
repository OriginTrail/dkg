import { describe, expect, it, vi } from 'vitest';
import { waitForAdvertisedOrLiveProtocol } from '../src/p2p/protocol-readiness.js';

const PEER = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const PROTOCOLS = ['/dkg/10.0.2/sync', '/dkg/10.0.3/sync'] as const;

function options(advertised: string[] = []) {
  const peerStore = { get: vi.fn(async () => ({ protocols: advertised })) };
  const isConnected = vi.fn((): boolean => true);
  const probe = vi.fn(async (_peerId: string, _protocol: string, _signal?: AbortSignal): Promise<'supported' | 'unsupported' | 'unavailable'> => 'supported');
  return { peerStore, peer: { toString: () => PEER }, protocols: PROTOCOLS,
    attempts: 1, delayMs: 0, isConnected, probe };
}

describe('live sync protocol readiness after a stale Identify record', () => {
  it('negotiates a connected peer when its cached protocols are incomplete', async () => {
    const input = options();
    expect(await waitForAdvertisedOrLiveProtocol(input)).toBe(true);
    expect(input.probe).toHaveBeenCalledWith(PEER, PROTOCOLS[0], undefined);
  });

  it('uses a current advertisement without a probe', async () => {
    const input = options([PROTOCOLS[1]]);
    expect(await waitForAdvertisedOrLiveProtocol(input)).toBe(true);
    expect(input.probe).not.toHaveBeenCalled();
  });

  it('does not dial a disconnected peer with missing metadata', async () => {
    const input = options();
    input.isConnected.mockReturnValue(false);
    expect(await waitForAdvertisedOrLiveProtocol(input)).toBe(false);
    expect(input.probe).not.toHaveBeenCalled();
  });

  it('tries the pooled sync wire when the original wire is unsupported', async () => {
    const input = options();
    input.probe.mockResolvedValueOnce('unsupported');
    expect(await waitForAdvertisedOrLiveProtocol(input)).toBe(true);
    expect(input.probe).toHaveBeenCalledTimes(2);
  });

  it('honors cancellation during a live probe', async () => {
    const input = options();
    const controller = new AbortController();
    input.probe.mockImplementationOnce(async () => {
      controller.abort();
      return 'unavailable';
    });
    await expect(waitForAdvertisedOrLiveProtocol({ ...input, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
