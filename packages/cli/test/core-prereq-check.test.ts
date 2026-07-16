import { describe, it, expect } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  checkCoreRelayPrereqs,
  classifyMultiaddr,
  type AddrClassification,
} from '../src/daemon/core-prereq-check.js';

/**
 * Test fixtures — synthetic `os.networkInterfaces()` snapshots. The classifier
 * never reads real interfaces (the `hostInterfaces` arg is injected) so these
 * tests are deterministic regardless of where they run.
 */
const PUBLIC_IPV4_IFACE: NetworkInterfaceInfo = {
  address: '8.8.8.8',
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: '8.8.8.8/24',
};

const PUBLIC_IPV6_IFACE: NetworkInterfaceInfo = {
  address: '2606:4700:4700::1111',
  netmask: 'ffff:ffff:ffff:ffff::',
  family: 'IPv6',
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: '2606:4700:4700::1111/64',
};

const RFC1918_IFACE: NetworkInterfaceInfo = {
  address: '192.168.1.42',
  netmask: '255.255.255.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: '192.168.1.42/24',
};

const LOOPBACK_IFACE: NetworkInterfaceInfo = {
  address: '127.0.0.1',
  netmask: '255.0.0.0',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal: true,
  cidr: '127.0.0.1/8',
};

const TAILSCALE_IFACE: NetworkInterfaceInfo = {
  address: '100.99.142.87',
  netmask: '255.255.255.255',
  family: 'IPv4',
  mac: '00:00:00:00:00:00',
  internal: false,
  cidr: '100.99.142.87/32',
};

describe('classifyMultiaddr — per-class smoke tests', () => {
  type Case = [string, AddrClassification];
  const cases: Case[] = [
    // The 8 base classes plus wildcards.
    ['/ip4/8.8.8.8/tcp/4001',         'public'],
    ['/ip4/203.0.113.5/tcp/4001',     'unknown'],
    ['/ip4/999.999.999.999/tcp/4001', 'unknown'],
    ['/ip4/10.0.0.1/tcp/4001',        'rfc1918'],
    ['/ip4/172.20.0.1/tcp/4001',      'rfc1918'],
    ['/ip4/192.168.1.1/tcp/4001',     'rfc1918'],
    ['/ip4/100.99.142.87/tcp/4001',   'cgnat'],   // beacon-01 Tailscale case
    ['/ip4/100.63.0.1/tcp/4001',      'public'],  // 100.63.x.x is OUTSIDE CGNAT range
    ['/ip4/100.128.0.1/tcp/4001',     'public'],  // 100.128.x.x is also OUTSIDE CGNAT range
    ['/ip4/127.0.0.1/tcp/4001',       'loopback'],
    ['/ip4/169.254.1.1/tcp/4001',     'linkLocal'],
    ['/ip4/224.0.0.1/tcp/4001',       'multicast'],
    // Reserved ranges that previously fell through to `public` (PR #661 codex
    // feedback id 3302152014). All three blocks are documented as not
    // globally routable but the original allow-list-style classifier didn't
    // catch them.
    ['/ip4/0.1.2.3/tcp/4001',         'reserved'],  // 0.0.0.0/8 "this network" (RFC 1122)
    ['/ip4/198.18.1.1/tcp/4001',      'reserved'],  // 198.18.0.0/15 benchmark testing (RFC 2544)
    ['/ip4/198.19.5.5/tcp/4001',      'reserved'],  // upper half of 198.18.0.0/15
    ['/ip4/240.0.0.1/tcp/4001',       'reserved'],  // 240.0.0.0/4 reserved-future-use (RFC 1112)
    ['/ip4/250.10.20.30/tcp/4001',    'reserved'],  // mid-240/4
    ['/ip4/255.255.255.254/tcp/4001', 'reserved'],  // upper edge of 240/4 (excluding broadcast)
    ['/ip6/::1/tcp/4001',             'loopback'],
    ['/ip6/fe80::1/tcp/4001',         'linkLocal'],
    ['/ip6/fd00::1/tcp/4001',         'ulaIpv6'],  // RFC 4193 fc00::/7
    ['/ip6/fdab:cdef::1/tcp/4001',    'ulaIpv6'],  // Tailscale ULA range
    ['/ip6/ff02::1/tcp/4001',         'multicast'],
    ['/ip6/2606:4700:4700::1111/tcp/4001', 'public'],
    ['/ip6/2001:db8::1/tcp/4001',     'unknown'],  // RFC 3849 documentation range
    ['/ip6/2001:0db8::1/tcp/4001',    'unknown'],  // Codex #661 regression — zero-padded
    ['/ip6/2001:0db8:0000:0000::1/tcp/4001', 'unknown'],  // Codex #661 regression — fully expanded
    ['/dns4/example.com/tcp/4001',    'dns'],
    ['/dns6/example.com/tcp/4001',    'dns'],
    ['/dns/example.com/tcp/4001',     'dns'],
    ['/dnsaddr/example.com',          'dns'],
    ['/ip4/8.8.8.8/tcp/4001/p2p/12D3KooRelay/p2p-circuit/p2p/12D3KooSelf', 'relayed'],
    ['/unix/var/run/foo.sock',        'unknown'],
  ];

  it.each(cases)('classifies %s as %s', (addr, expected) => {
    expect(classifyMultiaddr(addr, [])).toBe(expected);
  });
});

