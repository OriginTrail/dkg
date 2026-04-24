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
  /** Set to `true` while a monorepo `git pull` / slot-swap is in flight. */
  isUpdating: boolean;
  /** Most recent "is this daemon up to date?" result; polled by `/status`. */
  lastUpdateCheck: {
    upToDate: boolean;
    checkedAt: number;
    latestCommit: string;
    latestVersion: string;
  };
  /** Memoised result of `isStandaloneInstall()` — null = not yet checked. */
  standaloneCache: boolean | null;
  /** CORS allowlist, set by `runDaemonInner`, read in `handleRequest`. */
  moduleCorsAllowed: CorsAllowlist;
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
  },
  standaloneCache: null,
  moduleCorsAllowed: '*',
  openClawBridgeHealth: null,
};

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
  if (daemonState.standaloneCache === null) daemonState.standaloneCache = isStandaloneInstall();
  return daemonState.standaloneCache
    ? config.autoUpdate?.enabled !== false
    : (config.autoUpdate?.enabled ?? false);
}
