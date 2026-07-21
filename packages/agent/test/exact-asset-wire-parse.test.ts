import { afterAll, describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';
import { encodeExactAssetUals, MAX_EXACT_SYNC_ASSETS } from '../src/sync/exact-assets.js';

// #1871 — the exact-KA filter is only as safe as the production wire parsing
// that feeds registerSyncHandler. These tests pin ContextGraphResolveMethods.
// parseSyncRequest end to end for both wire formats: valid filters survive
// normalization, present-but-invalid filters fail closed to [] (responder
// serves nothing), and absent filters stay undefined (full sync).
const UAL_7 = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7';
const UAL_8 = 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/8';

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));

describe('exact-asset wire parsing (parseSyncRequest)', () => {
  let agentPromise: Promise<DKGAgent> | undefined;
  const getAgent = async (): Promise<DKGAgent> => {
    agentPromise ??= DKGAgent.create({ name: 'ExactAssetWireParse', chainAdapter: new MockChainAdapter() });
    return agentPromise;
  };
  afterAll(async () => {
    await (await getAgent()).stop().catch(() => {});
  });

  const parse = async (value: unknown) =>
    (await getAgent() as any).parseSyncRequest(encode(value));

  it('preserves a valid assetUals filter from a JSON envelope', async () => {
    const parsed = await parse({ contextGraphId: 'cg', phase: 'data', assetUals: [UAL_7, UAL_8] });
    expect(parsed.assetUals).toEqual([UAL_7, UAL_8]);
  });

  it('fail-closes present-but-invalid JSON filters to an empty filter, never undefined', async () => {
    for (const bad of [
      ['not-a-ual'],
      [UAL_7, 'not-a-ual'],
      [],
      'not-an-array',
      Array.from({ length: MAX_EXACT_SYNC_ASSETS + 1 }, (_, i) =>
        `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${i}`),
    ]) {
      const parsed = await parse({ contextGraphId: 'cg', phase: 'data', assetUals: bad });
      expect(parsed.assetUals, JSON.stringify(bad)).toEqual([]);
    }
  });

  it('leaves assetUals undefined when a JSON envelope omits it', async () => {
    const parsed = await parse({ contextGraphId: 'cg', phase: 'data' });
    expect(parsed.assetUals).toBeUndefined();
  });

  it('parses the |assets| tail token after legacy session/since tokens', async () => {
    const parsed = await parse(
      `mfacts|0|100|data|session|s-1|since|42|assets|${encodeExactAssetUals([UAL_7])}`,
    );
    expect(parsed.contextGraphId).toBe('mfacts');
    expect(parsed.syncSessionId).toBe('s-1');
    expect(parsed.sinceBatchId).toBe('42');
    expect(parsed.assetUals).toEqual([UAL_7]);
  });

  it('parses the |assets| token without session/since tokens', async () => {
    const parsed = await parse(`mfacts|0|100|data|assets|${encodeExactAssetUals([UAL_7, UAL_8])}`);
    expect(parsed.assetUals).toEqual([UAL_7, UAL_8]);
    expect(parsed.sinceBatchId).toBeUndefined();
    expect(parsed.syncSessionId).toBeUndefined();
  });

  it('fail-closes a malformed pipe assets token to an empty filter', async () => {
    for (const badToken of ['%%%not-json', encodeURIComponent(JSON.stringify(['not-a-ual']))]) {
      const parsed = await parse(`mfacts|0|100|data|assets|${badToken}`);
      expect(parsed.assetUals, badToken).toEqual([]);
    }
  });

  it('leaves assetUals undefined for a legacy pipe request without the token', async () => {
    const parsed = await parse('mfacts|0|100|data|session|s-1|since|42');
    expect(parsed.assetUals).toBeUndefined();
    expect(parsed.sinceBatchId).toBe('42');
  });
});
