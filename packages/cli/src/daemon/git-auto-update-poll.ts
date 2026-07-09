import type { ResolvedAutoUpdateConfig } from '../config.js';
import {
  checkForNewCommitWithStatus,
  performUpdateWithStatus,
  type CommitCheckStatus,
  type PerformUpdateOptions,
  type UpdateStatus,
} from './auto-update.js';
import { daemonState } from './state.js';
import { DAEMON_EXIT_CODE_RESTART } from './manifest.js';

export interface GitAutoUpdatePollDeps {
  checkForNewCommitWithStatus?: (
    au: ResolvedAutoUpdateConfig,
    log: (msg: string) => void,
  ) => Promise<CommitCheckStatus>;
  performUpdateWithStatus?: (
    au: ResolvedAutoUpdateConfig,
    log: (msg: string) => void,
    opts: Pick<PerformUpdateOptions, 'expectedCommit' | 'verifyTagSignature'>,
  ) => Promise<UpdateStatus>;
  shutdown?: (code: number) => Promise<void>;
  now?: () => number;
}

export async function runGitAutoUpdateCheck(
  au: ResolvedAutoUpdateConfig,
  log: (msg: string) => void,
  deps: GitAutoUpdatePollDeps = {},
): Promise<void> {
  const checkCommit = deps.checkForNewCommitWithStatus ?? checkForNewCommitWithStatus;
  const applyUpdate = deps.performUpdateWithStatus ?? performUpdateWithStatus;
  const shutdownDaemon = deps.shutdown ?? (async () => {
    throw new Error('git auto-update shutdown dependency was not provided');
  });
  const now = deps.now ?? Date.now;

  const gitStatus = await checkCommit(au, log);
  if (gitStatus.status === 'error') {
    log('Auto-update (git): update check failed.');
    return;
  }

  daemonState.lastUpdateCheck.checkedAt = now();
  daemonState.lastUpdateCheck.upToDate = gitStatus.status === 'up-to-date';
  daemonState.lastUpdateCheck.channelTargetMissing = false;
  daemonState.lastUpdateCheck.latestVersion = '';
  daemonState.lastUpdateCheck.latestCommit = gitStatus.commit ?? '';

  if (gitStatus.status !== 'available' || !gitStatus.commit) return;

  daemonState.isUpdating = true;
  let updateStatus: UpdateStatus = 'failed';
  try {
    updateStatus = await applyUpdate(au, log, {
      expectedCommit: gitStatus.commit,
      verifyTagSignature: au.verifyTagSignature,
    });
  } finally {
    daemonState.isUpdating = false;
  }

  if (updateStatus === 'updated') {
    log('Auto-update (git): update activated; exiting for supervised restart.');
    await shutdownDaemon(DAEMON_EXIT_CODE_RESTART);
    return;
  }
  if (updateStatus === 'up-to-date') {
    log('Auto-update (git): update skipped — node caught up before apply.');
    return;
  }
  log('Auto-update (git): update failed.');
}
