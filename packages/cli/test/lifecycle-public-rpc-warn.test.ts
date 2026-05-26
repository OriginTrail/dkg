/**
 * PR3 / RC11 — guard for the `isLikelyPublicRpc` helper that drives
 * the daemon startup WARN when `chain.rpcUrl` is inherited from
 * `network/<env>.json` and points at a known-public endpoint. The
 * WARN is informational, but the helper itself must NOT mis-flag a
 * private endpoint just because it happens to share a substring with
 * a public host's path segment.
 */
import { describe, it, expect } from 'vitest';
import { isLikelyPublicRpc } from '../src/daemon.js';

describe('isLikelyPublicRpc (PR3 / RC11 — startup WARN on inherited public RPC)', () => {
  it.each([
    'https://sepolia.base.org',
    'https://mainnet.base.org',
    'https://rpc.sepolia.org',
    'https://ethereum-sepolia.publicnode.com',
    'https://rpc.ankr.com/eth_sepolia',
    'https://eth-sepolia.public.blastapi.io',
    'https://sepolia.gateway.tenderly.co/foo',
    'HTTPS://Sepolia.Base.ORG',
  ])('flags well-known public endpoint %s', (url) => {
    expect(isLikelyPublicRpc(url)).toBe(true);
  });

  it.each([
    'https://my-private-alchemy.alchemyapi.io/v2/abc123',
    'https://eth-rpc.my-company.example/sepolia',
    'http://127.0.0.1:8545',
    'https://infura.io/v3/private-key',
    'http://localhost:8545',
    // PR3 (review fix #2) regression: a private proxy URL that
    // embeds a known-public hostname in its PATH must NOT be
    // misclassified as public. Pre-fix this returned `true` because
    // the helper did a `lower.includes(host)` against the whole URL
    // string; post-fix it parses the URL and matches against
    // `hostname` only, so this stays `false`.
    'https://rpc.my-company.example/upstream/sepolia.base.org',
    'https://proxy.my-company.example/?target=https://rpc.ankr.com',
  ])('does NOT flag private/private-relayed endpoint %s', (url) => {
    expect(isLikelyPublicRpc(url)).toBe(false);
  });

  it.each([
    // Subdomains of known-public hosts (e.g. region prefixes) should
    // still flag — the helper matches `hostname === host ||
    // hostname.endsWith('.' + host)` so `eu.rpc.ankr.com` is treated
    // as a subdomain of `rpc.ankr.com`.
    ['https://eu.rpc.ankr.com', true],
    // Adjacency: `notsepolia.base.org` is NOT a subdomain of
    // `sepolia.base.org` even though it shares the suffix. The
    // endpoint match prevents `endsWith('sepolia.base.org')` false-
    // positives.
    ['https://notsepolia.base.org', false],
  ])('subdomain handling: %s → %s', (url, expected) => {
    expect(isLikelyPublicRpc(url)).toBe(expected);
  });
});