describe('classifyMultiaddr — wildcards delegate to host interfaces', () => {
  it("0.0.0.0 with one public IPv4 interface classifies as `public`", () => {
    expect(classifyMultiaddr('/ip4/0.0.0.0/tcp/4001', [PUBLIC_IPV4_IFACE])).toBe('public');
  });

  it("0.0.0.0 with one public AND one RFC1918 interface still classifies as `public` (best wins)", () => {
    // Operator value: a dual-homed host (one public, one LAN) is fully relay-capable
    // regardless of which interface libp2p picks for outbound; receivers see the
    // public one. The classifier picks the BEST, not the worst.
    expect(classifyMultiaddr('/ip4/0.0.0.0/tcp/4001', [PUBLIC_IPV4_IFACE, RFC1918_IFACE])).toBe('public');
  });

  it("0.0.0.0 with only RFC1918 interfaces classifies as `rfc1918`", () => {
    expect(classifyMultiaddr('/ip4/0.0.0.0/tcp/4001', [RFC1918_IFACE])).toBe('rfc1918');
  });

  it("0.0.0.0 with only loopback (internal) interfaces classifies as wildcardNoPublicInterface (internal: true is skipped)", () => {
    // Loopback interfaces in the real `os.networkInterfaces()` output have
    // `internal: true`. Our classifier skips internal interfaces — they don't
    // count as "an interface the wildcard binding can serve traffic on".
    expect(classifyMultiaddr('/ip4/0.0.0.0/tcp/4001', [LOOPBACK_IFACE])).toBe('wildcardNoPublicInterface');
  });

  it("0.0.0.0 with no interfaces classifies as wildcardNoPublicInterface", () => {
    expect(classifyMultiaddr('/ip4/0.0.0.0/tcp/4001', [])).toBe('wildcardNoPublicInterface');
  });

  it("0.0.0.0 with only CGNAT interfaces classifies as `cgnat` (beacon-01 if it had used 0.0.0.0)", () => {
    expect(classifyMultiaddr('/ip4/0.0.0.0/tcp/4001', [TAILSCALE_IFACE])).toBe('cgnat');
  });

  it("IPv6 :: wildcard delegates to host interfaces the same way IPv4 0.0.0.0 does", () => {
    expect(classifyMultiaddr('/ip6/::/tcp/4001', [PUBLIC_IPV6_IFACE])).toBe('public');
    expect(classifyMultiaddr('/ip6/::/tcp/4001', [])).toBe('wildcardNoPublicInterface');
  });

  it("IPv4 and IPv6 wildcards only consider interfaces from the matching family", () => {
    expect(classifyMultiaddr('/ip4/0.0.0.0/tcp/4001', [PUBLIC_IPV6_IFACE])).toBe('wildcardNoPublicInterface');
    expect(classifyMultiaddr('/ip6/::/tcp/4001', [PUBLIC_IPV4_IFACE])).toBe('wildcardNoPublicInterface');
  });
});

