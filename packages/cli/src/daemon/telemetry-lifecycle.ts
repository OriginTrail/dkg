import type { TelemetryInitConfig } from '@origintrail-official/dkg-node-ui';
import type { DkgConfig } from '../config.js';
import {
  isUnknownLogExporter,
  resolveLogExporterMode,
  resolveOtelSignals,
  type ActiveLogExporterMode,
} from '../telemetry-config.js';
import type {
  TelemetrySignalAdapter,
  TelemetryTransitionResult,
} from './telemetry-runtime.js';

export interface DaemonTelemetryLifecycleOptions {
  config: DkgConfig;
  env?: Record<string, string | undefined>;
  resource: NonNullable<TelemetryInitConfig['resource']>;
  initOtel(config: TelemetryInitConfig): Promise<void>;
  shutdownOtel(): Promise<void>;
  startLogExporter(
    mode: ActiveLogExporterMode,
  ): TelemetryTransitionResult | Promise<TelemetryTransitionResult>;
  stopLogExporter(): Promise<void>;
  log(message: string): void;
}

/**
 * Compose the daemon's three telemetry signals behind one lifecycle adapter.
 * The same adapter is used by boot, the settings toggle, and shutdown so a
 * runtime enable cannot accidentally start logs without traces/metrics.
 */
export function createDaemonTelemetryLifecycle(
  options: DaemonTelemetryLifecycleOptions,
): TelemetrySignalAdapter {
  const startOtelSdk = async (): Promise<void> => {
    const { tracesEndpoint, metricsEndpoint, tracesOn, metricsOn } =
      resolveOtelSignals(options.config.telemetry, options.env);
    if (!tracesOn && !metricsOn) return;
    try {
      await options.initOtel({
        enabled: true,
        resource: options.resource,
        traces: tracesOn
          ? {
              endpoint: tracesEndpoint,
              token: options.config.telemetry?.traces?.token,
              sampleRatio: options.config.telemetry?.traces?.sampleRatio,
            }
          : undefined,
        metrics: metricsOn
          ? {
              endpoint: metricsEndpoint,
              token: options.config.telemetry?.metrics?.token,
              exportIntervalMs:
                options.config.telemetry?.metrics?.exportIntervalMs,
            }
          : undefined,
      });
      options.log(
        `Telemetry: OTel SDK registered (traces=${tracesOn ? tracesEndpoint : 'off'}, metrics=${metricsOn ? metricsEndpoint : 'off'})`,
      );
    } catch (error) {
      // Telemetry remains best-effort and must never block daemon startup.
      options.log(`Telemetry: OTel init failed (non-fatal): ${String(error)}`);
    }
  };

  return {
    async start(): Promise<TelemetryTransitionResult> {
      await startOtelSdk();
      // Unknown user-provided values fail closed to local-only logging.
      if (isUnknownLogExporter(options.config.telemetry)) {
        options.log(
          `Telemetry: unknown logs.exporter "${options.config.telemetry?.logs?.exporter}" — ` +
            "keeping logs local-only (no off-node forwarding). Use 'otlp', 'syslog', or 'none'.",
        );
      }
      const mode = resolveLogExporterMode(options.config.telemetry);
      if (mode === 'none') return { ok: true };
      return options.startLogExporter(mode);
    },

    async stop(): Promise<void> {
      await options.stopLogExporter();
      await options.shutdownOtel().catch(() => undefined);
    },
  };
}
