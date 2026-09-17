import { describe, expect, it } from 'vitest';
import {
  PublishAuthorityCache,
  PUBLISH_AUTHORITY_READ_TIMEOUT_MS,
} from '../src/async-lift-publish-authority.js';

const WALLET = '0xd896f0E6000000000000000000000000000000aa';

/**
 * GH#2648 — the claim scan resolves publish authority INSIDE the coordinator's process-wide
 * claim lock. `pointRead` has no per-attempt cap on a single-RPC node (the #894 carve-out), so an
 * `eth_call` that never settles would hold that lock forever: no lane claims anything, and
 * `recoverUnreplacedExpiredClaim` — which takes the same lock — never runs either. Nothing throws,
 * so there is no log line and no failure record to explain the stall.
 */
describe('PublishAuthorityCache read deadline', () => {
  it('degrades a hung authority read to unknown instead of blocking forever', async () => {
    const cache = new PublishAuthorityCache({
      resolveContextGraphId: async () => 453n,
      // Never settles — the shape of a hung single-RPC point read.
      resolveAuthority: () => new Promise(() => {}),
      now: () => 1_000,
      readTimeoutMs: 20,
    });

    await expect(cache.verdictFor('curated', WALLET)).resolves.toEqual({ kind: 'unknown' });
  });

  it('does not memoize the timed-out answer, so the next poll asks again', async () => {
    let settle = false;
    const cache = new PublishAuthorityCache({
      resolveContextGraphId: async () => 453n,
      resolveAuthority: async () => {
        if (!settle) return await new Promise<never>(() => {});
        return {
          kind: 'resolved',
          authorizedWalletIds: [WALLET],
          candidateWalletIds: [WALLET],
        };
      },
      now: () => 1_000,
      readTimeoutMs: 20,
    });

    expect(await cache.verdictFor('curated', WALLET)).toEqual({ kind: 'unknown' });
    // 'unknown' is the answer of a failed read; caching it would pause claiming for a whole TTL.
    settle = true;
    expect(await cache.verdictFor('curated', WALLET)).toEqual({ kind: 'eligible' });
  });

  it('leaves a settling read unaffected', async () => {
    const cache = new PublishAuthorityCache({
      resolveContextGraphId: async () => 453n,
      resolveAuthority: async () => ({
        kind: 'resolved',
        authorizedWalletIds: [],
        candidateWalletIds: [WALLET],
      }),
      now: () => 1_000,
      readTimeoutMs: 1_000,
    });

    expect(await cache.verdictFor('curated', WALLET)).toMatchObject({ kind: 'unpublishable' });
  });

  it('defaults to a bounded ceiling rather than no ceiling', () => {
    expect(PUBLISH_AUTHORITY_READ_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(PUBLISH_AUTHORITY_READ_TIMEOUT_MS)).toBe(true);
  });
});