describe('checkCoreRelayPrereqs — 7 canonical cases from the plan', () => {
  it('case 1: Tailscale-only beacon-01 reproduces a degraded result with cgnat reason', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/100.99.142.87/tcp/4001'],
      hostInterfaces: [TAILSCALE_IFACE, LOOPBACK_IFACE],
      announceAddresses: [],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.publicListenAddresses).toEqual([]);
    expect(result.nonRoutableAddresses).toEqual([
      { addr: '/ip4/100.99.142.87/tcp/4001', class: 'cgnat' },
    ]);
    expect(result.reasons[0]).toContain('1 cgnat');
  });

  it('case 2: 0.0.0.0 + one public interface is not degraded', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/0.0.0.0/tcp/4001', '/ip4/0.0.0.0/tcp/4001/ws'],
      hostInterfaces: [PUBLIC_IPV4_IFACE, LOOPBACK_IFACE],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(false);
    expect(result.publicListenAddresses).toHaveLength(2);
    expect(result.reasons).toEqual([]);
  });

  it('case 3: 0.0.0.0 + only RFC1918 interfaces is degraded', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/0.0.0.0/tcp/4001'],
      hostInterfaces: [RFC1918_IFACE, LOOPBACK_IFACE],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.nonRoutableAddresses[0].class).toBe('rfc1918');
  });

  it('case 4: single public IPv4 is not degraded', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/8.8.8.8/tcp/4001'],
      hostInterfaces: [PUBLIC_IPV4_IFACE],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(false);
    expect(result.publicListenAddresses).toEqual(['/ip4/8.8.8.8/tcp/4001']);
  });

  it('case 5: loopback-only is degraded', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/127.0.0.1/tcp/4001'],
      hostInterfaces: [LOOPBACK_IFACE],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.nonRoutableAddresses[0].class).toBe('loopback');
  });

  it('case 6: IPv6 ULA-only is degraded', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip6/fd00::1/tcp/4001'],
      hostInterfaces: [],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.nonRoutableAddresses[0].class).toBe('ulaIpv6');
  });

  it('case 7: DNS-only listen + public announce stays degraded without listener reachability evidence', () => {
    // DNS listen multiaddrs are intentionally not resolved by the pure checker.
    // A public announce IP does not prove the DNS-bound socket is listening on
    // a public or NAT-forwarded local interface.
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/dns4/relay.origintrail.io/tcp/4001'],
      hostInterfaces: [RFC1918_IFACE],
      announceAddresses: ['/ip4/8.8.8.8/tcp/4001'],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.nonRoutableAddresses[0].class).toBe('dns');
  });

  it('DNS announce on a private bound listener triggers an indeterminate (warn-only) rescue, not a strict-mode refusal', () => {
    // Bot review feedback (PR #661, comment 3301776587): strict mode would
    // previously refuse-to-boot any DNS-based announceAddresses deployment
    // because it couldn't statically prove publicness. The healthier
    // semantic is "we can't prove this is public, but it's not a footgun
    // like a private IP, so don't refuse to boot." Encoded as a soft
    // rescue (looksDegraded=false) plus the indeterminate flag so strict
    // operators wanting hard validation can pre-resolve DNS in the
    // lifecycle layer and re-call this helper.
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/192.168.1.1/tcp/4001'],
      hostInterfaces: [RFC1918_IFACE],
      announceAddresses: ['/dnsaddr/relay.origintrail.io'],
      nodeRole: 'core',
    });

    expect(result.looksDegraded).toBe(false);
    expect(result.indeterminate).toBe(true);
    expect(result.nonRoutableAddresses[0].class).toBe('rfc1918');
    expect(result.reasons.some((r) => r.includes('DNS hostname'))).toBe(true);
  });

  it('Codex #661 — reserved DNS announce WITH trailing root dot is not a rescue', () => {
    // Codex (#661#discussion_r3302752890): `isReservedDnsName()` previously
    // missed FQDNs with a trailing root dot, so `localhost.`, `relay.test.`,
    // `svc.cluster.local.` could rescue a degraded RFC1918 listener even
    // though they are reserved by RFC 6761 and not externally dialable.
    for (const announce of [
      '/dnsaddr/localhost.',
      '/dns4/relay.test.',
      '/dns/svc.cluster.local.',
    ]) {
      const result = checkCoreRelayPrereqs({
        listenAddresses: ['/ip4/192.168.1.1/tcp/4001'],
        hostInterfaces: [RFC1918_IFACE],
        announceAddresses: [announce],
        nodeRole: 'core',
      });
      // No rescue: looksDegraded stays true, no `indeterminate` warn-only escape.
      expect(result.looksDegraded).toBe(true);
    }
  });

  it('literal public announce can rescue an unresolved wildcard pre-start listener', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/0.0.0.0/tcp/4001'],
      hostInterfaces: [],
      announceAddresses: ['/ip4/8.8.8.8/tcp/4001'],
      nodeRole: 'core',
    });

    expect(result.looksDegraded).toBe(false);
    expect(result.nonRoutableAddresses[0].class).toBe('wildcardNoPublicInterface');
  });

  it('literal public announce does not rescue CGNAT-only listeners', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/100.99.142.87/tcp/4001'],
      hostInterfaces: [TAILSCALE_IFACE],
      announceAddresses: ['/ip4/8.8.8.8/tcp/4001'],
      nodeRole: 'core',
    });

    expect(result.looksDegraded).toBe(true);
    expect(result.nonRoutableAddresses[0].class).toBe('cgnat');
  });

  it('literal public announce does not rescue ULA-only IPv6 listeners', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip6/fdab:cdef::1/tcp/4001'],
      hostInterfaces: [],
      announceAddresses: ['/ip4/8.8.8.8/tcp/4001'],
      nodeRole: 'core',
    });

    expect(result.looksDegraded).toBe(true);
    expect(result.nonRoutableAddresses[0].class).toBe('ulaIpv6');
  });
});

