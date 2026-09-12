import { mutableConfigSnapshot, type DkgConfigStore } from '../daemon-config-store.js';

export type TelemetryTransitionResult =
  | { ok: true }
  | { ok: false; error: string };

export interface TelemetrySignalAdapter {
  start(): Promise<TelemetryTransitionResult>;
  stop(): Promise<void>;
}

export interface TelemetryRuntime {
  isEnabled(): boolean;
  startConfiguredBestEffort(): Promise<void>;
  setEnabled(enabled: boolean): Promise<TelemetryTransitionResult>;
  shutdown(): Promise<void>;
}

export interface TelemetrySettings {
  getTelemetryEnabled(): boolean;
  setTelemetryEnabled(enabled: boolean): Promise<TelemetryTransitionResult>;
}

/**
 * Keep the settings API wired to the same serialized runtime used at boot and
 * shutdown. Exporting this small seam lets the runtime-enable path be tested
 * with the production signal composition instead of a generic signal stub.
 */
export function createTelemetrySettings(
  runtime: TelemetryRuntime,
): TelemetrySettings {
  return {
    getTelemetryEnabled: () => runtime.isEnabled(),
    setTelemetryEnabled: (enabled) => runtime.setEnabled(enabled),
  };
}

/**
 * Canonical owner of the telemetry master gate. It serializes transitions,
 * starts/stops every signal through one adapter and commits through the daemon
 * configuration owner, which compensates failed activation and restores disk.
 * Pending transitions drain before shutdown.
 * Logger sink attachment remains the log controller's separate responsibility.
 */
export function createTelemetryRuntime(opts: {
  configStore: DkgConfigStore;
  signals: TelemetrySignalAdapter;
  onBootStartFailure?(error: string): void;
}): TelemetryRuntime {
  let transitionTail: Promise<void> = Promise.resolve();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let runtimeEnabled = opts.configStore.current.telemetry?.enabled ?? false;

  class TransitionRejected extends Error {}
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const transition = transitionTail.then(work, work);
    transitionTail = transition.then(() => undefined, () => undefined);
    return transition;
  };
  const startSignals = async (): Promise<void> => {
    const result = await opts.signals.start();
    if (!result.ok) throw new TransitionRejected(result.error);
  };
  const applyEnabled = async (enabled: boolean): Promise<TelemetryTransitionResult> => {
    try {
      await opts.configStore.update(current => {
        const next = mutableConfigSnapshot(current);
        next.telemetry = { ...next.telemetry, enabled };
        return next;
      }, (_next, previous) => ({
        apply: async () => {
          // Never lower the live gate while exporters are still active.
          if (enabled) {
            runtimeEnabled = true;
            await startSignals();
          } else {
            await opts.signals.stop();
            runtimeEnabled = false;
          }
        },
        rollback: async () => {
          await opts.signals.stop();
          const wasEnabled = previous.telemetry?.enabled ?? false;
          if (wasEnabled) {
            runtimeEnabled = true;
            await startSignals();
          } else {
            runtimeEnabled = false;
          }
        },
      }));
      return { ok: true };
    } catch (error) {
      if (error instanceof TransitionRejected) return { ok: false, error: error.message };
      throw error;
    }
  };

  return {
    isEnabled: () => runtimeEnabled,
    startConfiguredBestEffort() {
      return enqueue(async () => {
        if (!runtimeEnabled) return;
        try {
          const result = await opts.signals.start();
          if (!result.ok) opts.onBootStartFailure?.(result.error);
        } catch (error) {
          opts.onBootStartFailure?.(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    },
    setEnabled(enabled) {
      if (shuttingDown) {
        return Promise.resolve({
          ok: false,
          error: 'Telemetry runtime is shutting down',
        });
      }
      return enqueue(() => applyEnabled(enabled));
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      shutdownPromise = enqueue(() => opts.signals.stop());
      return shutdownPromise;
    },
  };
}
