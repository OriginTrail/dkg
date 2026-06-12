import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';

describe('production sync delta activation guard', () => {
  let agent: DKGAgent | undefined;
  const originalDeltaFlag = process.env.DKG_SYNC_DELTA;

  afterEach(async () => {
    if (originalDeltaFlag === undefined) delete process.env.DKG_SYNC_DELTA;
    else process.env.DKG_SYNC_DELTA = originalDeltaFlag;
    await agent?.stop().catch(() => {});
    agent = undefined;
    vi.restoreAllMocks();
  });

  it('does not infer a sinceBatchId high-water mark from DKG_SYNC_DELTA=1', async () => {
    process.env.DKG_SYNC_DELTA = '1';
    agent = await DKGAgent.create({
      name: 'DeltaActivationGuard',
      listenPort: 0,
      listenHost: '127.0.0.1',
      store: new OxigraphStore(),
      chainAdapter: new NoChainAdapter(),
      skills: [],
    });

    const fetchCalls: unknown[][] = [];
    vi.spyOn(agent as any, 'fetchSyncPages').mockImplementation(async (...args: unknown[]) => {
      fetchCalls.push(args);
      return {
        quads: [],
        bytesReceived: 0,
        resumedFromOffset: 0,
        nextOffset: 0,
        checkpointKey: `${args[1]}|${args[2]}|${args[4]}`,
        completed: true,
      };
    });
    vi.spyOn(agent as any, 'processDurableBatchInWorker').mockResolvedValue({
      verifiedData: [],
      verifiedMeta: [],
      totalFetchedDataQuads: 0,
      totalFetchedMetaQuads: 0,
      rejectedKcs: 0,
      emptyResponses: 1,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    });
    const warnSpy = vi.spyOn((agent as any).log, 'warn').mockImplementation(() => {});

    await agent.syncFromPeerDetailed('peer-delta', ['delta-cg']);
    await agent.syncFromPeerDetailed('peer-delta', ['delta-cg']);

    expect(fetchCalls).toHaveLength(4);
    expect(fetchCalls.map((args) => args[8])).toEqual([undefined, undefined, undefined, undefined]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toContain('DKG_SYNC_DELTA=1 is not activated');
  });
});