describe('checkCoreRelayPrereqs — additional safety cases', () => {
  it('edge node with all-loopback listenAddresses is NOT flagged as degraded (only core nodes get the verdict)', () => {
    // Edge nodes are clients — they don't need to serve inbound traffic. The
    // classifier still labels their addresses (operators sometimes want to
    // see the classification) but `looksDegraded` is reserved for cores.
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/127.0.0.1/tcp/4001'],
      hostInterfaces: [LOOPBACK_IFACE],
      nodeRole: 'edge',
    });
    expect(result.looksDegraded).toBe(false);
    expect(result.nonRoutableAddresses[0].class).toBe('loopback');
  });

  it('empty listenAddresses on a core yields a specific reason', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: [],
      hostInterfaces: [PUBLIC_IPV4_IFACE],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.reasons.some((r) => r === 'listenAddresses is empty')).toBe(true);
  });

  it('empty listenAddresses is still degraded even when announceAddresses contains a public address', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: [],
      hostInterfaces: [PUBLIC_IPV4_IFACE],
      announceAddresses: ['/ip4/8.8.8.8/tcp/4001'],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.reasons).toContain('listenAddresses is empty');
  });

  it('relayed self-addresses do not count as public direct listeners', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: [
        '/ip4/8.8.8.8/tcp/4001/p2p/12D3KooRelay/p2p-circuit/p2p/12D3KooSelf',
      ],
      hostInterfaces: [PUBLIC_IPV4_IFACE],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.publicListenAddresses).toEqual([]);
    expect(result.nonRoutableAddresses[0].class).toBe('relayed');
  });

  it('loopback listenAddresses stay degraded even when announceAddresses contains a public address', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/127.0.0.1/tcp/4001'],
      hostInterfaces: [LOOPBACK_IFACE],
      announceAddresses: ['/ip4/8.8.8.8/tcp/4001'],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.nonRoutableAddresses[0].class).toBe('loopback');
  });

  it('mixed degraded classes summarise in a single reason line (cgnat + rfc1918 + loopback)', () => {
    // Operator value: the reason summary is grep-able. If a node has 5
    // non-routable addresses across 3 classes, we don't want 5 log lines;
    // one summary "N class1, M class2, …" tells the story at a glance.
    const result = checkCoreRelayPrereqs({
      listenAddresses: [
        '/ip4/100.99.142.87/tcp/4001',
        '/ip4/100.64.0.5/tcp/4001',
        '/ip4/192.168.1.1/tcp/4001',
        '/ip4/127.0.0.1/tcp/4001',
      ],
      hostInterfaces: [],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.reasons[0]).toMatch(/all 4 listenAddresses are non-routable/);
    expect(result.reasons[0]).toContain('2 cgnat');
    expect(result.reasons[0]).toContain('1 rfc1918');
    expect(result.reasons[0]).toContain('1 loopback');
  });

  it('announceAddresses with no public entries does not rescue, and a dedicated reason calls that out', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/192.168.1.1/tcp/4001'],
      hostInterfaces: [],
      announceAddresses: ['/ip4/10.0.0.5/tcp/4001'],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.reasons.some((r) => r.includes('announceAddress') && r.includes('none classify as a literal public IP'))).toBe(true);
  });

  it('reserved DNS announce names do not rescue private listeners', () => {
    for (const host of ['localhost', 'relay.local', 'svc.cluster.local', 'myhost', 'relay.test', 'relay.example']) {
      const result = checkCoreRelayPrereqs({
        listenAddresses: ['/ip4/192.168.1.1/tcp/4001'],
        hostInterfaces: [],
        announceAddresses: [`/dnsaddr/${host}`],
        nodeRole: 'core',
      });
      expect(result.looksDegraded, host).toBe(true);
    }
  });

  it('no announceAddresses on a degraded result surfaces the missing-rescue hint', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/192.168.1.1/tcp/4001'],
      hostInterfaces: [],
      nodeRole: 'core',
    });
    expect(result.reasons.some((r) => r.includes('no announceAddresses configured'))).toBe(true);
  });
});

