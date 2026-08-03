import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ChainIdV1 } from '@origintrail-official/dkg-core';
import { describe, expect, it } from 'vitest';

import { resolveRpcUrls } from '../src/evm-adapter-rpc.js';
import { snapshotStrictCurrentFinalizedEvmConfigV1 } from '../src/strict-current-finalized-evm-config.js';
import { selectStrictFinalizedEndpointSessionV1 } from '../src/strict-finalized-endpoint-session.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** The pool the product actually builds: primary + backups, deduped. */
function shippedPool(network: string): string[] {
  const cfg = JSON.parse(readFileSync(join(REPO_ROOT, 'network', `${network}.json`), 'utf8'));
  return resolveRpcUrls(cfg.chain.rpcUrl, cfg.chain.rpcUrls);
}

function numericChainId(network: string): ChainIdV1 {
  const cfg = JSON.parse(readFileSync(join(REPO_ROOT, 'network', `${network}.json`), 'utf8'));
  return String(cfg.chain.chainId).split(':').pop() as ChainIdV1;
}

const EVM_NETWORKS = ['testnet', 'mainnet-base', 'mainnet-gnosis'] as const;


/**
 * The selector is policy over an already-validated model, so these drive it with
 * explicit `{ href, origin }` records. Origin DERIVATION is deliberately not
 * tested here — it belongs to the config boundary that owns it, and asserting it
 * from a hand-built record would only restate the rule. The config-level suite
 * below proves derivation end-to-end through the real pipeline.
 */
const CHAIN = '8453' as ChainIdV1;

function ep(href: string, origin: string) {
  return { href, origin };
}

describe('the shipped-pool ceiling defect', () => {
  /**
   * REGRESSION TEST. Before selection existed this threw
   * "Strict current-finalized RPC requires 1..2 distinct endpoints" on every
   * shipped EVM network, so RFC64's finalized-VM precommit could not construct
   * its snapshot scope at all.
   *
   * The fixture MUST come from `resolveRpcUrls(rpcUrl, rpcUrls)`. Reading
   * `chain.rpcUrls` alone gives two endpoints, which constructs both before and
   * after the fix — a test that cannot fail.
   */
  it.each(EVM_NETWORKS.map((n) => [n] as const))(
    '%s: a real 3-endpoint pool constructs',
    (network) => {
      const pool = shippedPool(network);
      expect(pool.length).toBeGreaterThan(2); // the premise; if this drops to 2 the test is moot
      expect(() =>
        snapshotStrictCurrentFinalizedEvmConfigV1({
          chainId: numericChainId(network),
          endpoints: pool,
        }),
      ).not.toThrow();
    },
  );

  it('selects exactly two endpoints from a shipped three-endpoint pool', () => {
    const snapshot = snapshotStrictCurrentFinalizedEvmConfigV1({
      chainId: numericChainId('mainnet-base'),
      endpoints: shippedPool('mainnet-base'),
    });
    expect(snapshot.endpoints).toHaveLength(2);
  });

  it('neuroweb (single endpoint) still constructs and yields that endpoint', () => {
    // Driven through the CONFIG, not the selector. An earlier revision passed the
    // raw pool straight to the selector after its input became `{ href, origin }`
    // records — so it read `.href` off a string, returned `[null]`, and
    // `toHaveLength(1)` passed anyway. Asserting the exact URL through the real
    // boundary is what makes this case able to fail.
    const cfg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'network', 'mainnet-neuroweb.json'), 'utf8'),
    );
    const pool = resolveRpcUrls(cfg.chain.rpcUrl, cfg.chain.rpcUrls);
    expect(pool).toHaveLength(1);
    const snapshot = snapshotStrictCurrentFinalizedEvmConfigV1({
      chainId: numericChainId('mainnet-neuroweb'),
      endpoints: pool,
    });
    expect(snapshot.endpoints).toEqual([new URL(pool[0]!).href]);
  });
});

