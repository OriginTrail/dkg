import { describe, expect, it } from 'vitest';
import type { AsyncLiftPublishAuthority } from '../src/async-lift-publisher-types.js';
import { PublishAuthorityCache } from '../src/async-lift-publish-authority.js';

const WALLET = '0xd896f0E6000000000000000000000000000000aa';
const TTL_MS = 1_000;

/**
 * GH#2648 — an EMPTY authorized set is the one verdict that destroys a job, and the contract
 * hands one back for reasons that are not refusals.
 *
 * `ContextGraphs.isAuthorizedPublisher` RETURNS `false` rather than reverting when
 * `contextGraphId > getLatestContextGraphId()`, when the graph is inactive, and on every PCA
 * resolution failure. A replica a few blocks behind head right after `createContextGraph` thus
 * produces a successful read with an empty set — which used to fail every job queued for that
 * graph as `authority_forbidden`, `autoRetry:false`, with the empty set cached so the whole
 * window's jobs died with it.
 */
describe('PublishAuthorityCache empty authorized set', () => {
  function cacheOver(
    authority: () => AsyncLiftPublishAuthority,
    clock: { now: number },
  ): { cache: PublishAuthorityCache; reads: () => number } {
    let reads = 0;
    const cache = new PublishAuthorityCache({
      resolveContextGraphId: async () => 453n,
      resolveAuthority: async () => {
        reads += 1;
        return authority();
      },
      now: () => clock.now,
      ttlMs: TTL_MS,
    });
    return { cache, reads: () => reads };
  }

  const empty = (): AsyncLiftPublishAuthority => ({
    kind: 'resolved',
    authorizedWalletIds: [],
    candidateWalletIds: [WALLET],
  });

  it('holds the job on the FIRST empty read instead of condemning it', async () => {
    const clock = { now: 1_000 };
    const { cache } = cacheOver(empty, clock);

    // 'unknown' leaves the job in `accepted` for the next poll. 'unpublishable' would end it.
    expect(await cache.verdictFor('curated', WALLET)).toEqual({ kind: 'unknown' });
  });

  it('does not re-read within the TTL, so the confirming read is one poll later', async () => {
    const clock = { now: 1_000 };
    const { cache, reads } = cacheOver(empty, clock);

    expect(await cache.verdictFor('curated', WALLET)).toEqual({ kind: 'unknown' });
    clock.now += TTL_MS - 1;
    expect(await cache.verdictFor('curated', WALLET)).toEqual({ kind: 'unknown' });
    expect(reads()).toBe(1);
  });

  it('condemns once a second read a TTL later reads back empty again', async () => {
    const clock = { now: 1_000 };
    const { cache, reads } = cacheOver(empty, clock);

    expect(await cache.verdictFor('curated', WALLET)).toEqual({ kind: 'unknown' });
    clock.now += TTL_MS;

    expect(await cache.verdictFor('curated', WALLET)).toEqual({
      kind: 'unpublishable',
      contextGraphId: '453',
      candidateWalletIds: [WALLET],
    });
    expect(reads()).toBe(2);
  });

  it('never condemns a graph the lagging replica catches up on', async () => {
    // The regression: the node reads a graph it has not seen created yet, then catches up.
    const clock = { now: 1_000 };
    let lagging = true;
    const { cache } = cacheOver(
      () => lagging
        ? empty()
        : { kind: 'resolved', authorizedWalletIds: [WALLET], candidateWalletIds: [WALLET] },
      clock,
    );

    expect(await cache.verdictFor('curated', WALLET)).toEqual({ kind: 'unknown' });
    lagging = false;
    clock.now += TTL_MS;

    expect(await cache.verdictFor('curated', WALLET)).toEqual({ kind: 'eligible' });
  });

  it('requires a FRESH pair of empty reads after an authoritative non-empty answer', async () => {
    const clock = { now: 1_000 };
    let lagging = true;
    const { cache } = cacheOver(
      () => lagging
        ? empty()
        : { kind: 'resolved', authorizedWalletIds: [WALLET], candidateWalletIds: [WALLET] },
      clock,
    );

    expect(await cache.verdictFor('curated', WALLET)).toEqual({ kind: 'unknown' });
    lagging = false;
    clock.now += TTL_MS;
    expect(await cache.verdictFor('curated', WALLET)).toEqual({ kind: 'eligible' });

    // Authority was later revoked: the stale first sighting must not confirm this one on its own.
    lagging = true;
    clock.now += TTL_MS;
    expect(await cache.verdictFor('curated', WALLET)).toEqual({ kind: 'unknown' });
    clock.now += TTL_MS;
    expect(await cache.verdictFor('curated', WALLET)).toMatchObject({ kind: 'unpublishable' });
  });
});
