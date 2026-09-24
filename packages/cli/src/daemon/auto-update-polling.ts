/**
 * Daemon auto-update polling setup.
 *
 * Lifecycle calls {@link startDaemonAutoUpdate} once with the daemon's config
 * and runtime, and stops it on shutdown. {@link resolveDaemonUpdateMode} turns
 * the config into one of the daemon's startup states, and
 * {@link startDaemonUpdatePolling} logs that state and starts its polling: one
 * rollout gate per daemon, with its deadline persisted under the DKG home (so a
 * restart mid-hold resumes it), behind one runCheck that fires shortly after
 * boot and then on the interval. Everything here is injectable, so the
 * lifecycle-to-polling boundary is unit-tested.
 */
import { join } from 'node:path';
import { formatAutoUpdateTagVerificationWarning, resolveAutoUpdateGitRefPlan } from '../auto-update-ref.js';
import {
  dkgDir,
  resolveAutoUpdateConfig,
  resolveAutoUpdateSource,
  resolveUpdatePreferences,
  type DkgConfig,
  type NetworkConfig,
  type ResolvedAutoUpdateConfig,
  type ResolvedUpdatePreferences,
} from '../config.js';
import { repoToFetchUrl } from './auto-update.js';
import { createPersistedHoldoffDeadline } from './auto-update-holdoff-deadline.js';
import { createUpdateHoldoffGate, type UpdateHoldoffGate } from './auto-update-holdoff-gate.js';
import { createFileUpdateHoldoffStore, UPDATE_HOLDOFF_FILE } from './auto-update-holdoff-store.js';
import { resolveUpdateJitterMs } from './auto-update-jitter.js';
import { createGitUpdateRunCheck, createNpmUpdateRunCheck } from './auto-update-runner.js';
import { DAEMON_EXIT_CODE_RESTART } from './manifest.js';
import {
  resolveAutoUpdatePollingMode,
  resolveStandaloneInstall,
  type LastUpdateCheck,
} from './state.js';

export interface DaemonUpdateHoldoffGateDeps {
  au: Pick<ResolvedAutoUpdateConfig, 'updateJitterMinutes' | 'checkIntervalMinutes'>;
  /** The DKG home; the rollout deadline is kept in `<dkgHome>/.update-holdoff.json`. */
  dkgHome: string;
  isShuttingDown: () => boolean;
  /** Toggle the daemon's user-visible "is updating" flag. */
  setUpdating: (updating: boolean) => void;
  log: (msg: string) => void;
}

