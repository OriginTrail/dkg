import { describe, expect, it } from 'vitest';
import { createDKG, DKGSDKError } from '../src/index.js';

const baseUrl = process.env.DKG_SDK_INTEGRATION_BASE_URL;
const token = process.env.DKG_SDK_INTEGRATION_TOKEN;

const integrationDescribe = baseUrl ? describe : describe.skip;

integrationDescribe('SDK integration against local daemon', () => {
  const dkg = () =>
    createDKG({
      baseUrl: baseUrl!,
      token,
      timeoutMs: 35_000,
    });

  it('reads /api/status through dkg.node.status()', async () => {
    const status = await dkg().node.status();
    expect(typeof status.peerId).toBe('string');
    expect(status.peerId.length).toBeGreaterThan(0);
    expect(Array.isArray(status.multiaddrs)).toBe(true);
  }, 30_000);

  it('reads /api/paranet/list through dkg.paranet.list()', async () => {
    let list;
    try {
      list = await dkg().paranet.list();
    } catch (err) {
      if (err instanceof DKGSDKError && err.code === 'ETIMEDOUT') {
        // Some local nodes can be busy with background sync/query work.
        // Retry once to keep this integration test robust.
        list = await dkg().paranet.list();
      } else {
        throw err;
      }
    }
    expect(Array.isArray(list.paranets)).toBe(true);
  }, 70_000);
});
