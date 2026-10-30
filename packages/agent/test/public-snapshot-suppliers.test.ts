import { afterEach, describe, expect, it, vi } from 'vitest';
import { BULK_GRAPH_PROTOCOL, PUBLIC_CHECKPOINT_PROTOCOL } from '@origintrail-official/dkg-core';
import { publicSnapshotSuppliers } from '../src/public-snapshot-suppliers.js';
import { preparePublicSnapshotCheckpoint } from '../src/public-snapshot-checkpoint.js';
import { checkpointFixture } from './helpers/public-checkpoint-fixture.js';

afterEach(() => vi.restoreAllMocks());

describe.each([BULK_GRAPH_PROTOCOL, PUBLIC_CHECKPOINT_PROTOCOL])('supplier discovery for %s', protocol => {
  it('preserves batch order, skips refusal/unavailable peers, and bounds negotiation by remaining time', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const controller = new AbortController();
    const connected: string[] = [];
    const host = {
      ensurePeerConnected: vi.fn(async (peer: string) => { connected.push(peer); if (peer === 'offline') throw new Error('offline'); }),
      router: { probeProtocol: vi.fn(async (peer: string, _protocol: string, _timeout: number, _signal?: AbortSignal) => {
        if (peer === 'refuses') throw new Error('refusal');
        if (peer === 'old') return 'unsupported' as const;
        if (peer === 'missing') return 'unavailable' as const;
        return 'supported' as const;
      }) },
    };
    const iterator = publicSnapshotSuppliers(host, { protocol, signal: controller.signal, deadline: 1_250,
      assertCurrent: () => {}, deadlineMessage: 'expired',
      peerBatches: async function* () { yield ['offline', 'refuses', 'old', 'first']; yield ['missing', 'second']; },
    });
    expect(await iterator.next()).toEqual({ done: false, value: 'first' });
    expect(connected).toEqual(['offline', 'refuses', 'old', 'first']);
    expect(await iterator.next()).toEqual({ done: false, value: 'second' });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(connected).toEqual(['offline', 'refuses', 'old', 'first', 'missing', 'second']);
    for (const call of host.router.probeProtocol.mock.calls) expect(call.slice(1)).toEqual([protocol, 250, controller.signal]);
  });

  it.each(['cancel', 'ownership', 'deadline'] as const)('stops after connection or negotiation when %s changes', async mode => {
    for (const stage of ['connect', 'probe']) {
      let now = 1_000, current = true;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      const controller = new AbortController(), reason = new Error('retired');
      const retire = () => {
        if (mode === 'cancel') controller.abort(reason);
        else if (mode === 'ownership') current = false;
        else now = 2_000;
      };
      const host = {
        ensurePeerConnected: vi.fn(async () => { if (stage === 'connect') retire(); }),
        router: { probeProtocol: vi.fn(async () => { retire(); return 'supported' as const; }) },
      };
      const iterator = publicSnapshotSuppliers(host, { protocol, signal: controller.signal, deadline: 2_000,
        assertCurrent: () => { if (!current) throw reason; }, deadlineMessage: 'expired',
        peerBatches: async function* () { yield ['first', 'second']; },
      });
      if (mode === 'deadline') await expect(iterator.next()).rejects.toThrow('expired');
      else await expect(iterator.next()).rejects.toBe(reason);
      expect(host.ensurePeerConnected).toHaveBeenCalledTimes(1);
      expect(host.router.probeProtocol).toHaveBeenCalledTimes(stage === 'probe' ? 1 : 0);
    }
  });
});

it('checkpoint preparation stops on the selected supplier transfer failure instead of trying another core', async () => {
  const f = await checkpointFixture();
  const failure = new Error('selected checkpoint stream failed');
  const probe = vi.spyOn(f.router, 'probeProtocol').mockResolvedValue('supported');
  const exchange = vi.spyOn(f.router, 'withDuplexStream').mockRejectedValue(failure);
  const connect = vi.fn(async () => {});
  await expect(preparePublicSnapshotCheckpoint({ router: f.router, ensurePeerConnected: connect }, {
    initial: f.initial, readFresh: f.readFresh, dataDir: f.directory, signal: f.abort.signal,
    deadline: Date.now() + 30_000, assertCurrent: () => {},
    peerBatches: async function* () { yield [f.supplierPeer, 'backup']; },
  })).rejects.toBe(failure);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(exchange).toHaveBeenCalledTimes(1);
  expect(f.readFresh).not.toHaveBeenCalled();
});
