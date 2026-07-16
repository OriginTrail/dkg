/**
 * Core relay capability — boot-time sanity check.
 *
 * # Why this exists
 *
 * `nodeRole: 'core'` is purely self-declared today. A node can advertise itself
 * as a Core relay and immediately fail at the job because none of its bound
 * interfaces are reachable from the public internet. **beacon-01** in the
 * v10.0.0-rc.10 incident was the canonical case: it bound only to its Tailscale
 * CGNAT address (`100.99.142.87`) and could not have functioned as a relay
 * regardless of slot state. With this check in place, that misconfiguration
 * surfaces at boot in the operator's logs as `[CORE-PREREQ] looks degraded`
 * instead of being a network-wide silent failure.
 *
 * # Design
 *
 * Pure functions, no I/O, no libp2p dependency at this layer. Callers provide
 * the inputs (`listenAddresses`, `os.networkInterfaces()` snapshot, etc.) and
 * decide what to do with the result (`looksDegraded` + structured `reasons`).
 * The classifier is the testable kernel; the lifecycle wiring is one layer up.
 *
 * # Two-pass usage
 *
 * - **Pre-start pass**: classify the host's interfaces + the configured
 *   listenAddresses *before* `libp2p.start()` resolves wildcards. Catches
 *   "no public interface on the host" early — operator sees the warning
 *   before paying the boot cost.
 * - **Post-start pass**: re-run with the transport manager's listener
 *   addresses — those are the actually-bound addresses after libp2p's
 *   address-resolver has done its thing (NAT64, `/ip4/0.0.0.0` →
 *   per-interface expansion, etc.). This is the authoritative pass; the
 *   pre-start pass is just a heads-up. Do not use `libp2p.getMultiaddrs()`
 *   here: that is the advertised self-address set and can include public
 *   announce addresses or `/p2p-circuit` relay reservations.
 *
 * # Order of classifier rules (matters)
 *
 * Wildcard rule first — `/ip4/0.0.0.0` and `/ip6/::` bind to every interface,
 * so the address's class is the *best* class across the host's interfaces (if
 * any interface is public, the binding is effectively public). Without the
 * host-interface lookup, the wildcard alone is unclassifiable. Then the
 * specific ranges in narrowing order — loopback → CGNAT → RFC1918 →
 * link-local → ULAv6 → reserved (0/8, 198.18/15, 240/4 etc.) — so a
 * more-specific class wins over a less-specific one. The IPv4 classifier is
 * "reject if matches any reserved/non-global range, else public" rather than
 * a small allow-list, so blocks like `198.18.0.0/15` (RFC 2544 benchmarking)
 * and `240.0.0.0/4` (RFC 1112 reserved) don't sneak through as `public`.
 *
 * DNS multiaddrs deliberately classify as `dns` rather than resolving at
 * boot (DNS resolution is async + flaky + the answer can change). DNS listen
 * addresses are not themselves proof of public reachability. DNS announce
 * addresses with a non-reserved hostname rescue an otherwise-degraded
 * listener as **indeterminate** — we can't prove it's public, but it's not a
 * footgun like a private IP either, so the verdict is `looksDegraded: false`
 * with `indeterminate: true` so strict (`allowDegradedRelay: false`) operators
 * don't refuse-to-boot on a stable DNS deployment. Reserved DNS names
 * (`localhost`, `*.local`, `*.test`, `*.example`, `*.invalid`, single-label)
 * are excluded from indeterminate rescue — they can't resolve to a public IP.
 */

import { isIP } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';

export type AddrClassification =
  | 'public'
  | 'rfc1918'
  | 'cgnat'
  | 'loopback'
  | 'linkLocal'
  | 'ulaIpv6'
  | 'dns'
  | 'multicast'
  | 'relayed'
  | 'reserved'
  | 'wildcardNoPublicInterface'
  | 'unknown';