describe('selectStrictFinalizedEndpointSessionV1 — two-slot policy', () => {
  const A1 = ep('https://lb.provider.io/v2/KEY_A', 'https://lb.provider.io');
  const A2 = ep('https://lb.provider.io/v2/KEY_B', 'https://lb.provider.io');
  const B = ep('https://backup.example.com/', 'https://backup.example.com');
  const C = ep('https://third.example.com/', 'https://third.example.com');

  it('takes the first endpoint and the first later DISTINCT origin', () => {
    expect(selectStrictFinalizedEndpointSessionV1([A1, A2, B])).toEqual([A1.href, B.href]);
  });

  it('SKIPS an earlier same-origin URL to reach a distinct provider — stated trade', () => {
    // The selected array is an ordered failover list, so this IS a priority
    // inversion: A2 is configured second and never attempted. Pinned rather than
    // left implicit. A1 and A2 share a provider, so a provider outage or an
    // account-level rate limit takes both out together and the distinct origin
    // is the only slot that survives it. With two slots and three endpoints,
    // every possible policy skips someone.
    expect(selectStrictFinalizedEndpointSessionV1([A1, A2, B])).not.toContain(A2.href);
  });

  it('BACKFILLS with a same-origin sibling rather than reducing failover', () => {
    // Base constructed a two-URL same-origin pool as TWO dialable endpoints.
    // Collapsing to one would halve failover for a deliberate operator config.
    expect(selectStrictFinalizedEndpointSessionV1([A1, A2])).toEqual([A1.href, A2.href]);
  });

  it('yields one endpoint for a single-endpoint pool', () => {
    expect(selectStrictFinalizedEndpointSessionV1([A1])).toEqual([A1.href]);
  });

  it('preserves configuration order rather than sorting', () => {
    expect(selectStrictFinalizedEndpointSessionV1([C, B])).toEqual([C.href, B.href]);
  });

  it('fails CLOSED on an empty pool rather than returning an empty session', () => {
    expect(() => selectStrictFinalizedEndpointSessionV1([]))
      .toThrow(/requires at least one endpoint/);
  });

  it('is pure: same input, same output, no observable side effects', () => {
    const input = Object.freeze([A1, B]);
    expect(selectStrictFinalizedEndpointSessionV1(input))
      .toEqual(selectStrictFinalizedEndpointSessionV1(input));
    expect(input).toEqual([A1, B]);
  });
});

describe('origin identity, proven end-to-end through the config boundary', () => {
  const sel = (endpoints: readonly string[]) =>
    snapshotStrictCurrentFinalizedEvmConfigV1({ chainId: CHAIN, endpoints } as never).endpoints;

  it('treats path/query/credential/case variants of one host as ONE provider', () => {
    // Three elements so `endpoints` DISCRIMINATES: if these were three providers
    // the second slot would be the second variant, not `b`.
    //
    // The CREDENTIAL variant is load-bearing and was missing at one point while
    // this test's name still claimed it: `url.origin` excludes userinfo, so two
    // tokens on one host are one provider. Without a credential-bearing URL here,
    // an identity rule that folded userinfo in would pass green.
    expect(sel([
      'https://token-a@a.example.com/rpc',
      'https://token-b@A.EXAMPLE.COM/other?k=1',
      'https://b.example.com',
    ])).toEqual(['https://token-a@a.example.com/rpc', 'https://b.example.com/']);
  });

  it('collapses an explicit default port with the portless form', () => {
    expect(sel([
      'https://a.example.com',
      'https://a.example.com:443',
      'https://b.example.com',
    ])).toEqual(['https://a.example.com/', 'https://b.example.com/']);
  });

  it('keeps NON-default ports as distinct providers', () => {
    // The discriminating half. A rule that dropped the port would collapse these
    // two and pick `b` as slot two instead.
    expect(sel([
      'https://a.example.com:8545',
      'https://a.example.com:8546',
      'https://b.example.com',
    ])).toEqual(['https://a.example.com:8545/', 'https://a.example.com:8546/']);
  });

  it('does NOT impose a length limit on the dial URL', () => {
    // Core bounds its input at the canonical scalar limit, so handing it the
    // whole URL would cap RPC endpoints at 4096 bytes — a limit they never had.
    // Only the origin is bounded, and an origin is always short.
    const longPath = `https://rpc.example.com/${'k'.repeat(4100)}`;
    expect(sel([longPath])).toEqual([longPath]);
    const multiByte = `https://rpc.example.com/${'é'.repeat(3000)}`;
    expect(new URL(multiByte).href.length).toBeGreaterThan(4096);
    expect(sel([multiByte])).toEqual([new URL(multiByte).href]);
  });
});

