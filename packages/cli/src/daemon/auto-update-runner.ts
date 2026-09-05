/**
 * Per-mode auto-update polling runners.
 *
 * These extract the git and npm `runCheck` bodies out of `runDaemonInner` so the
 * end-to-end polling path — detect an update, hold off (jitter), RE-VALIDATE the
 * target after the wait, and apply only the still-current one — is a focused,
 * testable unit rather than a closure buried in the 3.5k-line lifecycle file.
 *
 * The mode differences (which check, which installer, log wording) live here;
 * the cross-cutting rollout state machine (single-flight, hold-off, shutdown
 * abort, isUpdating) is owned by the {@link UpdateHoldoffGate}. Lifecycle wires
 * these into setInterval and provides the gate + a restart callback.
 */
import {
  checkForNpmVersionUpdate,
  deriveUpdateCheckState,
  performNpmUpdate,
  performNpmUpdateEdge,
  getCurrentCliVersion,
  checkForNewCommitWithStatus,
  performUpdateWithStatus,
} from './auto-update.js';
import type { UpdateHoldoffGate } from './auto-update-jitter.js';
import type { LastUpdateCheck } from './state.js';
import type { ResolvedAutoUpdateConfig } from '../config.js';

/**
 * Re-resolve the CURRENT npm channel target after the hold-off, mapping to the
 * version to apply or null when there is nothing to apply now (withdrawn /
 * rolled back / caught up). Private to the runner — a one-line adapter over the
 * already-public `checkForNpmVersionUpdate`, not part of the daemon's API.
 */
export async function resolveCurrentNpmTarget(
  log: (msg: string) => void,
  allowPrerelease: boolean,
  channel?: string,
): Promise<string | null> {
  const status = await checkForNpmVersionUpdate(log, allowPrerelease, channel);
  return status.status === 'available' ? status.version : null;
}

/** Git counterpart to {@link resolveCurrentNpmTarget}: the current ref tip, or
 *  null when it no longer points ahead of the running commit. Runner-private. */
export async function resolveCurrentGitTarget(
  au: ResolvedAutoUpdateConfig,
  log: (msg: string) => void,
): Promise<string | null> {
  const status = await checkForNewCommitWithStatus(au, log);
  return status.status === 'available' && status.commit ? status.commit : null;
}

export interface NpmUpdateRunCheckDeps {
  /** null = version-check-only (auto-apply disabled): detect + record, never apply. */
  gate: UpdateHoldoffGate | null;
  log: (msg: string) => void;
  lastUpdateCheck: LastUpdateCheck;
  allowPrerelease: boolean;
  channel?: string;
  nodeRole: 'edge' | 'core';
  /** Trigger the supervised restart after a successful install. */
  onRestart: () => Promise<void>;
}

/**
 * Build the npm-mode polling `runCheck`. Always refreshes `lastUpdateCheck` (so
 * `/api/status` is current even when auto-apply is off); when a gate is present
 * and an update is available, routes the apply through it — including the
 * post-hold-off revalidation that skips a version withdrawn during the wait.
 */
export function createNpmUpdateRunCheck(deps: NpmUpdateRunCheckDeps): () => Promise<void> {
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
    if (npmStatus.status !== 'available') return;
    if (!deps.gate) return; // version check only — no auto-apply when polling disabled
    const detectedVersion = npmStatus.version;

    await deps.gate.run<string>({
      onHold: (holdMs) =>
        deps.log(
          `Auto-update (npm): version ${detectedVersion} available; ` +
            `holding ${Math.round(holdMs / 1000)}s before applying (rollout jitter — spreads fleet restarts).`,
        ),
      shutdownMessage:
        'Auto-update (npm): hold-off aborted — daemon shutting down; deferring to next boot.',
      supersededMessage:
        'Auto-update (npm): target superseded during hold-off (version withdrawn or node caught up); skipping — next poll re-evaluates.',
      // Re-resolve the channel target AFTER the hold-off so a version withdrawn /
      // rolled back during the wait is not installed; a newer one is applied.
      revalidate: () => resolveCurrentNpmTarget(deps.log, deps.allowPrerelease, deps.channel),
      apply: async (version) => {
        // OT-RFC-41 Bundle B1b: Edge → npm install -g, Core → slot install.
        const status = deps.nodeRole === 'edge'
          ? await performNpmUpdateEdge(version, getCurrentCliVersion(), deps.log)
          : await performNpmUpdate(version, deps.log);
        if (status === 'updated') {
          deps.log('Auto-update: update activated; exiting for supervised restart.');
          await deps.onRestart();
        }
      },
    });
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
 * `lastUpdateCheck`, and on an available commit routes the apply through the
 * gate — re-resolving the ref AFTER the hold-off so the CURRENT tip is applied,
 * not the commit captured before the (possibly long) wait.
 */
export function createGitUpdateRunCheck(deps: GitUpdateRunCheckDeps): () => Promise<void> {
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

    if (gitStatus.status !== 'available' || !gitStatus.commit) return;
    const detectedCommit = gitStatus.commit;

    await deps.gate.run<string>({
      onHold: (holdMs) =>
        deps.log(
          `Auto-update (git): new commit ${detectedCommit.slice(0, 8)} available; ` +
            `holding ${Math.round(holdMs / 1000)}s before applying (rollout jitter — spreads fleet restarts).`,
        ),
      shutdownMessage:
        'Auto-update (git): hold-off aborted — daemon shutting down; deferring to next boot.',
      supersededMessage:
        'Auto-update (git): target superseded during hold-off (ref moved or node caught up); skipping — next poll re-evaluates.',
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
  };
}