export interface CorePrereqResult {
  /** Multiaddrs that classify as `public` (or wildcard-with-a-public-interface). */
  publicListenAddresses: string[];
  /** Everything else, with each entry's resolved class. */
  nonRoutableAddresses: Array<{ addr: string; class: AddrClassification }>;
  /**
   * True iff `publicListenAddresses` is empty AND no `announceAddresses` entry
   * can rescue the result. Operators with literal public announce addresses
   * (the VPS-with-static-IP case) are not degraded when they still have at
   * least one bound wildcard / private-LAN listen address. DNS announce
   * addresses with a non-reserved hostname also rescue (as indeterminate —
   * see `indeterminate` below) so a stable DNS deployment doesn't refuse to
   * boot under strict `allowDegradedRelay: false`. A node with zero bound
   * listen addresses is always degraded: an announce address cannot make an
   * unbound transport serve relay traffic.
   */
  looksDegraded: boolean;
  /**
   * True when the result is non-degraded only because a DNS announce
   * address rescued it. The pure checker can't prove the DNS hostname
   * resolves to a publicly reachable IP, so it lets the boot proceed but
   * marks the verdict as soft. Strict-mode lifecycle layers MAY surface
   * a clear warning when this is set instead of treating it as an OK
   * verdict; resolving DNS in the lifecycle layer would let them upgrade
   * to a hard verdict either way.
   */
  indeterminate: boolean;
  /**
   * Human-readable reasons (one per failure mode hit). Empty when
   * `looksDegraded === false` and `indeterminate === false`. Logged verbatim
   * by the lifecycle wiring.
   */
  reasons: string[];
}

export interface CheckCoreRelayPrereqsOpts {
  /**
   * Multiaddrs the daemon configured itself to listen on. Pre-start pass:
   * the values from the config (may include `/ip4/0.0.0.0/...` wildcards).
   * Post-start pass: pass transport listener addresses here instead — those
   * are the post-wildcard-expansion addresses libp2p actually bound.
   */
  listenAddresses: string[];
  /**
   * `os.networkInterfaces()` snapshot. Injected (not read here) so tests
   * can run deterministically without touching the real host. The wildcard
   * classifier walks this list to figure out whether any interface gives
   * the wildcard binding a public reach. Empty / undefined means "no
   * interface info available" — wildcards then classify as
   * `wildcardNoPublicInterface` since we have no positive evidence of a
   * public interface.
   */
  hostInterfaces?: ReadonlyArray<NetworkInterfaceInfo>;
  /**
   * Optional multiaddrs the daemon advertises to the network (the VPS /
   * cloud case where the public IP isn't bound to a local interface).
   * A literal public-IP announce address rescues an otherwise-degraded result
   * only when the node also has at least one wildcard/private-LAN listener.
   * DNS announce addresses are intentionally not resolved here (DNS is
   * async + flaky); a non-reserved DNS hostname triggers an *indeterminate*
   * rescue (`looksDegraded: false, indeterminate: true`) so strict-mode
   * operators don't refuse-to-boot on stable DNS deployments. Reserved DNS
   * hostnames (`localhost`, `*.local`, `*.test`, `*.example`, `*.invalid`,
   * single-label) are excluded from indeterminate rescue.
   */
  announceAddresses?: string[];
  /**
   * Only `'core'` nodes get a degraded verdict — `'edge'` nodes are clients
   * and don't need to serve traffic, so the check is informational at most.
   * Pass through for callers that want the classification regardless.
   */
  nodeRole: 'core' | 'edge';
}

const RFC1918_REGEXES: ReadonlyArray<RegExp> = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
];

function isValidIPv4(ip: string): boolean {
  return isIP(ip) === 4;
}

function isDocumentationIPv4(ip: string): boolean {
  return /^192\.0\.2\./.test(ip)
    || /^198\.51\.100\./.test(ip)
    || /^203\.0\.113\./.test(ip);
}

/**
 * Tailscale CGNAT: 100.64.0.0/10 (== first octet 100, second octet 64..127).
 * RFC6598 carrier-grade NAT range; routable on the Tailscale overlay only,
 * never reachable from the wider internet without explicit funnel setup.
 */
function isCgnatIPv4(ip: string): boolean {
  const m = /^100\.(\d{1,3})\./.exec(ip);
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

function isLoopbackIPv4(ip: string): boolean {
  return /^127\./.test(ip);
}

function isLinkLocalIPv4(ip: string): boolean {
  return /^169\.254\./.test(ip);
}

function isMulticastIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\./.exec(ip);
  if (!m) return false;
  const first = Number(m[1]);
  return first >= 224 && first <= 239;
}

function isRfc1918IPv4(ip: string): boolean {
  return RFC1918_REGEXES.some((r) => r.test(ip));
}

