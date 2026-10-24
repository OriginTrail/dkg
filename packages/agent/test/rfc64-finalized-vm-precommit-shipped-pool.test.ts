/**
 * The integration seam this change exists to fix.
 *
 * The chain-package tests prove that `snapshotStrictCurrentFinalizedEvmConfigV1`
 * accepts a three-endpoint pool. They do not prove the thing the change claims:
 * that RFC64's finalized-VM precommit — the only production caller — can now
 * construct its snapshot scope on a shipped network. That claim was previously
 * demonstrated nowhere. The existing precommit suite hardcodes ONE endpoint
 * (`rfc64-finalized-vm-agent-precommit-v1.test.ts`), so it constructed fine both
 * before and after; the defect lived exactly in the gap between the two suites.
 *
 * So this drives the REAL precommit with the REAL shipped pool
 * (`resolveRpcUrls(chain.rpcUrl, chain.rpcUrls)` from `network/testnet.json`,
 * three distinct origins) and stubs only the outermost boundary — global
 * `fetch` — so the endpoints actually dialled are observable.
 *
 * Before the fix this rejected with "requires 1..2 distinct endpoints" and
 * dialled nothing. Both assertions below therefore fail on the unfixed code: the
 * first on the message, the second on an empty dial log.
 */
import { resolveRpcUrls } from '@origintrail-official/dkg-chain';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRfc64FinalizedVmAgentPrecommitV1 } from '../src/rfc64/finalized-vm-agent-precommit-v1.js';
import {
  rfc64FinalizedVmPrecommitOptions,
  rfc64FinalizedVmPrecommitPlan,
} from './support/rfc64-finalized-vm-precommit-fixture.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** Exactly what the daemon hands the precommit: primary PLUS backups. */
function shippedTestnetPool(): string[] {
  const config = JSON.parse(
    readFileSync(join(REPO_ROOT, 'network', 'testnet.json'), 'utf8'),
  );
  return resolveRpcUrls(config.chain.rpcUrl, config.chain.rpcUrls);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RFC-64 finalized VM precommit on a shipped RPC pool', () => {
  it('constructs its snapshot scope and dials the selected endpoints', async () => {
    const pool = shippedTestnetPool();
    // Guards the fixture itself: if `network/testnet.json` ever ships two URLs,
    // this test would silently stop covering the oversized-pool case.
    expect(pool.length).toBe(3);
    expect(new Set(pool.map((url) => new URL(url).origin)).size).toBe(3);

    const dialled: string[] = [];
    vi.stubGlobal('fetch', async (input: unknown) => {
      dialled.push(String(input));
      // Fail the transport, not the construction. Preflight exhausting every
      // selected endpoint is the shortest deterministic path that still proves
      // the scope was built and handed real URLs.
      throw new Error('stubbed transport failure');
    });

    // Only `rpcEndpoints` varies — that is the whole point of this regression.
    const precommit = createRfc64FinalizedVmAgentPrecommitV1(
      rfc64FinalizedVmPrecommitOptions({ rpcEndpoints: pool }),
    );

    // The precommit still fails — there is no chain behind the stub — but it must
    // fail at the TRANSPORT, downstream of scope construction. Every selected
    // endpoint failing preflight retryably surfaces the last retryable failure,
    // which is the JSON-RPC one; the pre-fix failure was a TypeError about the
    // endpoint count, raised before any dial happened at all.
    await expect(
      precommit(rfc64FinalizedVmPrecommitPlan(), new AbortController().signal),
    ).rejects.toThrow(/JSON-RPC eth_chainId transport failed/i);

    // The load-bearing assertion: selection reached the wire. Two of the three
    // shipped endpoints were dialled, in configuration order.
    //
    // Compared as URLs, not as raw strings: the config stores endpoints after
    // `new URL(...)` normalization, so `https://sepolia.base.org` arrives at
    // `fetch` with a trailing slash. Comparing `href` on both sides keeps the
    // assertion about WHICH endpoint was dialled instead of quietly restating
    // the normalizer's spelling rules.
    const href = (url: string) => new URL(url).href;
    expect([...new Set(dialled)]).toEqual([href(pool[0]!), href(pool[1]!)]);
    // And the third is stranded — stated as a tested fact rather than left as a
    // silent consequence. Selection is health-blind and configuration-ordered,
    // so `base-sepolia.drpc.org` is never reached by a strict finalized read even
    // when the primary is degraded. Tracked as a follow-up, not fixed here.
    expect(dialled).not.toContain(href(pool[2]!));
  });
});


