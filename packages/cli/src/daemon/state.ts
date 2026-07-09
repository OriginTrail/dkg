// Shared module-level mutable state for the split `daemon` modules.
//
// The original single-file `daemon.ts` kept a handful of module-level
// `let`/`const` bindings that were read and mutated from multiple
// long-lived sections of the file (manifest helpers, lifecycle,
// handleRequest, auto-update). After splitting those sections into
// sibling files under `daemon/` we need one canonical home for that
// state so every module sees the same value.
//
// We bundle them into one exported object so that `let` bindings stay
// mutable across module boundaries (a direct `export let isUpdating`
// would be read-only for every importer). Mutation goes through the
// object reference, e.g. `daemonState.isUpdating = true`.

import type { CatchupRunner } from '../catchup-runner.js';
import type { DkgConfig } from '../config.js';
import { isStandaloneInstall } from '../config.js';

export type CorsAllowlist = '*' | string[];

/**
 * Verbose sync-progress tracing. Opt-in via either env var. Referenced
 * from the catch-up job handler (routes/context-graph.ts) plus the
 * daemon bootstrap path, so it lives here next to `daemonState` rather
 * than inside any one module.
 */
export const DEBUG_SYNC_TRACE =
  process.env.DKG_DEBUG_SYNC_PROGRESS === '1' || process.env.DKG_DEBUG_SYNC === '1';

export const daemonState: {
  /** Populated in `runDaemonInner` once the DKGAgent is ready. */
  catchupRunner: CatchupRunner | null;
  /** Set to `true` while a package or git slot update is in flight. */
  isUpdating: boolean;
  /** Most recent "is this daemon up to date?" result; polled by `/status`. */
  lastUpdateCheck: {
    upToDate: boolean;
    checkedAt: number;
    latestCommit: string;
    latestVersion: string;
    /** True when a pinned auto-update channel has no acceptable target
     *  (tag missing / prerelease rejected / non-semver). Distinct from
     *  `upToDate` so `/api/status` can show a misconfigured channel. */
    channelTargetMissing: boolean;
  };
  /** Memoised result of `isStandaloneInstall()` — null = not yet checked. */
  standaloneCache: boolean | null;
  /**
   * Best-known NAT reachability for this node, surfaced via `/api/status` →
   * `relay.natStatus`. Default `'unknown'`; populated by the AutoNAT-driven
   * boot self-probe (planned in a follow-up PR) which subscribes to libp2p's
   * AddressManager confidence events. Lives on `daemonState` (rather than
   * inside the route file) so the probe doesn't have to know about the
   * route, and the route doesn't have to know about the probe — they
   * rendezvous through this slot.
   */
  natStatus: 'public' | 'private' | 'unknown';
  /** CORS allowlist, set by `runDaemonInner`, read in `handleRequest`. */
  moduleCorsAllowed: CorsAllowlist;
  /**
   * Whether the async-promote queue worker is currently able to drain
   * queued jobs. Defaults to `false`; the worker supervisor (this PR)
   * flips it to `true` on successful startup so the
   * `/promote-async` routes can accept jobs, and back to `false` on
   * shutdown / supervisor crash so they return `503` rather than
   * silently queueing jobs that nothing will drain.
   */
  promoteWorkerAvailable: boolean;
  /**
   * Last startup/availability error for the async-promote worker.
   * Surfaced alongside the `503` when `promoteWorkerAvailable` is
   * `false` so operators see *why* the queue is closed.
   */
  promoteWorkerUnavailableReason: string | null;
  /** OpenClaw bridge health cache. Mutated from both `openclaw.ts`
   *  (read) and `handle-request.ts` (write after each /send round
   *  trip), so it lives here rather than inside openclaw.ts. */
  openClawBridgeHealth: { ok: boolean; ts: number } | null;
} = {
  catchupRunner: null,
  isUpdating: false,
  lastUpdateCheck: {
    upToDate: true,
    checkedAt: 0,
    latestCommit: '',
    latestVersion: '',
    channelTargetMissing: false,
  },
  standaloneCache: null,
  natStatus: 'unknown',
  moduleCorsAllowed: '*',
  promoteWorkerAvailable: false,
  promoteWorkerUnavailableReason: null,
  openClawBridgeHealth: null,
};

/**
 * Resolve whether this daemon should be treated as a standalone (npm-global)
 * install, honouring the operator's `autoUpdate.source` override if present.
 *
 *   - `source === 'npm'` → return `true` regardless of `.git` presence.
 *   - `source === 'git'` → return `false` regardless of `.git` presence
 *     because git mode is slot-built from source, not an npm install.
 *   - `source === 'auto'` or omitted → fall through to the filesystem probe
 *     (`isStandaloneInstall()`, i.e. `repoDir() === null`).
 *
 * The first call seeds `daemonState.standaloneCache` so every subsequent caller
 * (`resolveAutoUpdateEnabled`, the auto-update setup in `lifecycle.ts`, the
 * `dkg update` CLI subcommand, the status route) reads the same answer for the
 * lifetime of the worker process — no inconsistency where one caller thinks
 * "git" and another thinks "npm".
 *
 * Call this in preference to `isStandaloneInstall()` directly. The latter
 * stays exported (and is the underlying probe) but doesn't honour the override.
 */
export function resolveStandaloneInstall(
  source?: 'auto' | 'npm' | 'git' | 'monorepo',
): boolean {
  if (source === 'npm') {
    daemonState.standaloneCache = true;
    return true;
  }
  if (source === 'git' || source === 'monorepo') {
    // Both modes are non-npm for install-layout/status purposes.
    // Lifecycle dispatch distinguishes the advanced git updater from
    // contributor monorepo mode before deciding whether to poll.
    daemonState.standaloneCache = false;
    return false;
  }
  if (daemonState.standaloneCache === null) {
    daemonState.standaloneCache = isStandaloneInstall();
  }
  return daemonState.standaloneCache;
}

export type AutoUpdatePollingMode = 'npm' | 'git' | 'monorepo';

export function resolveAutoUpdatePollingMode(
  source: 'auto' | 'npm' | 'git' | 'monorepo' | undefined,
  standalone: boolean,
): AutoUpdatePollingMode {
  if (source === 'git') return 'git';
  if (source === 'monorepo') return 'monorepo';
  return standalone ? 'npm' : 'monorepo';
}

/**
 * Is auto-update enabled for this daemon?
 *
 * Standalone installs (npm-global / pnpm dlx) default to `enabled`
 * unless explicitly opted out; monorepo-dev installs default to
 * `disabled` unless explicitly opted in. Lives here rather than in
 * `handle-request.ts` because `/api/status` (status route group) and
 * `/api/info` both call it, and we want the routes/ tree to depend
 * only on sibling `daemon/*.ts` modules — never back on
 * `handle-request.ts` itself (which would create an import cycle).
 */
export function resolveAutoUpdateEnabled(config: DkgConfig): boolean {
  const standalone = resolveStandaloneInstall(config.autoUpdate?.source);
  return standalone
    ? config.autoUpdate?.enabled !== false
    : (config.autoUpdate?.enabled ?? false);
}
