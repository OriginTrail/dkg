import { isIP } from 'node:net';

/**
 * NAT-status tracking + AutoNAT boot self-probe for core nodes.
 *
 * # What this module does
 *
 * Exposes a module-level cache of the node's most-recent NAT
 * reachability classification (`'public' | 'private' | 'unknown'`).
 * `startNatStatusWatcher()` subscribes to libp2p's `self:peer:update`
 * eventbus (the same event the dialable-log feature in
 * `packages/core/src/node.ts:1341` already listens to) and re-classifies
 * on every address-set change.
 *
 * # Why this exists
 *
 * Per the PR-3 boot-time sanity check (#661): a core node that binds
 * only to Tailscale-CGNAT / RFC1918 / loopback can't function as a
 * relay. PR-3 catches the config-time mistake. This module catches the
 * runtime equivalent — the node looked OK at config time but post-start
 * libp2p's AutoNAT determined it's actually behind an unfriendly NAT
 * and none of its addresses are reachable from outside.
 *
 * Feeds `daemonState.natStatus` (added by PR-4 #662) which the
 * `/api/status` `relay` block surfaces to operators / monitoring.
 *
 * # Why a standalone module instead of inline in lifecycle.ts
 *
 * 1. **Pure-logic testability.** The classification rule
 *    (`classifyAddressesForNat`) is a pure function over multiaddr
 *    strings — unit-testable without spinning up libp2p.
 * 2. **Avoids merge conflict with PR-4 (#662).** PR-4 added the
 *    `daemonState.natStatus` slot; if PR-5 also touched that file the
 *    two would conflict. By exposing `setNatStatus` here and having
 *    PR-4 (after merge) read either the slot or via this module's
 *    getter, the two PRs are landable independently in any order.
 * 3. **Encapsulates the libp2p AutoNAT spike result.** The plan called
 *    for a spike to verify the event surface. Spike outcome: AutoNAT v1
 *    has no public status getter (confirmed via @libp2p/autonat dist
 *    types — only the factory + init shape is exported). The
 *    canonical source for reachability decisions is
 *    `node.getMultiaddrs()` AFTER AutoNAT has had a chance to mark
 *    addresses verified, which is signalled by `self:peer:update`
 *    events. This module encodes that finding so future readers don't
 *    repeat the spike.
 *
 * # The classification rule
 *
 * After AutoNAT runs (or doesn't, in offline / no-peer scenarios),
 * libp2p's getMultiaddrs() returns the publicly-announced address set.
 * We classify the node as:
 *
 *   - `'public'`  if at least one returned multiaddr is a routable
 *                 public IP (PR-3's `classifyMultiaddr` logic) AND it's
 *                 NOT a circuit-relay relayed address.
 *   - `'private'` if every returned multiaddr is non-routable
 *                 (rfc1918, cgnat, loopback, linkLocal, ulaIpv6) OR
 *                 the only routable addresses are circuit-relay
 *                 transitions (`/p2p-circuit`), which means the node
 *                 is reachable only through a relay it doesn't run.
 *   - `'unknown'` until the first `self:peer:update` event fires, OR
 *                 if the address list is empty (boot race before
 *                 libp2p has finished binding sockets).
 *
 * The watcher fires the gate callback (`onClassification`) every time
 * the classification CHANGES, not on every address update. Operators
 * subscribing to the status block see clean transitions, not noise.
 */

/** Single source of truth for the type — referenced by both this module + PR-4's daemonState slot. */
export type NatStatus = 'public' | 'private' | 'unknown';

/**
 * Module-level cache. Mutable by design — this is the slot the watcher
 * writes to and PR-4's `/api/status` reads from. Public API:
 * `getNatStatus()` for callers, `_setNatStatusForTest()` for tests that
 * want to seed the state without going through the watcher.
 */
let cachedNatStatus: NatStatus = 'unknown';

export function getNatStatus(): NatStatus {
  return cachedNatStatus;
}

/**
 * Test seam. Not for production code. Production writes happen inside
 * the watcher returned by `startNatStatusWatcher`.
 */
export function _setNatStatusForTest(status: NatStatus): void {
  cachedNatStatus = status;
}

export function resetNatStatus(): void {
  cachedNatStatus = 'unknown';
}

/**
 * Classify a set of multiaddr strings into a NAT-status verdict.
 *
 * Pure function. The actual classifier delegates to the same set of
 * predicates PR-3 (#661) uses, but inlined here because the classifier
 * lives in a sibling module and importing it would create a dependency
 * loop (lifecycle imports both core-prereq-check AND nat-status; if
 * nat-status imports core-prereq-check we'd have a triangle that some
 * bundlers resolve in surprising ways).
 *
 * The inline rules below are intentionally a SUBSET of PR-3's
 * classifier: we only need the public-vs-non-public distinction here,
 * and routing through PR-3 would force this module to depend on PR-3
 * being merged first. Keep them parallel; if PR-3's rules ever extend
 * in a way that matters here, sync by hand. Both have unit-test
 * coverage so drift will surface in CI.
 */
