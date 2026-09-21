// SPDX-License-Identifier: Apache-2.0

/**
 * The retained fold's anchor fence.
 *
 * `authorityProjection.validateAnchor` was the largest single consumer of
 * `eth_getBlockByNumber` on a measured six-node run — 982 requests, 8.7% of a
 * private cell — spent re-proving a block hash for a projection the event log
 * already had an opinion about. This file pins the one thing that makes taking
 * that read away safe: the fence may answer YES, and it may decline, but it may
 * never answer NO, because the cache reads `false` as proof of a fork and drops
 * the whole scope.
 */

import { describe, expect, it, vi } from 'vitest';

import { contextGraphAuthorityProjectionAnchorProvenByLogV1 } from
  '../src/evm-context-graph-authority-index-reader.js';
import type { ContextGraphAuthorityIndexProjection } from
  '../src/context-graph-authority-index-projection.js';
import type { ChainEventLogAuthoritySource } from '../src/chain-event-log-binding.js';
import type { ChainIndexAuthorityAnchor } from '../src/chain-index/index.js';

const STORAGE = `0x${'cd'.repeat(20)}`.toLowerCase();
const ROTATED = `0x${'ab'.repeat(20)}`.toLowerCase();

const ANCHOR: ChainIndexAuthorityAnchor = Object.freeze({
  finalized: Object.freeze({ number: 900, hash: `0x${'9'.repeat(64)}` }),
  head: Object.freeze({
    number: 900,
    hash: `0x${'9'.repeat(64)}`,
    timestampSeconds: 1_700_000_000,
  }),
  fetchedAtMs: 1_700_000_000_000,
  revision: 42,
  lineage: `0x${'1'.repeat(64)}`,
});

function projection(
  origin: ContextGraphAuthorityIndexProjection['origin'],
): ContextGraphAuthorityIndexProjection {
  return Object.freeze({
    scope: 'evm:31337:0xhub:' + STORAGE,
    chainId: '31337',
    contractAddress: STORAGE,
    finalized: Object.freeze({ number: 900, hash: `0x${'9'.repeat(64)}` }),
    head: Object.freeze({
      number: 900,
      hash: `0x${'9'.repeat(64)}`,
      timestampSeconds: 1_700_000_000,
    }),
    requiresAnchorValidation: true,
    view: Object.freeze({}),
    origin,
    fetchedAtMs: 1_700_000_000_000,
  }) as unknown as ContextGraphAuthorityIndexProjection;
}

const LOG_ORIGIN = Object.freeze({
  kind: 'log' as const,
  dataFetchedAtMs: 1_700_000_000_000,
  anchor: ANCHOR,
});

function source(
  anchorHolds: (anchor: ChainIndexAuthorityAnchor) => Promise<boolean>,
  contractAddress = STORAGE,
): ChainEventLogAuthoritySource {
  return {
    contractAddress,
    anchorHolds,
    pageSource: {} as ChainEventLogAuthoritySource['pageSource'],
    resolveAnchor: async () => ({}),
  } as unknown as ChainEventLogAuthoritySource;
}

describe('contextGraphAuthorityProjectionAnchorProvenByLogV1', () => {
  it('proves a log fold whose anchor the tick has not moved, with no chain read', async () => {
    const anchorHolds = vi.fn(async () => true);

    await expect(contextGraphAuthorityProjectionAnchorProvenByLogV1(
      projection(LOG_ORIGIN), source(anchorHolds), STORAGE,
    )).resolves.toBe(true);

    // The whole point: the log answered, so nothing asked a provider.
    expect(anchorHolds).toHaveBeenCalledWith(ANCHOR);
  });

  it('declines rather than denies when the tick has committed since the fold', async () => {
    // A moved revision proves a COMMIT, not a fork. The log names a hash for
    // only its head and its settled boundary, so it cannot speak for the
    // mid-window block a retained fold sits at — and the caller must be free
    // to go and read that block rather than drop the scope.
    await expect(contextGraphAuthorityProjectionAnchorProvenByLogV1(
      projection(LOG_ORIGIN), source(async () => false), STORAGE,
    )).resolves.toBe(false);
  });

  it('declines a scan-origin projection, which carries no anchor at all', async () => {
    const anchorHolds = vi.fn(async () => true);

    await expect(contextGraphAuthorityProjectionAnchorProvenByLogV1(
      projection(Object.freeze({ kind: 'scan' as const })), source(anchorHolds), STORAGE,
    )).resolves.toBe(false);

    expect(anchorHolds).not.toHaveBeenCalled();
  });

  it('declines a log fold recorded before the anchor was carried', async () => {
    // Forward compatibility: an entry retained by an older build has no
    // `anchor`, and absence must read as "cannot prove", never as a mismatch.
    const anchorHolds = vi.fn(async () => true);

    await expect(contextGraphAuthorityProjectionAnchorProvenByLogV1(
      projection(Object.freeze({ kind: 'log' as const, dataFetchedAtMs: 1 })),
      source(anchorHolds),
      STORAGE,
    )).resolves.toBe(false);

    expect(anchorHolds).not.toHaveBeenCalled();
  });

  it('refuses a source the adapter is no longer bound to', async () => {
    // A Hub rotation replaced ContextGraphStorage. The old generation's CAS
    // token must not vouch for rows it no longer owns, so the fence declines
    // and the caller re-proves the block against the chain.
    const anchorHolds = vi.fn(async () => true);

    await expect(contextGraphAuthorityProjectionAnchorProvenByLogV1(
      projection(LOG_ORIGIN), source(anchorHolds, ROTATED), STORAGE,
    )).resolves.toBe(false);

    expect(anchorHolds).not.toHaveBeenCalled();
  });

  it('declines when the runtime holds no log source', async () => {
    await expect(contextGraphAuthorityProjectionAnchorProvenByLogV1(
      projection(LOG_ORIGIN), undefined, STORAGE,
    )).resolves.toBe(false);
  });

  it('hands the fold its OWN anchor, never a freshly resolved one', async () => {
    // Re-resolving would ask whether the log is current with itself, which is
    // trivially true and proves nothing about the retained projection.
    const seen: ChainIndexAuthorityAnchor[] = [];

    await contextGraphAuthorityProjectionAnchorProvenByLogV1(
      projection(LOG_ORIGIN),
      source(async (anchor) => { seen.push(anchor); return true; }),
      STORAGE,
    );

    expect(seen).toEqual([ANCHOR]);
    expect(seen[0]?.revision).toBe(42);
  });
});
