/**
 * Regression test for GH #1013 — "Private publishAsync can finalize locally
 * with provisional UAL but no on-chain provenance".
 * https://github.com/OriginTrail/dkg/issues/1013
 *
 * Fix: a `tentative` publish that skipped chain because a PRIVATE payload had
 * no collectable storage ACKs (`localChainSkipReason: 'private-no-acks'`) must
 * NOT be mapped to `finalized` with a provisional UAL — the caller asked for a
 * VM publish on a chain-registered CG and it never reached chain. It now fails
 * honestly (data is still staged locally under the provisional UAL, surfaced in
 * the error). A genuinely-local publish (`no-chain`) still finalizes(local).
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

describe('GH #1013 — local async finalization honesty', () => {
  it('does NOT finalize a private publish that could not reach its chain-registered CG', () => {
    const res = baseResult({ status: 'tentative', localChainSkipReason: 'private-no-acks' });
    expect(() => mapPublishResultToLiftJobSuccess({ publishResult: res, walletId: 'w1' }))
      .toThrowError(/NOT on chain|could not reach Verifiable Memory/i);
  });

  it('the failure surfaces the provisional UAL so the local data is recoverable', () => {
    const res = baseResult({ status: 'tentative', localChainSkipReason: 'private-no-acks' });
    expect(() => mapPublishResultToLiftJobSuccess({ publishResult: res, walletId: 'w1' }))
      .toThrowError(/tmq-provisional-1/);
  });

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
