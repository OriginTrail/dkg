/**
 * Daemon auto-update polling setup.
 *
 * Lifecycle hands the resolved polling mode and config to
 * {@link startDaemonUpdatePolling}, which picks the mode, logs it, and starts
 * polling: one rollout gate per daemon, with its deadline persisted under the
 * DKG home (so a restart mid-hold resumes it), behind one runCheck that fires
 * shortly after boot and then on the interval. Everything here is injectable,
 * so the lifecycle-to-polling boundary is unit-tested.
 */
import { join } from 'node:path';
import { formatAutoUpdateTagVerificationWarning, resolveAutoUpdateGitRefPlan } from '../auto-update-ref.js';
import type { ResolvedAutoUpdateConfig, ResolvedUpdatePreferences } from '../config.js';
import { repoToFetchUrl } from './auto-update.js';
import { createFileUpdateHoldoffStore, UPDATE_HOLDOFF_FILE } from './auto-update-holdoff-store.js';
import {
  createUpdateHoldoffGate,
  resolveUpdateJitterMs,
  type UpdateHoldoffGate,
  type UpdateHoldoffGateConfig,
} from './auto-update-jitter.js';
import { createGitUpdateRunCheck, createNpmUpdateRunCheck } from './auto-update-runner.js';
import type { AutoUpdatePollingMode, LastUpdateCheck } from './state.js';

export interface DaemonUpdateHoldoffGateDeps {
  au: Pick<ResolvedAutoUpdateConfig, 'updateJitterMinutes' | 'checkIntervalMinutes'>;
  /** The DKG home; the rollout deadline is kept in `<dkgHome>/.update-holdoff.json`. */
  dkgHome: string;
  isShuttingDown: () => boolean;
  /** Toggle the daemon's user-visible "is updating" flag. */
  setUpdating: (updating: boolean) => void;
  log: (msg: string) => void;
}

/**
 * The rollout gate both daemon auto-update modes (git and npm) use: the jitter
 * window from config/env, and the deadline persisted under the DKG home so a
 * restart mid-hold resumes it. The polling helpers below build their gates only
 * through this function. `seams` is for tests (deterministic rng, clock and sleep).
 */
export function createDaemonUpdateHoldoffGate(
  deps: DaemonUpdateHoldoffGateDeps,
  seams: Pick<UpdateHoldoffGateConfig, 'rng' | 'now' | 'sleep'> = {},
): UpdateHoldoffGate {
  return createUpdateHoldoffGate({
    jitterMs: resolveUpdateJitterMs(deps.au.updateJitterMinutes, deps.au.checkIntervalMinutes),
    isShuttingDown: deps.isShuttingDown,
    setUpdating: deps.setUpdating,
    log: deps.log,
    store: createFileUpdateHoldoffStore(join(deps.dkgHome, UPDATE_HOLDOFF_FILE)),
    ...seams,
  });
}

/** Delay before the first update check after boot. */
const FIRST_UPDATE_CHECK_DELAY_MS = 15_000;

/** The timers polling is scheduled on. Injectable for tests. */
export interface UpdatePollingTimers {
  setTimeout(fn: () => unknown, ms: number): unknown;
  setInterval(fn: () => unknown, ms: number): ReturnType<typeof setInterval>;
}

const globalTimers: UpdatePollingTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  setInterval: (fn, ms) => setInterval(fn, ms),
};

/** What the daemon hands both polling helpers. */
export interface DaemonUpdatePollingDeps {
  /** The DKG home; the rollout deadline is kept in `<dkgHome>/.update-holdoff.json`. */
  dkgHome: string;
  isShuttingDown: () => boolean;
  setUpdating: (updating: boolean) => void;
  log: (msg: string) => void;
  lastUpdateCheck: LastUpdateCheck;
  /** Trigger the supervised restart after a successful install. */
  onRestart: () => Promise<void>;
  /** Test seams. */
  timers?: UpdatePollingTimers;
  gateSeams?: Pick<UpdateHoldoffGateConfig, 'rng' | 'now' | 'sleep'>;
}

function schedulePolling(
  runCheck: () => Promise<void>,
  intervalMs: number,
  timers: UpdatePollingTimers = globalTimers,
): ReturnType<typeof setInterval> {
  timers.setTimeout(runCheck, FIRST_UPDATE_CHECK_DELAY_MS);
  return timers.setInterval(runCheck, intervalMs);
}

/**
 * Start git-mode auto-update polling: one persisted rollout gate (created once,
 * so single-flight holds across ticks) behind a runCheck that fires shortly
 * after boot and then every `checkIntervalMinutes`. Returns the interval handle
 * for shutdown.
 */
export function startGitUpdatePolling(
  au: ResolvedAutoUpdateConfig,
  deps: DaemonUpdatePollingDeps,
): ReturnType<typeof setInterval> {
  const gate = createDaemonUpdateHoldoffGate({ ...deps, au }, deps.gateSeams);
  const runCheck = createGitUpdateRunCheck({
    gate,
    log: deps.log,
    lastUpdateCheck: deps.lastUpdateCheck,
    au,
    onRestart: deps.onRestart,
  });
  return schedulePolling(runCheck, au.checkIntervalMinutes * 60_000, deps.timers);
}

/** Poll interval when auto-update is disabled and npm mode only checks versions. */
export const CHECK_ONLY_INTERVAL_MINUTES = 30;

