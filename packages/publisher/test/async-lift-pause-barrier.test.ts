import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/async-lift-publisher-impl.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('acknowledged publisher pause is a claim boundary', () => {
  it('waits for a claim that passed the pause check before acknowledging the pause', async () => {
    const store = new OxigraphStore();
    const publisher = new TripleStoreAsyncLiftPublisher(store);
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const entered = deferred();
    const release = deferred();
    const query = store.query.bind(store);
    store.query = async (...args) => {
      const result = await query(...args);
      if (args[1]?.source === 'publisher.asyncLift.walletLock.ownership') {
        entered.resolve(); await release.promise;
      }
      return result;
    };
    const claim = publisher.claimNext('wallet-before');
    await entered.promise;
    let acknowledged = false;
    const pausing = publisher.pause().then(() => { acknowledged = true; });
    try {
      await new Promise<void>(done => setImmediate(done));
      expect(acknowledged, 'Pause must not acknowledge ahead of an in-flight claim commit').toBe(false);
    } finally { release.resolve(); await Promise.all([claim, pausing]); }
    expect((await claim)?.jobId).toBe(jobId);
    expect(acknowledged).toBe(true);
    expect(await publisher.claimNext('wallet-after')).toBeNull();
    expect((await publisher.getStatus(jobId))?.status).toBe('claimed');
    await store.close();
  });

  it('keeps accepted evidence intact for every wallet and permits claims after resume', async () => {
    const store = new OxigraphStore();
    const publisher = new TripleStoreAsyncLiftPublisher(store);
    const id = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const before = await publisher.getStatus(id);
    await publisher.pause();
    expect(await Promise.all(['a', 'b', 'c'].map(wallet => publisher.claimNext(wallet)))).toEqual([null, null, null]);
    expect(await publisher.getStatus(id)).toEqual(before);
    await publisher.resume();
    expect((await publisher.claimNext('b'))?.jobId).toBe(id);
    await store.close();
  });
});
