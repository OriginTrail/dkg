/**
 * Per-mode auto-update polling runners.
 *
 * These extract the git and npm `runCheck` bodies out of `runDaemonInner` so the
 * end-to-end polling path — detect an update, hold off (jitter), RE-VALIDATE the
 * target after the wait, and apply only the still-current one — is a focused,
 * testable unit rather than a closure buried in the 3.5k-line lifecycle file.
 *
 * The mode differences (which check, which installer, log wording) live here.
 * Each check result is mapped onto the gate's mode-neutral
 * {@link UpdateCheckOutcome}; the cross-cutting rollout state machine
 * (single-flight, hold-off, persisted deadline, shutdown abort, isUpdating) is
 * owned by the {@link UpdateHoldoffGate}; each runCheck binds its mode's rollout
 * step to the gate once. `auto-update-polling.ts` builds the
 * daemon's gate, these runChecks and their timers.
 */
import {
  checkForNpmVersionUpdate,
  deriveUpdateCheckState,
  performNpmUpdate,
  performNpmUpdateEdge,
  getCurrentCliVersion,
  checkForNewCommitWithStatus,
  performUpdateWithStatus,
  type CommitCheckStatus,
  type NpmVersionStatus,
} from './auto-update.js';
import type { UpdateCheckOutcome, UpdateHoldoffGate } from './auto-update-holdoff-gate.js';
import type { LastUpdateCheck } from './state.js';
import type { ResolvedAutoUpdateConfig } from '../config.js';

/** An npm version check as a gate outcome. `no-target` is definitive: the
 *  channel has nothing to install until a release is published to it. */
export function npmCheckOutcome(status: NpmVersionStatus): UpdateCheckOutcome {
  switch (status.status) {
    case 'available': return { status: 'available', target: status.version };
    case 'up-to-date':
    case 'no-target': return { status: 'none' };
    case 'error': return { status: 'failed' };
  }
}

/**
 * The mode-neutral tail of the "update available" log line, so the git and npm
 * paths word the three hold-off cases identically.
 */
export function describeUpdateHold(holdMs: number, resumed: boolean): string {
  const secs = Math.round(holdMs / 1000);
  if (!resumed) return `holding ${secs}s before applying (rollout jitter — spreads fleet restarts).`;
  if (holdMs <= 0) return 'rollout hold-off deadline carried over from before a restart has passed — applying now.';
  return `resuming the rollout hold-off carried over from before a restart — ${secs}s left before applying.`;
}

/** A git ref check as a gate outcome. */
export function gitCheckOutcome(status: CommitCheckStatus): UpdateCheckOutcome {
  if (status.status === 'up-to-date') return { status: 'none' };
  if (status.status === 'available' && status.commit) return { status: 'available', target: status.commit };
  return { status: 'failed' };
}

/**
 * Re-check the npm channel target after the hold-off. Private to the runner — an
 * adapter over the already-public `checkForNpmVersionUpdate`, not part of the
 * daemon's API.
 */
export async function resolveCurrentNpmTarget(
  log: (msg: string) => void,
  allowPrerelease: boolean,
  channel?: string,
): Promise<UpdateCheckOutcome> {
  return npmCheckOutcome(await checkForNpmVersionUpdate(log, allowPrerelease, channel));
}

/** Git counterpart to {@link resolveCurrentNpmTarget}: re-check the ref tip. Runner-private. */
export async function resolveCurrentGitTarget(
  au: ResolvedAutoUpdateConfig,
  log: (msg: string) => void,
): Promise<UpdateCheckOutcome> {
  return gitCheckOutcome(await checkForNewCommitWithStatus(au, log));
}

/** What npm mode needs to install an available version. */
export interface NpmAutoApply {
  gate: UpdateHoldoffGate;
  nodeRole: 'edge' | 'core';
  /** Trigger the supervised restart after a successful install. */
  onRestart: () => Promise<void>;
}

export interface NpmUpdateRunCheckDeps {
  log: (msg: string) => void;
  lastUpdateCheck: LastUpdateCheck;
  allowPrerelease: boolean;
  channel?: string;
  /** null = version-check-only (auto-apply disabled): detect + record, never apply. */
  autoApply: NpmAutoApply | null;
}

/**
 * Build the npm-mode polling `runCheck`. Always refreshes `lastUpdateCheck` (so
 * `/api/status` is current even when auto-apply is off); with auto-apply, hands
 * the check's outcome to the gate — including the post-hold-off re-check that
 * skips a version withdrawn during the wait.
 */