describe('pools that collapse to a valid session still construct', () => {
  const sel = (endpoints: readonly string[]) =>
    snapshotStrictCurrentFinalizedEvmConfigV1({ chainId: CHAIN, endpoints } as never).endpoints;

  it('accepts many IDENTICAL urls, because base deduped before counting', () => {
    // Regression. An earlier revision bounded the RAW array, which turned a
    // config of duplicates into a construction failure even though it collapses
    // to one endpoint. Base deduplicated by href BEFORE its count check, so this
    // constructed; bounding the raw array silently narrowed the contract from
    // "at most two distinct normalized endpoints" to "at most N raw entries".
    expect(sel(Array.from({ length: 33 }, () => 'https://a.example.com/rpc')))
      .toEqual(['https://a.example.com/rpc']);
  });

  it('accepts many entries collapsing to two distinct endpoints', () => {
    expect(sel([
      ...Array.from({ length: 20 }, () => 'https://a.example.com'),
      ...Array.from({ length: 20 }, () => 'https://b.example.com'),
    ])).toEqual(['https://a.example.com/', 'https://b.example.com/']);
  });

  it('preserves the underlying detail on `cause` when the array itself is rejected', () => {
    // The translating catch flattens whatever `snapshotDenseDataArray` reports
    // into one shape complaint, so the specific reason is recoverable only via
    // `cause`. Without this assertion, dropping `{ cause }` leaves the suite
    // green — it did, until a mutant said so.
    let error: unknown;
    try {
      snapshotStrictCurrentFinalizedEvmConfigV1({ chainId: CHAIN, endpoints: [] } as never);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toMatch(/outside the accepted range/);
  });

  it('still fails closed on an invalid entry anywhere in a large pool', () => {
    // Removing the raw bound must not turn the pool into an unvalidated region:
    // every entry is normalized, not only the selected ones.
    expect(() => sel([
      ...Array.from({ length: 40 }, () => 'https://a.example.com'),
      'ftp://c.example.com',
    ])).toThrow(/HTTP\(S\) without a fragment/);
  });
});

describe('config behaviour that must NOT change', () => {

  it('a pool that constructs today still produces byte-identical output', () => {
    const snapshot = snapshotStrictCurrentFinalizedEvmConfigV1({
      chainId: CHAIN,
      endpoints: ['https://a.example.com', 'https://b.example.com'],
    });
    expect(snapshot.endpoints).toEqual(['https://a.example.com/', 'https://b.example.com/']);
    expect(snapshot.blockReferenceProfile).toBe('eip1898');
  });

  it('keeps every existing negative rejection verbatim', () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ chainId: CHAIN, endpoints: ['not-a-url'] }, /absolute URL/],
      [{ chainId: CHAIN, endpoints: ['ftp://a.example.com'] }, /HTTP\(S\) without a fragment/],
      [{ chainId: CHAIN, endpoints: ['https://a.example.com#f'] }, /HTTP\(S\) without a fragment/],
      // Empty hits the dense-array minLength check first — pre-existing ordering.
      [{ chainId: CHAIN, endpoints: [] }, /dense data-only array/],
      [{ chainId: CHAIN, endpoints: ['https://a.example.com'], surprise: 1 }, /unknown or missing fields/],
      [{ chainId: 'not-decimal', endpoints: ['https://a.example.com'] }, /canonical decimal u256/],
      // Message-pinned deliberately. The sibling `rejects unsafe configuration`
      // asserts only `toThrow(TypeError)`, which stayed green while an oversize
      // endpoint escaped as a `VmUpdateConvergenceError` — the type assertion
      // could not fail because no fixture reached the bound.
    ];
    for (const [input, pattern] of bad) {
      expect(() => snapshotStrictCurrentFinalizedEvmConfigV1(input as never)).toThrow(pattern);
    }
  });


  it('an INVALID third endpoint still fails closed rather than being selected away', () => {
    // Selection must not become a way to smuggle a malformed endpoint past
    // validation just because it falls outside the first two origins.
    expect(() =>
      snapshotStrictCurrentFinalizedEvmConfigV1({
        chainId: CHAIN,
        endpoints: ['https://a.example.com', 'https://b.example.com', 'ftp://c.example.com'],
      } as never),
    ).toThrow(/HTTP\(S\) without a fragment/);
  });

  it('rejects an accessor-backed endpoints field with ZERO getter invocations', () => {
    // Selection reads `endpoints`; it must run AFTER descriptor validation or it
    // re-opens the accessor hole closed in #2051.
    let reads = 0;
    const config: Record<string, unknown> = { chainId: CHAIN };
    Object.defineProperty(config, 'endpoints', {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return ['https://a.example.com'];
      },
    });
    expect(() => snapshotStrictCurrentFinalizedEvmConfigV1(config as never))
      .toThrow(/enumerable data properties/);
    expect(reads).toBe(0);
  });

  it('WIDENS: a 3-URL pool with two same-origin aliases now constructs', () => {
    // Previously rejected (3 distinct hrefs). This is a deliberate consequence
    // of origin identity, asserted so the direction of change is not a surprise.
    const snapshot = snapshotStrictCurrentFinalizedEvmConfigV1({
      chainId: CHAIN,
      endpoints: ['https://a.example.com/rpc', 'https://a.example.com/other', 'https://b.example.com'],
    });
    expect(snapshot.endpoints).toHaveLength(2);
  });
});
