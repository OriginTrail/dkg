import type { DkgConfig } from '../config.js';

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
 * starts/stops every signal through one adapter, persists config, rolls failed
 * runtime enables back durably, and drains pending transitions on shutdown.
 * Logger sink attachment remains the log controller's separate responsibility.
 */
export function createTelemetryRuntime(opts: {
  config: DkgConfig;
  persist(config: DkgConfig): Promise<void>;
  signals: TelemetrySignalAdapter;
  onBootStartFailure?(error: string): void;
}): TelemetryRuntime {
  let transitionTail: Promise<void> = Promise.resolve();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  const setConfiguredEnabled = (enabled: boolean): void => {
    opts.config.telemetry = { ...opts.config.telemetry, enabled };
  };
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const transition = transitionTail.then(work, work);
    transitionTail = transition.then(() => undefined, () => undefined);
    return transition;
  };
  const rollbackDisabled = async (): Promise<void> => {
    await opts.signals.stop().catch(() => undefined);
    setConfiguredEnabled(false);
    await opts.persist(opts.config);
  };
  const applyEnabled = async (
    enabled: boolean,
  ): Promise<TelemetryTransitionResult> => {
    if (!enabled) {
      await opts.signals.stop();
      setConfiguredEnabled(false);
      await opts.persist(opts.config);
      return { ok: true };
    }

    // Raise the in-memory gate before any signal starts. Disable lowers it only
    // after every signal stops, so false never coexists with active export.
    setConfiguredEnabled(true);
    let result: TelemetryTransitionResult;
    try {
      result = await opts.signals.start();
    } catch (error) {
      await rollbackDisabled();
      throw error;
    }
    if (!result.ok) {
      await rollbackDisabled();
      return result;
    }
    try {
      await opts.persist(opts.config);
    } catch (error) {
      await rollbackDisabled().catch(() => undefined);
      throw error;
    }
    return { ok: true };
  };

  return {
    isEnabled: () => opts.config.telemetry?.enabled ?? false,
    startConfiguredBestEffort() {
      return enqueue(async () => {
        if (!opts.config.telemetry?.enabled) return;
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
