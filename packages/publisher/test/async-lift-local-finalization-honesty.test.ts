/**
 * Local async finalization is only honest when there is genuinely no chain path
 * for the publish. Folded private publishes now collect ACKs and confirm when
 * V2-capable cores are available, so the remaining local success shape is the
 * explicit `no-chain` branch (plus legacy results that predate the reason).
 */
import { describe, expect, it } from 'vitest';
import { mapPublishResultToLiftJobSuccess } from '../src/async-lift-publish-result.js';
import type { PublishResult } from '../src/publisher.js';

function baseResult(over: Partial<PublishResult>): PublishResult {
  return {
    kaId: 0n,
    ual: 'did:dkg:base:84532/0xPub/tmq-provisional-1',
    merkleRoot: new Uint8Array(32),
    kaManifest: [],
    status: 'tentative',
    ...over,
  };
}

describe('local async finalization honesty', () => {
  it('still finalizes(local) for a genuinely no-chain publish', () => {
    const res = baseResult({ status: 'tentative', localChainSkipReason: 'no-chain' });
    const mapped = mapPublishResultToLiftJobSuccess({ publishResult: res, walletId: 'w1' });
    expect(mapped.status).toBe('finalized');
    expect(mapped.finalization?.mode).toBe('local');
  });

  it('still finalizes(local) for a legacy result with no skip reason', () => {
    const res = baseResult({ status: 'tentative', localChainSkipReason: undefined });
    const mapped = mapPublishResultToLiftJobSuccess({ publishResult: res, walletId: 'w1' });
    expect(mapped.status).toBe('finalized');
  });
});