/**
 * Ranges that MUST NOT be confused with global-unicast IPs even though they
 * sit outside the more-specific classes above. Without these explicit checks
 * the classifier falls back to `public` for `0.x.x.x` ("this network" per
 * RFC 1122), `198.18.x.x` / `198.19.x.x` (RFC 2544 benchmarking), and
 * `240.x.x.x` … `255.255.255.254` (RFC 1112 reserved-for-future-use), all of
 * which are not globally routable. Switched from a small "looks public"
 * allow-list to "reject if reserved, else public" so future IANA assignments
 * we forget to model still default to optimistic-public, while the known
 * non-global blocks always reject.
 */
function isThisNetworkIPv4(ip: string): boolean {
  return /^0\./.test(ip);
}

function isBenchmarkIPv4(ip: string): boolean {
  return /^198\.(1[89])\./.test(ip);
}

/**
 * 240.0.0.0/4 is reserved for future use (RFC 1112), with the sole exception
 * of the limited broadcast address `255.255.255.255`. Treat the entire /4 as
 * non-public — broadcast doesn't classify as public anyway and isn't a
 * reasonable listen address.
 */
function isReservedFutureIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\./.exec(ip);
  if (!m) return false;
  const first = Number(m[1]);
  return first >= 240 && first <= 255;
}

function classifyIPv4(ip: string): AddrClassification {
  if (!isValidIPv4(ip)) return 'unknown';
  if (isLoopbackIPv4(ip)) return 'loopback';
  if (isLinkLocalIPv4(ip)) return 'linkLocal';
  if (isCgnatIPv4(ip)) return 'cgnat';
  if (isRfc1918IPv4(ip)) return 'rfc1918';
  if (isMulticastIPv4(ip)) return 'multicast';
  if (isDocumentationIPv4(ip)) return 'unknown';
  if (isThisNetworkIPv4(ip)) return 'reserved';
  if (isBenchmarkIPv4(ip)) return 'reserved';
  if (isReservedFutureIPv4(ip)) return 'reserved';
  return 'public';
}

/**
 * Lowercase the IPv6 string and check its leading hextet. We compare against
 * the textual prefix instead of doing a numeric range check because the
 * input is already a string and these prefixes are short.
 *
 *   - `::`                        → reserved   (unspecified address; never a valid src/dst)
 *   - `::1`                       → loopback
 *   - `fe80::/10`                 → linkLocal  (first hextet starts with fe8/fe9/fea/feb)
 *   - `fc00::/7`                  → ulaIpv6    (first hextet starts with fc or fd)
 *   - `ff00::/8`                  → multicast  (first hextet starts with ff)
 *   - everything else             → public
 */
function classifyIPv6(ipRaw: string): AddrClassification {
  if (isIP(ipRaw) !== 6) return 'unknown';
  const ip = ipRaw.toLowerCase();
  if (ip === '::') return 'reserved';
  if (ip === '::1') return 'loopback';
  // Codex #661 (discussion_r3302752877): bare-string `startsWith('2001:db8:')`
  // misses valid zero-padded spellings like `2001:0db8::1`. Normalize by
  // parsing the first two hextets numerically before comparing, so any
  // documentation address inside `2001:db8::/32` (RFC 3849) is caught
  // regardless of textual form.
  const hextets = ip.split('::')[0]?.split(':') ?? [];
  if (hextets.length >= 2) {
    const h0 = parseInt(hextets[0], 16);
    const h1 = parseInt(hextets[1], 16);
    if (h0 === 0x2001 && h1 === 0x0db8) return 'unknown';
  }
  if (/^fe[89ab][0-9a-f]?:/.test(ip)) return 'linkLocal';
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return 'ulaIpv6';
  if (/^ff[0-9a-f]{2}:/.test(ip)) return 'multicast';
  return 'public';
}

/**
 * Wildcard listen addresses (`/ip4/0.0.0.0` and `/ip6/::`) bind to every
 * interface on the host but are NOT themselves dialable from elsewhere — a
 * remote peer cannot connect to `0.0.0.0`. Reject wildcards explicitly here
 * so that an `announceAddresses: ['/ip4/0.0.0.0/tcp/9090']` entry can't
 * suppress the degraded verdict via `bestClassAmongInterfaces` returning
 * `public` whenever any host interface happens to be public. Wildcard rescue
 * was the listener-side semantic; on the announce side it's just a misconfig.
 */
