/**
 * Starting queue retention in the daemon (OT-RFC-73 P10b): the registry of the queues' sweep factories and the one place a retention timer is created.
 *
 * `startRetention` is called once, by the daemon's admission instance (lifecycle.ts, `runtime: 'daemon-admission'`), after the API is listening. It
 *  - does nothing at all when every queue's mode is `off`, the default: no factory runs, the agent and the store are not touched, no timer exists;
 *  - refuses, with a clear error, to start anything in any other runtime when a mode is not `off`. Between the verify and the delete of a retention hold the only
 *    exclusion is the in-process queue lock, so a second process that writes the share control graph (a standalone agent or library use, a worker or runner process,
 *    the offline CLI inspector, a script) is not excluded. None of those runtimes calls this function; a test pins that, and this check makes a future caller that
 *    does fail at once instead of deleting;
 *  - builds one sweep per queue whose mode is not `off` from the registered factories and hands them to the one timer (retention-timer.ts). A factory that fails
 *    does not stop the daemon: the failure is logged as an error and that queue runs no retention.
 *
 * P11 registers the publisher's sweep by adding its factory to `RETENTION_SWEEP_FACTORIES`; neither config.ts nor lifecycle.ts changes. Until then a publisher mode
 * other than `off` has no effect, and the starter says so in the log.
 */
import type { ResolvedRetentionConfig } from '../retention-config.js';
import { shareRetentionSweepFactory } from './retention-share-sweep.js';
import {
  startRetentionTimer,
  type RetentionAgent, type RetentionQueueName, type RetentionSweep, type RetentionSweepFactory, type RetentionUsageView,
} from './retention-timer.js';

/** Where retention may run. Only the daemon's admission instance is accepted; the others are named so a refusal can say which runtime asked. */
export type RetentionRuntime = 'daemon-admission' | 'standalone-agent' | 'worker-process' | 'publisher-runner' | 'offline-inspector' | 'script';

/** Every queue with a retention section; the registry below holds the factories that exist. */
export const RETENTION_QUEUES: readonly RetentionQueueName[] = ['share', 'publisher'];

/** One factory per queue. The publisher's (P11) is added here. */
export const RETENTION_SWEEP_FACTORIES: readonly RetentionSweepFactory[] = [shareRetentionSweepFactory];

/** Thrown when a runtime other than the daemon's admission instance asks to start retention with a queue mode other than `off`. Nothing was created. */
export class RetentionRuntimeRefusedError extends Error {
  readonly code = 'RETENTION_RUNTIME_REFUSED';
  constructor(readonly runtime: string, readonly queues: readonly RetentionQueueName[]) {
    super(`queue retention (${queues.map(queue => `queueRetention.${queue}.mode`).join(', ')} is not "off") cannot start in the ${runtime} runtime: it runs only in the daemon's admission instance. `
      + 'Between verifying a job and deleting it the only exclusion is that instance\'s own queue lock, so a second process that writes the queue graph is not excluded. '
      + 'Keep the mode "off" for this runtime and run retention in the daemon');
    this.name = 'RetentionRuntimeRefusedError';
  }
}

export interface RetentionHandle {
  /** The running sweeps' figures for the periodic line; empty when nothing runs. */
  usage(): readonly RetentionUsageView[];
  /** Stop ticking and wait for a running batch (bounded). Never rejects. */
  stop(): Promise<void>;
}

const INERT: RetentionHandle = Object.freeze({ usage: () => [], stop: async () => undefined });

export interface RetentionStartInput {
  readonly runtime: RetentionRuntime;
  readonly settings: ResolvedRetentionConfig;
  readonly agent: RetentionAgent;
  readonly log: (message: string) => void;
  /** Tests only: the registry defaults to `RETENTION_SWEEP_FACTORIES`. */
  readonly factories?: readonly RetentionSweepFactory[];
}

export function startRetention(input: RetentionStartInput): RetentionHandle {
  const { runtime, settings, agent, log, factories = RETENTION_SWEEP_FACTORIES } = input;
  const active = RETENTION_QUEUES.filter(queue => settings[queue].mode !== 'off');
  if (active.length === 0) return INERT;
  if (runtime !== 'daemon-admission') throw new RetentionRuntimeRefusedError(runtime, active);

  const sweeps: RetentionSweep[] = [];
  for (const queue of active) {
    const factory = factories.find(candidate => candidate.queue === queue);
    if (!factory) {
      log(`[warn] [retention] queueRetention.${queue}.mode is "${settings[queue].mode}" but this build has no ${queue} retention sweep: nothing will run for that queue`);
      continue;
    }
    try {
      const sweep = factory.create({ agent, settings, log });
      if (sweep) sweeps.push(sweep);
    } catch (cause) {
      log(`[error] [retention] ${queue} retention (mode=${settings[queue].mode}) was NOT started: ${String((cause as Error)?.message ?? cause).slice(0, 300)}. The daemon keeps running with ${queue} retention off.`);
    }
  }
  if (sweeps.length === 0) return INERT;
  for (const sweep of sweeps) {
    log(sweep.mode === 'report'
      ? `[retention] ${sweep.queue} retention started in report mode (first tick in ${sweep.intervalMs} ms, then every ${sweep.intervalMs} ms): it judges and counts, and deletes nothing. See docs/promote-queue-operations.md`
      : `[warn] [retention] ${sweep.queue} retention started in DELETE mode (first tick in ${sweep.intervalMs} ms, then every ${sweep.intervalMs} ms): finished jobs older than their window are removed and cannot be restored. `
        + 'Delete mode belongs only on a node that has passed the delete gate in docs/promote-queue-operations.md');
  }
  const timer = startRetentionTimer(sweeps, log);
  return { usage: () => timer.usage(), stop: () => timer.stop() };
}