describe('PR #661 codex review fixes', () => {
  // ──────────────────────────────────────────────────────────────────────
  // Comment 3301776587 — strict mode must not refuse-to-boot DNS deployments
  // ──────────────────────────────────────────────────────────────────────

  it('DNS announceAddresses (/dns4/relay.example.org/tcp/9090) does not trigger degraded refusal in strict mode (treated as warn-only)', () => {
    // Reproduces the bot-flagged scenario: pre-start pass with a wildcard
    // listener (not yet expanded by libp2p) and a DNS announce. Previously
    // this would set looksDegraded=true and the strict-mode lifecycle would
    // refuse-to-boot. Now it's an indeterminate rescue: looksDegraded=false
    // (so strict mode boots) plus indeterminate=true (so callers that want
    // a clear warning can surface one).
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/0.0.0.0/tcp/9090'],
      hostInterfaces: [],
      announceAddresses: ['/dns4/relay.example.org/tcp/9090'],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(false);
    expect(result.indeterminate).toBe(true);
    expect(result.reasons.some((r) => r.includes('DNS hostname'))).toBe(true);
  });

  it('DNS announce on an RFC1918 listener also rescues as indeterminate (NAT-forwarded VPS-with-DNS case)', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/10.0.0.42/tcp/9090'],
      hostInterfaces: [],
      announceAddresses: ['/dnsaddr/peers.example.org'],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(false);
    expect(result.indeterminate).toBe(true);
  });

  it('DNS announce does NOT rescue a loopback listener (loopback is unambiguously broken, regardless of announce)', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/127.0.0.1/tcp/9090'],
      hostInterfaces: [LOOPBACK_IFACE],
      announceAddresses: ['/dns4/relay.example.org/tcp/9090'],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.indeterminate).toBe(false);
  });

  it('non-DNS, non-public announce + private listener stays degraded with indeterminate=false', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/192.168.1.1/tcp/9090'],
      hostInterfaces: [],
      announceAddresses: ['/ip4/10.0.0.5/tcp/9090'],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.indeterminate).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Comment 3302152014 — IP classification must reject reserved blocks
  // ──────────────────────────────────────────────────────────────────────

  it('a node bound only to 198.18.1.1 (TEST-NET-2 / RFC 2544 benchmark) is non-public and degraded', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/198.18.1.1/tcp/9090'],
      hostInterfaces: [],
      nodeRole: 'core',
    });
    expect(result.publicListenAddresses).toEqual([]);
    expect(result.looksDegraded).toBe(true);
    expect(result.nonRoutableAddresses[0].class).toBe('reserved');
  });

  it('a node bound only to 0.1.2.3 (0.0.0.0/8 "this network") is non-public and degraded', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/0.1.2.3/tcp/9090'],
      hostInterfaces: [],
      nodeRole: 'core',
    });
    expect(result.publicListenAddresses).toEqual([]);
    expect(result.looksDegraded).toBe(true);
    expect(result.nonRoutableAddresses[0].class).toBe('reserved');
  });

  it('a node bound only to 240.0.0.1 (240/4 reserved-for-future-use) is non-public and degraded', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/240.0.0.1/tcp/9090'],
      hostInterfaces: [],
      nodeRole: 'core',
    });
    expect(result.publicListenAddresses).toEqual([]);
    expect(result.looksDegraded).toBe(true);
    expect(result.nonRoutableAddresses[0].class).toBe('reserved');
  });

  // ──────────────────────────────────────────────────────────────────────
  // Comment 3302152020 — wildcard announce addresses must not rescue
  // ──────────────────────────────────────────────────────────────────────

  it('announceAddresses /ip4/0.0.0.0/tcp/9090 does NOT rescue an RFC1918 listener even with a public host interface', () => {
    // Wildcards aren't dialable from outside, so they can't qualify as
    // "literal public IP rescue" no matter how many public interfaces the
    // host has. Previously isPublicAnnounceAddress() would delegate to
    // classifyMultiaddr() which returns `public` for `0.0.0.0` whenever
    // any host interface is public — letting a misconfigured wildcard
    // announce silently suppress the degraded verdict.
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/192.168.1.1/tcp/9090'],
      hostInterfaces: [PUBLIC_IPV4_IFACE, RFC1918_IFACE],
      announceAddresses: ['/ip4/0.0.0.0/tcp/9090'],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.indeterminate).toBe(false);
  });

  it('announceAddresses /ip6/::/tcp/9090 does NOT rescue an RFC1918 listener even with a public IPv6 interface', () => {
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/192.168.1.1/tcp/9090'],
      hostInterfaces: [PUBLIC_IPV6_IFACE, RFC1918_IFACE],
      announceAddresses: ['/ip6/::/tcp/9090'],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(true);
    expect(result.indeterminate).toBe(false);
  });

  it('a literal public IP announce still rescues even when a wildcard announce is also present', () => {
    // Mixing wildcard + literal-public announce should still rescue via
    // the literal-public entry; the wildcard is just ignored as evidence.
    const result = checkCoreRelayPrereqs({
      listenAddresses: ['/ip4/192.168.1.1/tcp/9090'],
      hostInterfaces: [PUBLIC_IPV4_IFACE],
      announceAddresses: ['/ip4/0.0.0.0/tcp/9090', '/ip4/8.8.8.8/tcp/9090'],
      nodeRole: 'core',
    });
    expect(result.looksDegraded).toBe(false);
    expect(result.indeterminate).toBe(false);
  });
});