function isWildcardMultiaddr(addr: string): boolean {
  const parts = addr.split('/').filter(Boolean);
  if (parts.length < 2) return false;
  if (parts[0] === 'ip4' && parts[1] === '0.0.0.0') return true;
  if (parts[0] === 'ip6' && parts[1] === '::') return true;
  return false;
}

function isPublicAnnounceAddress(
  addr: string,
  hostInterfaces: ReadonlyArray<NetworkInterfaceInfo>,
): boolean {
  if (isWildcardMultiaddr(addr)) return false;
  const klass = classifyMultiaddr(addr, hostInterfaces);
  return klass === 'public';
}

/**
 * DNS hostnames that cannot resolve to a globally routable address. A node
 * announcing one of these is misconfigured, so the indeterminate-rescue
 * heuristic excludes them: we only let a DNS announce stop a refuse-to-boot
 * when the operator declared a name that *could* resolve to a public IP.
 *
 *   - `localhost`, `*.localhost`     → RFC 6761 (always loopback)
 *   - `*.local`                      → RFC 6762 (mDNS, local link only)
 *   - `*.test`                       → RFC 6761 (testing only)
 *   - `*.example`                    → RFC 6761 (documentation TLD)
 *   - `*.invalid`                    → RFC 6761 (guaranteed-not-resolvable)
 *   - single-label (no dot)          → not a fully-qualified domain name
 */
function isReservedDnsName(name: string): boolean {
  // Codex #661 (discussion_r3302752890): FQDNs may carry a trailing root
  // dot (e.g. `localhost.`, `relay.test.`, `svc.cluster.local.`); without
  // stripping it the `.local`/`.test` suffix checks miss and a reserved
  // name leaks through as a usable DNS host that would rescue a degraded
  // listener.
  const lower = name.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost') return true;
  if (lower.endsWith('.localhost')) return true;
  if (lower.endsWith('.local')) return true;
  if (lower.endsWith('.test')) return true;
  if (lower.endsWith('.example')) return true;
  if (lower.endsWith('.invalid')) return true;
  if (!lower.includes('.')) return true;
  return false;
}

/**
 * Extract the hostname segment from a `/dns(4|6|addr)/<host>/...` multiaddr.
 * Returns `null` for non-DNS multiaddrs.
 */
function dnsHostFromAddr(addr: string): string | null {
  const parts = addr.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const proto = parts[0];
  if (proto !== 'dns' && proto !== 'dns4' && proto !== 'dns6' && proto !== 'dnsaddr') {
    return null;
  }
  return parts[1];
}

/**
 * Pick the best (most-public) class across a host's interface IPs. Wins
 * order: public > dns > ulaIpv6 > rfc1918 > cgnat > linkLocal > loopback >
 * reserved > everything else. We treat the wildcard binding as "effectively
 * the best interface" since libp2p will accept inbound on any of them.
 */
function bestClassAmongInterfaces(
  ifs: ReadonlyArray<NetworkInterfaceInfo>,
  family: 'IPv4' | 'IPv6',
): AddrClassification {
  let best: AddrClassification = 'wildcardNoPublicInterface';
  const RANK: Record<AddrClassification, number> = {
    wildcardNoPublicInterface: -1,
    unknown: 0,
    reserved: 1,
    multicast: 1,
    relayed: 1,
    loopback: 2,
    linkLocal: 3,
    cgnat: 4,
    rfc1918: 5,
    ulaIpv6: 6,
    dns: 7,
    public: 8,
  };
  for (const i of ifs) {
    if (i.internal) continue;
    if (i.family !== family) continue;
    const klass = i.family === 'IPv6' ? classifyIPv6(i.address) : classifyIPv4(i.address);
    if (RANK[klass] > RANK[best]) best = klass;
  }
  return best;
}

/**
 * Classify a single multiaddr string.
 *
 * Multiaddr format is `/proto1/value1/proto2/value2/...` — we only need the
 * first two segments (transport address; the rest is port + circuit/relay
 * tail). String split keeps us free of a runtime multiaddr-parser
 * dependency.
 */
