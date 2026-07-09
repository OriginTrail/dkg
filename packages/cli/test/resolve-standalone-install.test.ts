import { describe, it, expect, beforeEach } from 'vitest';
import {
  daemonState,
  resolveStandaloneInstall,
  resolveAutoUpdateEnabled,
  resolveAutoUpdatePollingMode,
} from '../src/daemon/state.js';

// `resolveStandaloneInstall` mutates `daemonState.standaloneCache` as a side
// effect. Reset to `null` between tests so each case starts from a known
// state. We don't need to mock the underlying `isStandaloneInstall()` probe:
// every behaviour we care about (override-wins, cache-hit, override-seeds-cache,
// override-flips-cache) can be observed via the cache slot directly, and the
// "probe gets called when cache is null and no override" case is checked
// indirectly by asserting the cache becomes non-null after such a call.

describe('resolveStandaloneInstall', () => {
  beforeEach(() => {
    daemonState.standaloneCache = null;
  });

  describe("source === 'npm' override", () => {
    it('returns true regardless of cache state', () => {
      // Even if the filesystem probe would say "this looks like a clone"
      // (because there's a `.git` at the worktree root, which is the
      // beacon-01 case), the override forces npm semantics.
      daemonState.standaloneCache = false;
      expect(resolveStandaloneInstall('npm')).toBe(true);
    });

    it('overwrites a cached `false` (operator flipping their mind)', () => {
      daemonState.standaloneCache = false;
      resolveStandaloneInstall('npm');
      expect(daemonState.standaloneCache).toBe(true);
    });

    it('seeds the cache when previously null (boot path)', () => {
      // Lifecycle.ts is the first caller during boot, so the cache is null.
      // This case is the one that matters for beacon-01: the cache MUST be
      // populated so later callers (status route, `dkg update` CLI) read the
      // same answer instead of re-probing the filesystem.
      resolveStandaloneInstall('npm');
      expect(daemonState.standaloneCache).toBe(true);
    });
  });

  describe("source === 'git' override", () => {
    it('returns false regardless of cache state', () => {
      // "False" here means "not an npm standalone updater". Lifecycle uses
      // resolveAutoUpdatePollingMode to distinguish git updater mode from
      // contributor monorepo mode.
      daemonState.standaloneCache = true;
      expect(resolveStandaloneInstall('git')).toBe(false);
    });

    it('overwrites a cached `true` (operator flipping their mind)', () => {
      daemonState.standaloneCache = true;
      resolveStandaloneInstall('git');
      expect(daemonState.standaloneCache).toBe(false);
    });
  });

  describe("source === 'auto' (or undefined) — fall-through to probe", () => {
    it('returns the cached value when cache is populated, without re-probing', () => {
      // Cache hit is the common path: after boot, every API request re-reads
      // standalone-install without paying the filesystem-stat cost.
      daemonState.standaloneCache = true;
      expect(resolveStandaloneInstall('auto')).toBe(true);
      expect(resolveStandaloneInstall(undefined)).toBe(true);
      expect(resolveStandaloneInstall()).toBe(true);

      daemonState.standaloneCache = false;
      expect(resolveStandaloneInstall('auto')).toBe(false);
      expect(resolveStandaloneInstall(undefined)).toBe(false);
      expect(resolveStandaloneInstall()).toBe(false);
    });

    it('populates the cache from the probe when both cache is null and no override', () => {
      // We don't assert the EXACT probe result (it depends on whether this
      // test runs in a worktree with `.git` or not — true for CI and local).
      // The contract is: a call with no override on an empty cache must
      // run the probe + persist the result so subsequent calls hit the cache.
      expect(daemonState.standaloneCache).toBeNull();
      const probed = resolveStandaloneInstall();
      expect(daemonState.standaloneCache).toBe(probed);
      expect(typeof probed).toBe('boolean');
    });
  });

  describe('cross-call semantics — what the supervisor + status route see', () => {
    it("seeded cache value is read back by callers that pass no override", () => {
      // The invariant from lifecycle.ts:1062: first caller seeds, every later
      // caller (status route, `dkg update` CLI, MCP `dkg_status`) reads back
      // the same answer.
      resolveStandaloneInstall('npm');
      expect(resolveStandaloneInstall()).toBe(true);
      expect(resolveStandaloneInstall('auto')).toBe(true);
    });

    it("second call with the opposite explicit override flips the cache (boot order matters)", () => {
      // Edge case: two callers in the same boot disagree on `source`. The
      // last writer wins. This would be a bug somewhere upstream (the config
      // should be resolved once and passed everywhere), but the helper is
      // defensive about it rather than silently keeping the stale value.
      resolveStandaloneInstall('npm');
      expect(resolveStandaloneInstall('git')).toBe(false);
      expect(daemonState.standaloneCache).toBe(false);
    });
  });
});

describe('resolveAutoUpdateEnabled — integrated with the new override', () => {
  beforeEach(() => {
    daemonState.standaloneCache = null;
  });

  it("treats node as standalone when config sets autoUpdate.source = 'npm', applying the npm default (enabled => true)", () => {
    // This is the beacon-01 unblock path: even though the filesystem says
    // "monorepo" (forcing cache=false on the standard probe), the source
    // override pins it as standalone, and the standalone branch defaults
    // `enabled` to true unless explicitly disabled.
    const config: any = { autoUpdate: { source: 'npm' } };
    expect(resolveAutoUpdateEnabled(config)).toBe(true);
    expect(daemonState.standaloneCache).toBe(true);
  });

  it("keeps source='git' disabled by default unless enabled is explicit", () => {
    const config: any = { autoUpdate: { source: 'git' } };
    expect(resolveAutoUpdateEnabled(config)).toBe(false);
    expect(daemonState.standaloneCache).toBe(false);
  });

  it("explicit `enabled: false` overrules the npm default even when source is 'npm'", () => {
    // Operator can still opt out via `enabled: false`; the source override
    // pins the install-path classification but doesn't force-enable updates.
    const config: any = { autoUpdate: { source: 'npm', enabled: false } };
    expect(resolveAutoUpdateEnabled(config)).toBe(false);
  });

  it("explicit `enabled: true` works with source='git' even though the default is disabled", () => {
    // Git mode is an explicit opt-in: source selects the updater family, while
    // enabled still controls whether daemon polling applies updates.
    const config: any = { autoUpdate: { source: 'git', enabled: true } };
    expect(resolveAutoUpdateEnabled(config)).toBe(true);
  });
});

describe('resolveAutoUpdatePollingMode', () => {
  it("keeps npm as the default polling mode for standalone installs when source is unset or 'npm'", () => {
    expect(resolveAutoUpdatePollingMode(undefined, true)).toBe('npm');
    expect(resolveAutoUpdatePollingMode('npm', true)).toBe('npm');
  });

  it("selects git polling only for explicit source='git'", () => {
    expect(resolveAutoUpdatePollingMode('git', false)).toBe('git');
    expect(resolveAutoUpdatePollingMode('git', true)).toBe('git');
  });

  it('keeps monorepo checkouts out of package polling', () => {
    expect(resolveAutoUpdatePollingMode(undefined, false)).toBe('monorepo');
    expect(resolveAutoUpdatePollingMode('auto', false)).toBe('monorepo');
    expect(resolveAutoUpdatePollingMode('monorepo', false)).toBe('monorepo');
  });
});