export type NpmUpdatePollingOptions =
  /** Auto-apply: interval, channel and prerelease policy all come from `au`. */
  | { mode: 'auto-apply'; au: ResolvedAutoUpdateConfig; nodeRole: 'edge' | 'core' }
  /** Auto-update disabled: check and record the latest version on the given
   *  policy every CHECK_ONLY_INTERVAL_MINUTES; no gate, nothing is installed. */
  | { mode: 'check-only'; policy: ResolvedUpdatePreferences };

/** npm-mode counterpart to {@link startGitUpdatePolling}. */
export function startNpmUpdatePolling(
  opts: NpmUpdatePollingOptions,
  deps: DaemonUpdatePollingDeps,
): ReturnType<typeof setInterval> {
  const common = { log: deps.log, lastUpdateCheck: deps.lastUpdateCheck };
  if (opts.mode === 'check-only') {
    const runCheck = createNpmUpdateRunCheck({
      ...common,
      allowPrerelease: opts.policy.allowPrerelease,
      channel: opts.policy.channel,
      autoApply: null,
    });
    return schedulePolling(runCheck, CHECK_ONLY_INTERVAL_MINUTES * 60_000, deps.timers);
  }
  const { au } = opts;
  const runCheck = createNpmUpdateRunCheck({
    ...common,
    allowPrerelease: au.allowPrerelease ?? true,
    channel: au.channel,
    autoApply: {
      gate: createDaemonUpdateHoldoffGate({ ...deps, au }, deps.gateSeams),
      nodeRole: opts.nodeRole,
      onRestart: deps.onRestart,
    },
  });
  return schedulePolling(runCheck, au.checkIntervalMinutes * 60_000, deps.timers);
}

/** What lifecycle resolved about auto-update for this daemon. */
export interface DaemonUpdatePollingSelection {
  pollingMode: AutoUpdatePollingMode;
  /** Resolved auto-update config; null when auto-update is disabled. */
  au: ResolvedAutoUpdateConfig | null;
  /** From `resolveUpdatePreferences`: the npm check policy when auto-apply is
   *  disabled (`au` null). It follows the operator's local config before the
   *  network default, so a disabled node with a local channel / allowPrerelease
   *  pin observes its own cohort. */
  preferences: ResolvedUpdatePreferences;
  nodeRole: 'edge' | 'core';
}

/** The per-mode starters. Injectable so tests can observe the selection. */
export interface UpdatePollingStarters {
  git: typeof startGitUpdatePolling;
  npm: typeof startNpmUpdatePolling;
}

const defaultStarters: UpdatePollingStarters = { git: startGitUpdatePolling, npm: startNpmUpdatePolling };

/**
 * Pick the auto-update mode for this daemon, log it, and start polling. Returns
 * the interval handle (cleared on shutdown), or null when nothing polls.
 * The resolver merges repo/branch/interval field-by-field across
 * ~/.dkg/config.json → network/<env>.json → project.json, so `au` already
 * carries the shipped defaults.
 */
export function startDaemonUpdatePolling(
  selection: DaemonUpdatePollingSelection,
  deps: DaemonUpdatePollingDeps,
  starters: UpdatePollingStarters = defaultStarters,
): ReturnType<typeof setInterval> | null {
  const { pollingMode, au } = selection;
  const { log } = deps;

  if (pollingMode === 'git' && au) {
    let watchedRef = '';
    let watchedRepo = '';
    let watchedRefPlan: ReturnType<typeof resolveAutoUpdateGitRefPlan> | null = null;
    try {
      watchedRefPlan = resolveAutoUpdateGitRefPlan(au);
      watchedRef = watchedRefPlan.ref;
      watchedRepo = repoToFetchUrl(au.repo);
    } catch (err: any) {
      log(
        `Auto-update (git): invalid config — ${err?.message ?? String(err)}. ` +
          'Git polling disabled until config is fixed and the daemon is restarted.',
      );
    }
    if (!watchedRef || !watchedRepo) return null;

    log(
      `Auto-update (git): enabled source="git"; watching repo="${watchedRepo}" ref="${watchedRef}" ` +
        `(every ${au.checkIntervalMinutes}min). NPM/dist-tag updates remain recommended; git mode is advanced/experimental.`,
    );
    const verificationWarning = watchedRefPlan ? formatAutoUpdateTagVerificationWarning(watchedRefPlan) : null;
    if (verificationWarning) log(verificationWarning);
    return starters.git(au, deps);
  }

  if (pollingMode === 'git') {
    log('Auto-update (git): disabled — autoUpdate.enabled is false.');
    return null;
  }

  if (pollingMode === 'npm') {
    const options: NpmUpdatePollingOptions = au
      ? { mode: 'auto-apply', au, nodeRole: selection.nodeRole }
      : { mode: 'check-only', policy: selection.preferences };
    const channel = au ? au.channel : selection.preferences.channel;
    const everyMinutes = au ? au.checkIntervalMinutes : CHECK_ONLY_INTERVAL_MINUTES;
    log(
      `Auto-update (npm): ${au ? 'enabled' : 'disabled — version check only'}${channel ? ` channel="${channel}"` : ''} (every ${everyMinutes}min)`,
    );
    return starters.npm(options, deps);
  }

  if (au?.enabled) {
    // Monorepo dev daemon with auto-update enabled in config — log
    // once at boot so contributors understand why polling is silent.
    log('Auto-update: skipped — monorepo checkout detected. Use `git pull && pnpm install && pnpm build` to update.');
  }
  return null;
}