export function classifyMultiaddr(
  addr: string,
  hostInterfaces: ReadonlyArray<NetworkInterfaceInfo> = [],
): AddrClassification {
  const parts = addr.split('/').filter(Boolean);
  if (parts.length < 2) return 'unknown';
  if (parts.includes('p2p-circuit')) return 'relayed';
  const proto = parts[0];
  const value = parts[1];

  if (proto === 'dns' || proto === 'dns4' || proto === 'dns6' || proto === 'dnsaddr') {
    return 'dns';
  }

  if (proto === 'ip4') {
    if (value === '0.0.0.0') return bestClassAmongInterfaces(hostInterfaces, 'IPv4');
    return classifyIPv4(value);
  }

  if (proto === 'ip6') {
    if (value === '::') return bestClassAmongInterfaces(hostInterfaces, 'IPv6');
    return classifyIPv6(value);
  }

  return 'unknown';
}

/**
 * Run the full prereq check. Returns the structured result; never throws.
 *
 * Callers (lifecycle.ts) format the result for operator logs and decide
 * whether to escalate via the `core.allowDegradedRelay` config gate
 * (default `true` — warn-only, no behaviour change for backcompat).
 */
export function checkCoreRelayPrereqs(
  opts: CheckCoreRelayPrereqsOpts,
): CorePrereqResult {
  const { listenAddresses, hostInterfaces = [], announceAddresses = [], nodeRole } = opts;

  const classified = listenAddresses.map((addr) => ({
    addr,
    class: classifyMultiaddr(addr, hostInterfaces),
  }));

  const publicListenAddresses = classified
    .filter((c) => c.class === 'public')
    .map((c) => c.addr);
  const nonRoutableAddresses = classified.filter((c) => c.class !== 'public');

  const announcePublic = announceAddresses.some((a) => isPublicAnnounceAddress(a, hostInterfaces));
  const announceCanServe = classified.some(
    (c) => c.class === 'rfc1918'
      || c.class === 'wildcardNoPublicInterface',
  );
  // DNS announce evidence: a non-reserved hostname is not statically
  // verifiable (we don't resolve here) but it's also not a footgun like a
  // private IP. The lifecycle layer should treat this as warn-only rather
  // than refuse-to-boot, so we surface a soft rescue + the `indeterminate`
  // flag below for callers that want to upgrade the warning.
  const announceUsableDns = announceAddresses.some((a) => {
    const host = dnsHostFromAddr(a);
    return host !== null && !isReservedDnsName(host);
  });
  const announceRescues = announceCanServe && announcePublic;
  const announceIndeterminateRescues = nodeRole === 'core'
    && publicListenAddresses.length === 0
    && !announceRescues
    && announceCanServe
    && announceUsableDns;

  const looksDegraded = nodeRole === 'core'
    && publicListenAddresses.length === 0
    && !announceRescues
    && !announceIndeterminateRescues;

  const indeterminate = announceIndeterminateRescues;

  const reasons: string[] = [];
  if (looksDegraded) {
    const total = listenAddresses.length;
    if (total === 0) {
      reasons.push('listenAddresses is empty');
    } else {
      // Group by class so the reason summarises the failure mode rather than
      // listing every address. Operators can grep the structured nonRoutableAddresses
      // for the full set.
      const counts = new Map<AddrClassification, number>();
      for (const { class: c } of nonRoutableAddresses) {
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
      const summary = Array.from(counts.entries())
        .map(([c, n]) => `${n} ${c}`)
        .join(', ');
      reasons.push(
        `all ${total} listenAddress${total === 1 ? '' : 'es'} are non-routable (${summary})`,
      );
    }
    if (announceAddresses.length > 0 && !announcePublic) {
      reasons.push(
        `${announceAddresses.length} announceAddress${announceAddresses.length === 1 ? '' : 'es'} present but none classify as a literal public IP`,
      );
    }
    if (announceAddresses.length === 0) {
      reasons.push('no announceAddresses configured (would have rescued an otherwise-degraded result)');
    }
  } else if (indeterminate) {
    // Surface why the boot was allowed despite a non-routable listener — so
    // operators see in the structured result that the rescue was soft, not a
    // proof of public reachability. Lifecycle layers can log this verbatim.
    reasons.push(
      `non-routable listener tolerated because announceAddresses include a DNS hostname; reachability cannot be statically verified (set core.allowDegradedRelay: false and pre-resolve DNS to enforce strictly)`,
    );
  }

  return {
    publicListenAddresses,
    nonRoutableAddresses,
    looksDegraded,
    indeterminate,
    reasons,
  };
}
