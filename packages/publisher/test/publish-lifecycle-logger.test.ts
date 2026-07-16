import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger, type LogRecord } from '@origintrail-official/dkg-core';
import { PublishLifecycleLogger } from '../src/publish-lifecycle-logger.js';

describe('PublishLifecycleLogger', () => {
  afterEach(() => {
    Logger.setSink(null);
  });

  it('owns asset UAL resolution once and emits named publish milestones', async () => {
    const entries: LogRecord[] = [];
    Logger.setSink((entry) => entries.push(entry));
    const resolveAssetUal = vi.fn(async (kaId: bigint) => `did:dkg:evm:31337/0xasset/${kaId}`);
    const lifecycle = new PublishLifecycleLogger({
      log: new Logger('PublishLifecycleLoggerTest'),
      ctx: { operationId: 'op-publish-lifecycle', operationName: 'publish' },
      localPeerId: 'publisher-peer',
      localNodeIdentityId: '7',
      resolveAssetUal,
    });

    await lifecycle.rememberAssetUal(7n);
    await lifecycle.rememberAssetUal(8n);
    lifecycle.emit('identity', 'asset_ual_allocated', { metadata: { contextGraphId: '42', kaId: '7' } });
    lifecycle.emit('wm', 'write', { metadata: { contextGraphId: '42', recordCount: 2 } });
    lifecycle.emit('storage_ack', 'request', { metadata: { contextGraphId: '42', outcome: 'request' } });
    lifecycle.emit('chain', 'confirm', { metadata: { contextGraphId: '42', kaId: '7', txHash: '0xabc' } });
    lifecycle.emit('finalization', 'complete', { metadata: { kaId: '7', status: 'confirmed' } });

    expect(resolveAssetUal).toHaveBeenCalledTimes(1);
    expect(entries.map((entry) => entry.message)).toEqual([
      expect.stringContaining('stage=identity event=asset_ual_allocated'),
      expect.stringContaining('stage=wm event=write'),
      expect.stringContaining('stage=storage_ack event=request'),
      expect.stringContaining('stage=chain event=confirm'),
      expect.stringContaining('stage=finalization event=complete'),
    ]);
    expect(entries.every((entry) => entry.message.includes('assetUal=did:dkg:evm:31337/0xasset/7'))).toBe(true);
  });
});