/** Deterministic rng, clock and sleep for tests of the daemon gate. */
export interface UpdateGateSeams {
  rng?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The rollout gate both daemon auto-update modes (git and npm) use: the jitter
 * window from config/env, and the persisted deadline policy over
 * `<dkgHome>/.update-holdoff.json`, so a restart mid-hold resumes it. The
 * polling helpers below build their gates only through this function.
 */
export function createDaemonUpdateHoldoffGate(
  deps: DaemonUpdateHoldoffGateDeps,
  seams: UpdateGateSeams = {},
): UpdateHoldoffGate {
  return createUpdateHoldoffGate({
    deadline: createPersistedHoldoffDeadline({
      store: createFileUpdateHoldoffStore(join(deps.dkgHome, UPDATE_HOLDOFF_FILE)),
      jitterMs: resolveUpdateJitterMs(deps.au.updateJitterMinutes, deps.au.checkIntervalMinutes),
      log: deps.log,
      rng: seams.rng,
      now: seams.now,
    }),
    isShuttingDown: deps.isShuttingDown,
    setUpdating: deps.setUpdating,
    log: deps.log,
    sleep: seams.sleep,
  });
}

/** Delay before the first update check after boot. */
const FIRST_UPDATE_CHECK_DELAY_MS = 15_000;

/** The timers polling is scheduled on. Injectable for tests. */
export interface UpdatePollingTimers {
  setTimeout(fn: () => unknown, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const globalTimers: UpdatePollingTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  gateSeams?: UpdateGateSeams;
}

/** Running auto-update polling. `stop()` cancels the next check. */
export interface UpdatePolling {
  stop(): void;
}

/**
 * Run `runCheck` shortly after boot, then `intervalMs` after each check
 * finishes. This is the single flight: a check (the poll, its hold-off, the
 * re-check and the apply) always finishes before the next one is scheduled, so
 * two checks never race on the persisted deadline. A failed check is logged and
 * polling goes on.
 */
function schedulePolling(
  runCheck: () => Promise<void>,
  intervalMs: number,
  log: (msg: string) => void,
  timers: UpdatePollingTimers = globalTimers,
): UpdatePolling {
  let stopped = false;
  let next: unknown = null;
  const tick = async (): Promise<void> => {
    next = null;
    // A timer callback already queued when stop() runs must not start a check.
    if (stopped) return;
    try {
      await runCheck();
    } catch (err) {
      log(`Auto-update: update check failed (${errorMessage(err)}).`);
    }
    if (!stopped) next = timers.setTimeout(tick, intervalMs);
  };
  next = timers.setTimeout(tick, FIRST_UPDATE_CHECK_DELAY_MS);
  return {
    stop() {
      stopped = true;
      if (next !== null) timers.clearTimeout(next);
      next = null;
    },
  };
}

/**
 * Start git-mode auto-update polling: one persisted rollout gate behind a
 * runCheck that runs shortly after boot and then `checkIntervalMinutes` after
 * each check finishes.
 */
export function startGitUpdatePolling(
  au: ResolvedAutoUpdateConfig,
  deps: DaemonUpdatePollingDeps,
): UpdatePolling {
  const gate = createDaemonUpdateHoldoffGate({ ...deps, au }, deps.gateSeams);
  const runCheck = createGitUpdateRunCheck({
    gate,
    log: deps.log,
    lastUpdateCheck: deps.lastUpdateCheck,
    au,
    onRestart: deps.onRestart,
  });
  return schedulePolling(runCheck, au.checkIntervalMinutes * 60_000, deps.log, deps.timers);
}

/** Poll interval when auto-update is disabled and npm mode only checks versions. */
export const CHECK_ONLY_INTERVAL_MINUTES = 30;

export type NpmUpdatePollingOptions =
  /** Auto-apply: interval, channel and prerelease policy all come from `au`. */
  | { mode: 'npm-auto-apply'; au: ResolvedAutoUpdateConfig; nodeRole: 'edge' | 'core' }
  /** Auto-update disabled: check and record the latest version on the given
   *  policy every CHECK_ONLY_INTERVAL_MINUTES; no gate, nothing is installed. */
  | { mode: 'npm-check-only'; policy: ResolvedUpdatePreferences };

/** npm-mode counterpart to {@link startGitUpdatePolling}. */
export function startNpmUpdatePolling(
  opts: NpmUpdatePollingOptions,
  deps: DaemonUpdatePollingDeps,
): UpdatePolling {
  const common = { log: deps.log, lastUpdateCheck: deps.lastUpdateCheck };
  if (opts.mode === 'npm-check-only') {
    const runCheck = createNpmUpdateRunCheck({
      ...common,
      allowPrerelease: opts.policy.allowPrerelease,
      channel: opts.policy.channel,
      autoApply: null,
    });
    return schedulePolling(runCheck, CHECK_ONLY_INTERVAL_MINUTES * 60_000, deps.log, deps.timers);
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
  return schedulePolling(runCheck, au.checkIntervalMinutes * 60_000, deps.log, deps.timers);
}

/** The daemon's auto-update startup state, as resolved from its config. */
export type DaemonUpdateMode =
  | { mode: 'git'; au: ResolvedAutoUpdateConfig }
  | { mode: 'git-disabled' }
  | NpmUpdatePollingOptions
  /** A monorepo checkout never polls; it only says so when auto-update is enabled. */
  | { mode: 'monorepo'; autoUpdateEnabled: boolean };

/**
 * Resolve the daemon's auto-update state from its config, merged field by field
 * across ~/.dkg/config.json → network/<env>.json → project.json. With auto-apply
 * disabled, npm mode still checks versions, on the operator's local policy
 * before the network default, so a disabled node with a local channel /
 * allowPrerelease pin observes its own cohort.
 */
export function resolveDaemonUpdateMode(
  config: Pick<DkgConfig, 'autoUpdate' | 'nodeRole'>,
  network: Pick<NetworkConfig, 'autoUpdate'> | null | undefined,
): DaemonUpdateMode {
  const au = resolveAutoUpdateConfig(config, network);
  const source = au?.source ?? resolveAutoUpdateSource(config, network);
  switch (resolveAutoUpdatePollingMode(source, resolveStandaloneInstall(source))) {
    case 'git':
      return au ? { mode: 'git', au } : { mode: 'git-disabled' };
    case 'npm':
      return au
        ? { mode: 'npm-auto-apply', au, nodeRole: config.nodeRole ?? 'edge' }
        : { mode: 'npm-check-only', policy: resolveUpdatePreferences(config, network) };
    case 'monorepo':
      return { mode: 'monorepo', autoUpdateEnabled: au !== null };
  }
}

/** The per-mode starters. Injectable so tests can observe the dispatch. */
export interface UpdatePollingStarters {
  git: typeof startGitUpdatePolling;
  npm: typeof startNpmUpdatePolling;
}

const defaultStarters: UpdatePollingStarters = { git: startGitUpdatePolling, npm: startNpmUpdatePolling };

/**
 * Log the daemon's auto-update mode and start polling for it. Returns the
 * running polling, or null when nothing polls.
 */
export function startDaemonUpdatePolling(
  state: DaemonUpdateMode,
  deps: DaemonUpdatePollingDeps,
  starters: UpdatePollingStarters = defaultStarters,
): UpdatePolling | null {
  const { log } = deps;
  switch (state.mode) {
    case 'git': {
      const { au } = state;
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
    case 'git-disabled':
      log('Auto-update (git): disabled — autoUpdate.enabled is false.');
      return null;
    case 'npm-auto-apply':
      log(
        `Auto-update (npm): enabled${state.au.channel ? ` channel="${state.au.channel}"` : ''} (every ${state.au.checkIntervalMinutes}min)`,
      );
      return starters.npm(state, deps);
    case 'npm-check-only':
      log(
        `Auto-update (npm): disabled — version check only${state.policy.channel ? ` channel="${state.policy.channel}"` : ''} (every ${CHECK_ONLY_INTERVAL_MINUTES}min)`,
      );
      return starters.npm(state, deps);
    case 'monorepo':
      // Monorepo dev daemon with auto-update enabled in config — log
      // once at boot so contributors understand why polling is silent.
      if (state.autoUpdateEnabled) {
        log('Auto-update: skipped — monorepo checkout detected. Use `git pull && pnpm install && pnpm build` to update.');
      }
      return null;
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
}

/** What the daemon hands {@link startDaemonAutoUpdate}. */
export interface DaemonAutoUpdateContext {
  config: Pick<DkgConfig, 'autoUpdate' | 'nodeRole'>;
  network: Pick<NetworkConfig, 'autoUpdate'> | null | undefined;
  isShuttingDown: () => boolean;
  setUpdating: (updating: boolean) => void;
  log: (msg: string) => void;
  lastUpdateCheck: LastUpdateCheck;
  /** The daemon's shutdown; an update restarts through it with DAEMON_EXIT_CODE_RESTART. */
  shutdown: (exitCode: number) => Promise<void>;
}

/**
 * The daemon's auto-update handoff: resolve its mode from the config, start
 * polling with the deadline under the DKG home, and return the polling so
 * shutdown can stop it. `start` is injectable for tests.
 */
export function startDaemonAutoUpdate(
  daemon: DaemonAutoUpdateContext,
  start: typeof startDaemonUpdatePolling = startDaemonUpdatePolling,
): UpdatePolling {
  const polling = start(resolveDaemonUpdateMode(daemon.config, daemon.network), {
    dkgHome: dkgDir(),
    isShuttingDown: daemon.isShuttingDown,
    setUpdating: daemon.setUpdating,
    log: daemon.log,
    lastUpdateCheck: daemon.lastUpdateCheck,
    onRestart: () => daemon.shutdown(DAEMON_EXIT_CODE_RESTART),
  });
  return {
    stop() {
      polling?.stop();
    },
  };
}
