/**
 * Unit tests for the AutoNAT-driven NAT-status watcher.
 *
 * Two-layer coverage:
 *   - `classifyAddressesForNat` is a pure function over multiaddr
 *     strings. Heavy table-driven coverage (public/private/CGNAT/
 *     loopback/IPv6/DNS/circuit-relay).
 *   - `startNatStatusWatcher` is wired to a mock eventbus + getMultiaddrs.
 *     Verifies transition-only callback semantics, soft-timeout firing
 *     when no event arrives, stop() teardown.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  classifyAddressesForNat,
  startNatStatusWatcher,
  getNatStatus,
  _setNatStatusForTest,
  type AutoNatWatcherNode,
  type NatStatus,
} from '../src/daemon/nat-status.js';

// Hand-rolled callback recorder (no vitest mock API): a plain function that
// records its calls, so the transition-only semantics are asserted against a
// real callable the watcher invokes for real.
function recordOnClass() {
  const calls: Array<[NatStatus, NatStatus]> = [];
  const fn = (next: NatStatus, prev: NatStatus): void => {
    calls.push([next, prev]);
  };
  return Object.assign(fn, { calls });
}

// Soft-timeout tests run on REAL timers: a small configurable softTimeoutMs
// (60ms) plus a real 150ms wait replaces the retired fake-timer advance.
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('classifyAddressesForNat — pure classifier', () => {
  it.each<[string, string[], NatStatus]>([
    ['empty list → unknown', [], 'unknown'],
    // TEST-NET-3 (203.0.113.0/24, RFC5737 documentation range) is
    // explicitly classified as non-public — operators can't actually
    // bind to it on real hosts.
    ['TEST-NET-3 documentation range → private', ['/ip4/203.0.113.5/tcp/4001'], 'private'],
    ['real-world public IPv4 → public', ['/ip4/8.8.8.8/tcp/4001'], 'public'],
    ['loopback → private', ['/ip4/127.0.0.1/tcp/4001'], 'private'],
    ['RFC1918 192.168 → private', ['/ip4/192.168.1.10/tcp/4001'], 'private'],
    ['RFC1918 10.0 → private', ['/ip4/10.0.0.5/tcp/4001'], 'private'],
    ['RFC1918 172.16 → private', ['/ip4/172.20.0.10/tcp/4001'], 'private'],
    ['CGNAT 100.64 → private (Tailscale)', ['/ip4/100.99.142.87/tcp/4001'], 'private'],
    ['link-local 169.254 → private', ['/ip4/169.254.1.1/tcp/4001'], 'private'],
    ['invalid IPv4 octet → private', ['/ip4/999.1.1.1/tcp/4001'], 'private'],
    ['IPv6 loopback ::1 → private', ['/ip6/::1/tcp/4001'], 'private'],
    ['IPv6 link-local fe80 → private', ['/ip6/fe80::1234/tcp/4001'], 'private'],
    ['IPv6 ULA fc00 → private', ['/ip6/fc00::1/tcp/4001'], 'private'],
    ['IPv6 ULA fd00 → private', ['/ip6/fdfd::1/tcp/4001'], 'private'],
    ['IPv6 documentation range → private', ['/ip6/2001:db8::1/tcp/4001'], 'private'],
    ['IPv6 public → public', ['/ip6/2606:4700:4700::1111/tcp/4001'], 'public'],
    ['public DNS form → public (heuristic)', ['/dns4/relay.origintrail.io/tcp/443/wss'], 'public'],
    ['localhost DNS form → private', ['/dns4/localhost/tcp/4001'], 'private'],
    ['single-label DNS form → private', ['/dns4/myhost/tcp/4001'], 'private'],
    ['.local DNS form → private', ['/dns4/relay.local/tcp/4001'], 'private'],
    ['.test DNS form → private', ['/dns4/relay.test/tcp/4001'], 'private'],
    ['.example DNS form → private', ['/dns4/relay.example/tcp/4001'], 'private'],
    ['literal IP DNS form → private', ['/dns4/8.8.8.8/tcp/4001'], 'private'],
    ['circuit-relay-only → private', ['/ip4/8.8.8.8/tcp/4001/p2p-circuit/p2p/QmRelay'], 'private'],
    ['mix: public + circuit → public', ['/ip4/8.8.8.8/tcp/4001', '/ip4/1.2.3.4/p2p-circuit'], 'public'],
    ['mix: private + circuit → private', ['/ip4/192.168.1.5/tcp/4001', '/ip4/8.8.8.8/p2p-circuit'], 'private'],
    [
      'beacon-01 repro: CGNAT-only Tailscale node',
      ['/ip4/100.99.142.87/tcp/4001/p2p/Qm...'],
      'private',
    ],
  ])('%s', (_label, addrs, expected) => {
    expect(classifyAddressesForNat(addrs)).toBe(expected);
  });
});

interface FakeNode extends AutoNatWatcherNode {
  emit(): void;
  setAddrs(addrs: string[]): void;
}

function makeFakeNode(initial: string[] = []): FakeNode {
  let addrs = initial;
  const listeners: Array<() => void> = [];
  return {
    addEventListener(_event, handler) {
      listeners.push(handler);
    },
    removeEventListener(_event, handler) {
      const idx = listeners.indexOf(handler);
      if (idx >= 0) listeners.splice(idx, 1);
    },
    getMultiaddrs() {
      return addrs.map((a) => ({ toString: () => a }));
    },
    emit() {
      for (const l of listeners) l();
    },
    setAddrs(next) {
      addrs = next;
    },
  };
}

describe('startNatStatusWatcher — transition-only callback semantics', () => {
  beforeEach(() => {
    _setNatStatusForTest('unknown');
  });

  it('fires onClassification on the initial pass when addrs are already public', () => {
    const node = makeFakeNode(['/ip4/8.8.8.8/tcp/4001']);
    const onClass = recordOnClass();
    const w = startNatStatusWatcher({ node, onClassification: onClass, softTimeoutMs: 0 });
    expect(onClass.calls).toHaveLength(1);
    expect(onClass.calls).toContainEqual(['public', 'unknown']);
    expect(getNatStatus()).toBe('public');
    w.stop();
  });

  it('does NOT fire onClassification when classification is unchanged across events', () => {
    const node = makeFakeNode(['/ip4/8.8.8.8/tcp/4001']);
    const onClass = recordOnClass();
    const w = startNatStatusWatcher({ node, onClassification: onClass, softTimeoutMs: 0 });
    node.emit();
    expect(onClass.calls).toHaveLength(1);
    node.setAddrs(['/ip4/8.8.8.8/tcp/4001', '/ip4/1.1.1.1/tcp/4001']);
    node.emit();
    expect(onClass.calls).toHaveLength(1);
    w.stop();
  });

  it('fires onClassification on a public → private transition', () => {
    const node = makeFakeNode(['/ip4/8.8.8.8/tcp/4001']);
    const onClass = recordOnClass();
    const w = startNatStatusWatcher({ node, onClassification: onClass, softTimeoutMs: 0 });
    node.emit();
    expect(onClass.calls.at(-1)).toEqual(['public', 'unknown']);
    node.setAddrs(['/ip4/192.168.1.5/tcp/4001']);
    node.emit();
    expect(onClass.calls).toHaveLength(2);
    expect(onClass.calls.at(-1)).toEqual(['private', 'public']);
    w.stop();
  });

  it('boot race: starts before addrs populated (initial pass classifies as unknown, first event flips to public)', () => {
    const node = makeFakeNode([]);
    const onClass = recordOnClass();
    const w = startNatStatusWatcher({ node, onClassification: onClass, softTimeoutMs: 0 });
    expect(getNatStatus()).toBe('unknown');
    expect(onClass.calls).toHaveLength(0);
    node.setAddrs(['/ip4/8.8.8.8/tcp/4001']);
    node.emit();
    expect(onClass.calls).toHaveLength(1);
    expect(onClass.calls.at(-1)).toEqual(['public', 'unknown']);
    w.stop();
  });
});

describe('startNatStatusWatcher — soft-timeout', () => {
  beforeEach(() => {
    _setNatStatusForTest('unknown');
  });

  it('reclassifies once at the soft-timeout deadline if no event has fired', async () => {
    const node = makeFakeNode([]);
    const onClass = recordOnClass();
    const w = startNatStatusWatcher({ node, onClassification: onClass, softTimeoutMs: 60 });
    // No event fired yet → still 'unknown'.
    expect(onClass.calls).toHaveLength(0);
    // Populate addrs so the soft-timeout pass has something to classify.
    node.setAddrs(['/ip4/192.168.1.5/tcp/4001']);
    await sleep(150);
    expect(onClass.calls).toHaveLength(1);
    expect(onClass.calls.at(-1)).toEqual(['private', 'unknown']);
    w.stop();
  });

  it('does not mark private before the first event; soft timeout remains active', async () => {
    const node = makeFakeNode(['/ip4/192.168.1.5/tcp/4001']);
    const onClass = recordOnClass();
    const w = startNatStatusWatcher({ node, onClassification: onClass, softTimeoutMs: 60 });
    expect(getNatStatus()).toBe('unknown');
    expect(onClass.calls).toHaveLength(0);

    await sleep(150);
    expect(onClass.calls).toHaveLength(1);
    expect(onClass.calls.at(-1)).toEqual(['private', 'unknown']);
    w.stop();
  });

  it('does NOT fire the soft-timeout pass if an event already fired', async () => {
    const node = makeFakeNode([]);
    const onClass = recordOnClass();
    const w = startNatStatusWatcher({ node, onClassification: onClass, softTimeoutMs: 60 });
    node.setAddrs(['/ip4/8.8.8.8/tcp/4001']);
    node.emit();
    expect(onClass.calls).toHaveLength(1);
    await sleep(150);
    expect(onClass.calls).toHaveLength(1);
    w.stop();
  });

  it('still fires the soft-timeout pass after non-definitive update events', async () => {
    const node = makeFakeNode([]);
    const onClass = recordOnClass();
    const w = startNatStatusWatcher({ node, onClassification: onClass, softTimeoutMs: 60 });
    node.emit();
    expect(onClass.calls).toHaveLength(0);

    node.setAddrs(['/ip4/192.168.1.5/tcp/4001']);
    await sleep(150);
    expect(onClass.calls).toHaveLength(1);
    expect(onClass.calls.at(-1)).toEqual(['private', 'unknown']);
    w.stop();
  });

  it('Codex review — unknown first event does not consume the first private baseline', async () => {
    const node = makeFakeNode([]);
    const onClass = recordOnClass();
    const w = startNatStatusWatcher({ node, onClassification: onClass, softTimeoutMs: 60 });

    node.emit();
    expect(onClass.calls).toHaveLength(0);

    node.setAddrs(['/ip4/192.168.1.5/tcp/4001']);
    node.emit();
    expect(onClass.calls).toHaveLength(1);
    expect(onClass.calls.at(-1)).toEqual(['private', 'unknown']);

    node.setAddrs(['/ip4/8.8.8.8/tcp/4001']);
    await sleep(150);
    expect(onClass.calls).toHaveLength(2);
    expect(onClass.calls.at(-1)).toEqual(['public', 'private']);
    w.stop();
  });

  it('Codex #668 — first event-driven `private` reclassification is not yet definitive (soft timeout still arms)', async () => {
    // Codex (#668#discussion_r3302734688): the very first
    // `self:peer:update` after listen also fires for the initial
    // post-listen peer record AutoNAT publishes. If that record contains
    // only private-class addresses (cold boot before AutoNAT verifies
    // external reach), the previous logic marked `private` as DEFINITIVE
    // immediately — disabling the soft timeout and locking the verdict.
    // The fix: treat the FIRST non-public event-driven reclassification
    // the same as the initial bound-address snapshot.
    const node = makeFakeNode([]);
    const onClass = recordOnClass();
    const w = startNatStatusWatcher({ node, onClassification: onClass, softTimeoutMs: 60 });
    // Simulate AutoNAT's first post-listen update with only private addresses.
    node.setAddrs(['/ip4/192.168.1.5/tcp/4001']);
    node.emit();
    // The status DOES update (so /api/status surfaces the current state),
    // but it MUST NOT be definitive — the soft timeout must still fire
    // for a downstream consumer to receive a non-stale verdict.
    expect(onClass.calls).toContainEqual(['private', 'unknown']);
    // Now AutoNAT verifies an external address and reclassifies to public:
    // the soft timeout did its job because the first private event did not
    // mark `sawDefinitiveClassification`.
    node.setAddrs(['/ip4/8.8.8.8/tcp/4001']);
    node.emit();
    expect(onClass.calls.at(-1)).toEqual(['public', 'private']);
    w.stop();
  });

  it('Codex #668 — second event-driven `private` reclassification IS definitive', async () => {
    // Sanity check the inverse: once an event has fired, a subsequent
    // private classification is treated as the real verdict — we don't
    // permanently suppress the private branch.
    const node = makeFakeNode([]);
    const onClass = recordOnClass();
    const w = startNatStatusWatcher({ node, onClassification: onClass, softTimeoutMs: 60 });
    // First event arrives with public addresses, marks definitive public.
    node.setAddrs(['/ip4/8.8.8.8/tcp/4001']);
    node.emit();
    expect(onClass.calls.at(-1)).toEqual(['public', 'unknown']);
    // Second event flips to private (e.g. external uplink dropped). This
    // is now treated as a definitive transition; the soft timeout would
    // not need to fire again.
    node.setAddrs(['/ip4/192.168.1.5/tcp/4001']);
    node.emit();
    expect(onClass.calls.at(-1)).toEqual(['private', 'public']);
    w.stop();
  });

  it('softTimeoutMs=0 disables the soft-timeout entirely', async () => {
    const node = makeFakeNode([]);
    const onClass = recordOnClass();
    const w = startNatStatusWatcher({ node, onClassification: onClass, softTimeoutMs: 0 });
    node.setAddrs(['/ip4/192.168.1.5/tcp/4001']);
    await sleep(150);
    expect(onClass.calls).toHaveLength(0);
    w.stop();
  });
});

describe('startNatStatusWatcher — stop()', () => {
  beforeEach(() => {
    _setNatStatusForTest('unknown');
  });

  it('removes the eventbus listener so subsequent emits are no-ops', () => {
    const node = makeFakeNode(['/ip4/8.8.8.8/tcp/4001']);
    const onClass = recordOnClass();
    const w = startNatStatusWatcher({ node, onClassification: onClass, softTimeoutMs: 0 });
    node.emit();
    expect(onClass.calls).toHaveLength(1);
    w.stop();
    node.setAddrs(['/ip4/192.168.1.5/tcp/4001']);
    node.emit();
    expect(onClass.calls).toHaveLength(1);
  });

  it('resets the cached status to unknown on stop()', () => {
    const node = makeFakeNode(['/ip4/8.8.8.8/tcp/4001']);
    const w = startNatStatusWatcher({ node, softTimeoutMs: 0 });
    node.emit();
    expect(getNatStatus()).toBe('public');
    w.stop();
    expect(getNatStatus()).toBe('unknown');
  });

  it('stop() is idempotent — second call is a no-op', () => {
    const node = makeFakeNode(['/ip4/8.8.8.8/tcp/4001']);
    const w = startNatStatusWatcher({ node, softTimeoutMs: 0 });
    w.stop();
    w.stop();
  });
});

describe('module-level cache', () => {
  it('getNatStatus reflects the most-recent classification', () => {
    _setNatStatusForTest('unknown');
    expect(getNatStatus()).toBe('unknown');
    const node = makeFakeNode(['/ip4/8.8.8.8/tcp/4001']);
    const w = startNatStatusWatcher({ node, softTimeoutMs: 0 });
    node.emit();
    expect(getNatStatus()).toBe('public');
    w.stop();
  });
});
