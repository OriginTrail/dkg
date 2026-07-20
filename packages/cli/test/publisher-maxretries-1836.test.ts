import { afterEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { createPublisherControlFromStore } from '../src/publisher-runner.js';

// GH #1836 — the daemon HTTP admission path builds its async-lift publisher via
// createPublisherControlFromStore(). That constructor used to drop maxRetries,
// so a node configured `publisher.maxRetries: 0` still stamped the built-in
// default (10) onto every API-admitted VM-publish job. These regressions pin
// the value end to end: enqueue admits through the fixed function and the
// assertion reads the value back off the PERSISTED job (serialize → readJob),
// so a literal 0 must survive the constructor's `?? DEFAULT_MAX_RETRIES` guard
// and the JSON round-trip.

describe('#1836 publisher.maxRetries propagation through createPublisherControlFromStore', () => {
  const stores: OxigraphStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  });

  function newStore(): OxigraphStore {
    const store = new OxigraphStore();
    stores.push(store);
    return store;
  }

  // Minimal, well-formed graph-scoped VM-publish intent (mirrors the shape used
  // by the publisher package's broadcast-progress suite).
  function kaVmPublishRequest() {
    const authorAddress = '0x1111111111111111111111111111111111111111';
    const kaNumber = 7n;
    const kaUal = `did:dkg:31337/${authorAddress}/${kaNumber.toString()}`;
    return {
      contextGraphId: 'music-social',
      name: 'albums',
      shareOperationId: 'share-op-1',
      roots: [] as string[],
      contentScopeVersion: 2 as const,
      kaUal,
      assertionVersion: '1',
      publicTripleCount: 2,
      privateTripleCount: 0,
      seal: {
        merkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
        authorAddress: authorAddress as `0x${string}`,
        signature: {
          r: (`0x${'34'.repeat(32)}`) as `0x${string}`,
          vs: (`0x${'56'.repeat(32)}`) as `0x${string}`,
        },
        schemeVersion: 1,
        reservedKaId: ((BigInt(authorAddress) << 96n) | kaNumber).toString() as `${bigint}`,
      },
      sealChainId: '31337' as `${bigint}`,
      sealKav10Address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
      sealMerkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
      intentKey: `sha256:${'ab'.repeat(32)}`,
      wmCurrentAssertion: '12'.repeat(32),
      swmCurrentAssertion: '12'.repeat(32),
      kaNumber: kaNumber.toString(),
      reservedUal: kaUal,
    };
  }

  it('stamps a configured literal 0 (never the default) onto admitted jobs', async () => {
    const control = createPublisherControlFromStore(newStore(), undefined, 0);
    const jobId = await control.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const job = await control.getStatus(jobId);
    expect(job?.retries.maxRetries).toBe(0);
  });

  it('preserves the built-in default (10) when maxRetries is omitted', async () => {
    const control = createPublisherControlFromStore(newStore(), undefined);
    const jobId = await control.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const job = await control.getStatus(jobId);
    expect(job?.retries.maxRetries).toBe(10);
  });

  it('propagates an arbitrary configured budget', async () => {
    const control = createPublisherControlFromStore(newStore(), undefined, 3);
    const jobId = await control.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const job = await control.getStatus(jobId);
    expect(job?.retries.maxRetries).toBe(3);
  });
});