export function createNpmUpdateRunCheck(deps: NpmUpdateRunCheckDeps): () => Promise<void> {
  const { autoApply } = deps;
  const poll = autoApply?.gate.bindRollout<string>({
    onHold: (version, holdMs, resumed) =>
      deps.log(`Auto-update (npm): version ${version} available; ${describeUpdateHold(holdMs, resumed)}`),
    shutdownMessage:
      'Auto-update (npm): hold-off aborted — daemon shutting down; deferring to next boot.',
    supersededMessage:
      'Auto-update (npm): target superseded during hold-off (version withdrawn or node caught up); skipping — next poll re-evaluates.',
    recheckFailedMessage:
      'Auto-update (npm): re-check after the hold-off failed; not applying — the rollout deadline is kept and the next poll retries.',
    // Re-resolve the channel target AFTER the hold-off so a version withdrawn /
    // rolled back during the wait is not installed; a newer one is applied.
    revalidate: () => resolveCurrentNpmTarget(deps.log, deps.allowPrerelease, deps.channel),
    apply: async (version) => {
      // OT-RFC-41 Bundle B1b: Edge → npm install -g, Core → slot install.
      const status = autoApply.nodeRole === 'edge'
        ? await performNpmUpdateEdge(version, getCurrentCliVersion(), deps.log)
        : await performNpmUpdate(version, deps.log);
      if (status === 'updated') {
        deps.log('Auto-update: update activated; exiting for supervised restart.');
        await autoApply.onRestart();
      }
    },
  });

  return async () => {
    const npmStatus = await checkForNpmVersionUpdate(deps.log, deps.allowPrerelease, deps.channel);
    const derived = deriveUpdateCheckState(npmStatus);
    if (derived) {
      deps.lastUpdateCheck.checkedAt = Date.now();
      deps.lastUpdateCheck.upToDate = derived.upToDate;
      deps.lastUpdateCheck.channelTargetMissing = derived.channelTargetMissing;
      // Always write (including '') so a prior "available" version does not
      // linger after the target disappears or the node catches up.
      deps.lastUpdateCheck.latestVersion = derived.latestVersion;
      if (npmStatus.status === 'no-target')
        deps.log(
          `Auto-update (npm): WARNING — channel "${npmStatus.channel}" has no acceptable target (tag missing or rejected by allowPrerelease); node will not update until it is published.`,
        );
    }
    if (!poll) return; // version check only — no auto-apply when polling disabled
    await poll(npmCheckOutcome(npmStatus));
  };
}

export interface GitUpdateRunCheckDeps {
  gate: UpdateHoldoffGate;
  log: (msg: string) => void;
  lastUpdateCheck: LastUpdateCheck;
  au: ResolvedAutoUpdateConfig;
  onRestart: () => Promise<void>;
}

/**
 * Build the git-mode polling `runCheck`. Detects the remote ref tip, refreshes
 * `lastUpdateCheck`, and hands the outcome to the gate — which re-resolves the
 * ref AFTER the hold-off so the CURRENT tip is applied, not the commit captured
 * before the (possibly long) wait.
 */
export function createGitUpdateRunCheck(deps: GitUpdateRunCheckDeps): () => Promise<void> {
  const poll = deps.gate.bindRollout<string>({
    onHold: (commit, holdMs, resumed) =>
      deps.log(
        `Auto-update (git): new commit ${commit.slice(0, 8)} available; ${describeUpdateHold(holdMs, resumed)}`,
      ),
    shutdownMessage:
      'Auto-update (git): hold-off aborted — daemon shutting down; deferring to next boot.',
    supersededMessage:
      'Auto-update (git): target superseded during hold-off (ref moved or node caught up); skipping — next poll re-evaluates.',
    recheckFailedMessage:
      'Auto-update (git): re-check after the hold-off failed; not applying — the rollout deadline is kept and the next poll retries.',
    revalidate: () => resolveCurrentGitTarget(deps.au, deps.log),
    apply: async (commit) => {
      const updateStatus = await performUpdateWithStatus(deps.au, deps.log, {
        expectedCommit: commit,
      });
      if (updateStatus === 'updated') {
        deps.log('Auto-update (git): update activated; exiting for supervised restart.');
        await deps.onRestart();
        return;
      }
      if (updateStatus === 'up-to-date') {
        deps.log('Auto-update (git): update skipped — node caught up before apply.');
        return;
      }
      deps.log('Auto-update (git): update failed.');
    },
  });

  return async () => {
    const gitStatus = await checkForNewCommitWithStatus(deps.au, deps.log);
    if (gitStatus.status === 'error') {
      deps.log('Auto-update (git): update check failed.');
      return;
    }

    deps.lastUpdateCheck.checkedAt = Date.now();
    deps.lastUpdateCheck.upToDate = gitStatus.status === 'up-to-date';
    deps.lastUpdateCheck.channelTargetMissing = false;
    deps.lastUpdateCheck.latestVersion = '';
    deps.lastUpdateCheck.latestCommit = gitStatus.commit ?? '';

    await poll(gitCheckOutcome(gitStatus));
  };
}