export function classifyAddressesForNat(addrs: ReadonlyArray<string>): NatStatus {
  if (addrs.length === 0) return 'unknown';
  let sawAnyPublic = false;
  let sawAnyDirect = false;
  for (const addr of addrs) {
    if (addr.includes('/p2p-circuit')) continue;
    sawAnyDirect = true;
    if (isPublicMultiaddr(addr)) {
      sawAnyPublic = true;
    }
  }
  if (sawAnyPublic) return 'public';
  if (!sawAnyDirect) return 'private';
  return 'private';
}

/**
 * Minimal multiaddr classifier — public IPv4/IPv6 only. Anything that
 * fails the public test (loopback, RFC1918, CGNAT, link-local, ULA,
 * documentation ranges) is treated as non-public.
 *
 * DNS-form addresses are treated as public only when they pass the same
 * public-hostname exclusions used by the core reachability helper. We do
 * not resolve DNS here; split-horizon/internal names stay non-public.
 */
function isLocalOrInternalHostname(host: string): boolean {
  if (typeof host !== 'string' || host.length === 0) return true;
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost') return true;
  if (h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (h.endsWith('.test') || h.endsWith('.example')) return true;
  if (h.endsWith('.invalid') || h.endsWith('.localdomain')) return true;
  if (h.endsWith('.internal') || h.endsWith('.lan')) return true;
  if (h.endsWith('.home.arpa') || h.endsWith('.cluster.local')) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (/^\[?[0-9a-f:]+\]?$/.test(h) && h.includes(':')) return true;
  if (!h.includes('.')) return true;
  return false;
}

function isPublicMultiaddr(addr: string): boolean {
  const dnsMatch = addr.match(/^\/(?:dns|dns4|dns6|dnsaddr)\/([^/]+)/);
  if (dnsMatch) {
    return !isLocalOrInternalHostname(dnsMatch[1]);
  }
  const ip4Match = addr.match(/^\/ip4\/(\d+)\.(\d+)\.(\d+)\.(\d+)\//);
  if (ip4Match) {
    const [, a, b, c, d] = ip4Match;
    const ip4 = `${a}.${b}.${c}.${d}`;
    if (isIP(ip4) !== 4) return false;
    const A = parseInt(a, 10);
    const B = parseInt(b, 10);
    const C = parseInt(c, 10);
    if (A === 127) return false;
    if (A === 10) return false;
    if (A === 172 && B >= 16 && B <= 31) return false;
    if (A === 192 && B === 168) return false;
    if (A === 100 && B >= 64 && B <= 127) return false;
    if (A === 169 && B === 254) return false;
    if (A === 0) return false;
    if (A >= 224) return false;
    if (A === 192 && B === 0 && C === 2) return false;
    if (A === 198 && (B === 18 || B === 19)) return false;
    if (A === 198 && B === 51 && C === 100) return false;
    if (A === 203 && B === 0 && C === 113) return false;
    return true;
  }
  const ip6Match = addr.match(/^\/ip6\/([0-9a-fA-F:]+)\//);
  if (ip6Match) {
    const ip6 = ip6Match[1].toLowerCase();
    if (isIP(ip6) !== 6) return false;
    const firstHextet = parseInt(ip6.split(':')[0] || '0', 16);
    if (ip6 === '::1') return false;
    if ((firstHextet & 0xffc0) === 0xfe80) return false;
    if ((firstHextet & 0xfe00) === 0xfc00) return false;
    if ((firstHextet & 0xff00) === 0xff00) return false;
    if (ip6 === '::' || ip6.startsWith('::')) return false;
    if (ip6.startsWith('2001:db8:') || ip6.startsWith('2001:0db8:')) return false;
    return true;
  }
  return false;
}

/**
 * libp2p eventbus shape we care about. Defined as a minimal structural
 * interface so tests don't have to construct a real libp2p instance.
 */
export interface AutoNatWatcherNode {
  addEventListener(event: 'self:peer:update', handler: () => void): void;
  removeEventListener(event: 'self:peer:update', handler: () => void): void;
  getMultiaddrs(): Array<{ toString(): string }>;
}

export interface StartNatWatcherOpts {
  node: AutoNatWatcherNode;
  /**
   * Called on every CLASSIFICATION CHANGE (not every address update).
   * `previous` is the cached value before the change. The watcher
   * updates the module cache BEFORE invoking this callback.
   */
  onClassification?: (status: NatStatus, previous: NatStatus) => void;
  /**
   * Soft timeout — if no `self:peer:update` event has fired in
   * `softTimeoutMs`, the watcher emits one synthetic classification
   * pass against whatever `getMultiaddrs()` currently returns. Lets a
   * `'private'` verdict surface for nodes whose AutoNAT probe times
   * out (e.g. behind a closed firewall with no peers responding) so
   * operators get a status block rather than indefinite `'unknown'`.
   * Default: 60s. Set to `0` to disable.
   */
  softTimeoutMs?: number;
}

const DEFAULT_NAT_SOFT_TIMEOUT_MS = 60_000;

/**
 * Subscribe to libp2p NAT-status signals and update the module cache.
 *
 * Returns a `stop()` handle the supervisor / daemon shutdown path MUST
 * call — otherwise the listener leaks on respawn, and after enough
 * cycles libp2p starts logging max-listener warnings.
 *
 * Idempotent re-entry guarded by the caller (we don't track watchers
 * here; callers always create one per lifecycle).
 */
export function startNatStatusWatcher(opts: StartNatWatcherOpts): { stop(): void } {
  const softTimeoutMs = opts.softTimeoutMs ?? DEFAULT_NAT_SOFT_TIMEOUT_MS;
  let stopped = false;
  let softTimer: ReturnType<typeof setTimeout> | null = null;
  let sawDefinitiveClassification = false;

  // Codex (#668#discussion_r3302734688): the very first `self:peer:update`
  // also fires for the initial post-listen peer record AutoNAT publishes
  // when the daemon binds. If that record contains only RFC1918/CGNAT
  // multiaddrs (common during a cold boot before AutoNAT has verified
  // external reach), the previous logic marked `private` as DEFINITIVE
  // — disabling the soft timeout and locking the verdict until a later
  // address-update event happened (which may never come on a stable
  // private-only host). Treat the FIRST non-public, non-unknown
  // reclassification the same as the initial bound-address snapshot:
  // report it via the cache for `/api/status` observability, but DO NOT
  // mark it definitive. Only the soft-timeout or a SUBSEQUENT non-public
  // event escalates to definitive.
  let sawAnyEventReclassify = false;

  const reclassify = (cause: 'event' | 'soft-timeout' | 'initial'): NatStatus => {
    if (stopped) return cachedNatStatus;
    const addrs = opts.node.getMultiaddrs().map((ma) => ma.toString());
    const next = classifyAddressesForNat(addrs);
    if (cause === 'initial' && next !== 'public') {
      // The first post-start snapshot is only the bound-address baseline.
      // AutoNAT has not necessarily updated the peer record yet, so do not
      // turn RFC1918/CGNAT binds into a definitive private verdict here.
      return cachedNatStatus;
    }
    if (cause === 'event' && next === 'private' && !sawAnyEventReclassify) {
      // First post-listen `self:peer:update` is still effectively the
      // bound-address baseline — AutoNAT may not have published a
      // verified external address yet. See Codex #668 note above.
      sawAnyEventReclassify = true;
      const previous = cachedNatStatus;
      if (next !== previous) {
        cachedNatStatus = next;
        opts.onClassification?.(next, previous);
      }
      return next;
    }
    if (cause === 'event' && next !== 'unknown') {
      sawAnyEventReclassify = true;
    }
    if (next !== 'unknown') {
      sawDefinitiveClassification = true;
    }
    const previous = cachedNatStatus;
    if (next === previous) {
      if (cause === 'soft-timeout') {
        // Soft-timeout fired but classification didn't change. Don't
        // call the callback — operators only want to hear about
        // transitions, not "still 'unknown' after 60s". The status
        // block continues to expose the cached value.
      }
      return next;
    }
    cachedNatStatus = next;
    opts.onClassification?.(next, previous);
    return next;
  };

  const onEvent = () => {
    reclassify('event');
  };

  opts.node.addEventListener('self:peer:update', onEvent);

  // Capture the initial baseline. Public addrs are safe to surface
  // immediately; private addrs wait for a real `self:peer:update` or the soft
  // timeout before becoming definitive.
  reclassify('initial');

  if (softTimeoutMs > 0) {
    softTimer = setTimeout(() => {
      if (stopped || sawDefinitiveClassification) return;
      reclassify('soft-timeout');
    }, softTimeoutMs);
    // Don't keep the parent process alive just to fire the soft timer.
    // Lifecycle is responsible for calling stop() before exit.
    if (softTimer.unref) softTimer.unref();
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      opts.node.removeEventListener('self:peer:update', onEvent);
      if (softTimer) clearTimeout(softTimer);
      resetNatStatus();
    },
  };
}
