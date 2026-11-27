/**
 * OpenTelemetry SDK bootstrap for a DKG node (boot side, daemon-only consumer).
 *
 * Registers the global Tracer + Meter providers at daemon startup so that the
 * call-site facade in `@origintrail-official/dkg-core` (getTracer/withSpan/
 * getMetrics) — used across agent/publisher/chain/sync — produces real spans and
 * metrics. When telemetry is disabled, or a signal has no endpoint, this
 * registers NOTHING: the core facade then talks to the API's built-in no-op
 * providers (zero cost, no outbound calls).
 *
 * Logs are NOT handled here — they stay on the hand-rolled `OtlpLogWorker`
 * (bounded buffer + retry + at-source redaction); the OTel Logs SDK is still
 * "Development". This module only wires traces + metrics, and shares ONE
 * Resource with the log worker so all three signals describe the same node.
 *
 * BROWSER SAFETY: the heavy Node-only OTel SDK packages (sdk-trace-node,
 * sdk-metrics, exporter-*-otlp-proto, resources) and `@origintrail-official/dkg-core`
 * are loaded via DYNAMIC import inside `initTelemetry`/`shutdownTelemetry`, never
 * statically. Only `@opentelemetry/api` (browser-safe, no Node built-ins) is a
 * static import. That keeps this module — and the package root that re-exports
 * it — free of server-only code in any static bundle graph: a browser bundler
 * never pulls the Node SDK because it sits behind a runtime `import()` that the
 * UI never triggers.
 */

import { metrics as otelMetrics, trace as otelTrace } from '@opentelemetry/api';
import { buildTelemetryResourceAttrs, type TelemetryResourceInput } from './telemetry-resource.js';
// Type-only imports are erased at compile time → no runtime/bundle dependency.
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { MeterProvider } from '@opentelemetry/sdk-metrics';

/**
 * Stable resource identity, shared by logs + traces + metrics. Single canonical
 * type — re-exported alias of `TelemetryResourceInput` (the shared resource
 * model in ./telemetry-resource) so logs and traces/metrics can't drift.
 */
export type TelemetryResource = TelemetryResourceInput;

export interface OtlpSignalConfig {
  endpoint?: string; // full signal URL, e.g. http://localhost:4318/v1/traces
  /** Bearer token → Authorization header. */
  token?: string;
  headers?: Record<string, string>;
  /** Per-signal opt-out. A signal is on only when it has an endpoint AND this is not false. */
  enabled?: boolean;
}

export interface TelemetryInitConfig {
  /** Master gate. When false, nothing is registered. */
  enabled?: boolean;
  resource?: TelemetryResource;
  traces?: OtlpSignalConfig & { sampleRatio?: number };
  metrics?: OtlpSignalConfig & { exportIntervalMs?: number };
}

/**
 * LEGACY config shape (pre-PR #1317 stub). Kept so old JS callers that pass
 * `{ enabled, metricsEndpoint, serviceName }` keep working — `initTelemetry`
 * normalizes it into `TelemetryInitConfig` (metricsEndpoint → metrics.endpoint).
 * @deprecated Use `TelemetryInitConfig` (traces/metrics signal blocks).
 */
export interface TelemetryConfig {
  enabled?: boolean;
  /** OTLP HTTP endpoint for metrics (e.g. http://localhost:4318/v1/metrics) */
  metricsEndpoint?: string;
  /** Service name for resource attributes */
  serviceName?: string;
}

// Independent per-signal lifecycle state (NOT one shared flag) so traces and
// metrics can be registered separately and one signal's setup never gates the other.
let tracerProvider: NodeTracerProvider | null = null;
let meterProvider: MeterProvider | null = null;

// Traces/metrics resource attributes come from the SAME shared builder the log
// worker uses — no second mapping to drift.
const buildAttrs = buildTelemetryResourceAttrs;

function authHeaders(sig: OtlpSignalConfig): Record<string, string> | undefined {
  const headers = { ...(sig.headers ?? {}) };
  if (sig.token) headers['Authorization'] = `Bearer ${sig.token}`;
  return Object.keys(headers).length ? headers : undefined;
}

/** Map the legacy flat `{ metricsEndpoint, serviceName }` shape onto the new one. */
function normalizeInitConfig(input: TelemetryInitConfig | TelemetryConfig): TelemetryInitConfig {
  const legacy = input as TelemetryConfig;
  const next = input as TelemetryInitConfig;
  if (legacy.metricsEndpoint && !next.metrics && !next.traces) {
    return {
      enabled: legacy.enabled,
      resource: { serviceName: legacy.serviceName },
      metrics: { endpoint: legacy.metricsEndpoint },
    };
  }
  return next;
}

/**
 * Initialize traces + metrics. No-op when disabled or when a signal has no
 * endpoint. Safe to call once at daemon boot. Idempotent (subsequent calls are
 * ignored once configured). Async because the Node OTel SDK is dynamically
 * imported (see the BROWSER SAFETY note above).
 */
export async function initTelemetry(input: TelemetryInitConfig | TelemetryConfig): Promise<void> {
  const cfg = normalizeInitConfig(input);
  if (!cfg.enabled) return;

  // Traces and metrics are INDEPENDENT signals: each registers only if it has
  // an endpoint AND isn't already registered. (No single `configured` gate — a
  // metrics-only init followed by a traces init must still register traces.)
  const tracesOn = !!cfg.traces?.endpoint && cfg.traces.enabled !== false && tracerProvider === null;
  const metricsOn = !!cfg.metrics?.endpoint && cfg.metrics.enabled !== false && meterProvider === null;
  if (!tracesOn && !metricsOn) return;

  const { resourceFromAttributes } = await import('@opentelemetry/resources');
  const resource = resourceFromAttributes(buildAttrs(cfg.resource));

  // ── Traces ──
  if (tracesOn) {
    const { NodeTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } =
      await import('@opentelemetry/sdk-trace-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-proto');
    const exporter = new OTLPTraceExporter({
      url: cfg.traces!.endpoint,
      headers: authHeaders(cfg.traces!),
    });
    const ratio = cfg.traces!.sampleRatio ?? 1;
    tracerProvider = new NodeTracerProvider({
      resource,
      sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    // register() installs the global tracer provider + an AsyncLocalStorage
    // context manager (so spans flow across awaits) + W3C trace-context propagator.
    tracerProvider.register();
  }

  // ── Metrics ──
  if (metricsOn) {
    const { MeterProvider, PeriodicExportingMetricReader } = await import('@opentelemetry/sdk-metrics');
    const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-proto');
    const { rebuildMetrics } = await import('@origintrail-official/dkg-core');
    const exporter = new OTLPMetricExporter({
      url: cfg.metrics!.endpoint,
      headers: authHeaders(cfg.metrics!),
    });
    meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: cfg.metrics!.exportIntervalMs ?? 30_000,
        }),
      ],
    });
    otelMetrics.setGlobalMeterProvider(meterProvider);
    // Re-bind the core facade's instrument cache to the real meter.
    rebuildMetrics();
  }
}

/** True once EITHER signal (traces or metrics) has registered a real provider. */
export function isTelemetryConfigured(): boolean {
  return tracerProvider !== null || meterProvider !== null;
}

/**
 * Wall-clock reserve for the terminal flush in the daemon's graceful-shutdown
 * path. `SHUTDOWN_HARD_TIMEOUT_MS` is 15 s and the catch-up grace drain ahead
 * of this may already have consumed 5 s, so the flush gets a fixed 2 s — well
 * under the ~10 s remainder, leaving room for runner close, `agent.stop()`,
 * the final `shutdownTelemetry()` and the database close behind it.
 */
export const TERMINAL_FLUSH_BUDGET_MS = 2_000;

/**
 * Flush pending spans/metrics WITHOUT tearing anything down.
 *
 * Exists because `shutdownTelemetry()` is not a flush: it shuts the providers
 * down, clears the OTel API globals and calls `rebuildMetrics()`, so every
 * later `getMetrics()` binds to a no-op meter. The daemon needs a point in
 * shutdown where already-recorded terminal state is exported while the
 * provider stays LIVE, because work that runs afterwards (`agent.stop()`
 * quiescing parent-side sync) still emits the attempts, bytes and active time
 * that belong to those same terminal records.
 *
 * ## Why each side is bounded differently
 *
 * Neither provider is bounded by default, and they are not bounded the same
 * way (verified against the installed `@opentelemetry/sdk-*@2.8.0`):
 *
 * - `MetricReader.forceFlush(options)` applies **no timeout at all** when
 *   `options.timeoutMillis` is absent — it just awaits `onForceFlush()`, whose
 *   trailing `this._exporter.forceFlush()` is wrapped by nothing. Passing
 *   `timeoutMillis` routes the whole thing through `callWithTimeout`, so the
 *   argument — not this comment — is what bounds the meter.
 * - `BasicTracerProvider.forceFlush()` accepts **no arguments**; it reads the
 *   constructor's `forceFlushTimeoutMillis` (default 30 000). The only way to
 *   bound it per call is to race it.
 *
 * The two bounded legs run concurrently, so the aggregate wait is also the
 * budget. Deliberately there is NO extra outer race around both: an outer
 * bound would return inside the budget even if one leg's own bound were
 * removed, which would make the per-leg bounds untestable — and an untestable
 * bound is how the previous "bounded" flush turned out to have no bound.
 *
 * Never throws into the shutdown path: a timeout or rejection is logged and
 * teardown continues. Bounded effort, not a delivery guarantee — an exporter
 * that cannot flush inside the reserve still loses its last points.
 */
export async function flushTelemetry(
  options: { budgetMs?: number; log?: (message: string) => void } = {},
): Promise<void> {
  const budgetMs = options.budgetMs ?? TERMINAL_FLUSH_BUDGET_MS;
  const log = options.log ?? ((message: string) => console.warn(message));
  const tracer = tracerProvider;
  const meter = meterProvider;
  if (!tracer && !meter) return;

  const legs: Array<Promise<void>> = [];
  if (meter) {
    legs.push(
      meter.forceFlush({ timeoutMillis: budgetMs }).catch((err: unknown) => {
        log(`[telemetry-flush] metrics flush did not complete: ${errText(err)}`);
      }),
    );
  }
  if (tracer) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raced = Promise.race([
      tracer.forceFlush(),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), budgetMs);
      }),
    ])
      .then((outcome) => {
        if (outcome === 'timeout') {
          log(`[telemetry-flush] traces flush exceeded ${budgetMs}ms; continuing teardown.`);
        }
      })
      .catch((err: unknown) => {
        log(`[telemetry-flush] traces flush did not complete: ${errText(err)}`);
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
    legs.push(raced);
  }
  await Promise.all(legs);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Flush + shut down providers. Used both at daemon teardown AND when telemetry
 * is turned off via the runtime master gate, so it must FULLY reverse
 * `initTelemetry`: stop the exporters, then clear the OTel API globals so a
 * later `initTelemetry` (live re-enable) can register fresh providers — without
 * the `disable()` calls, the API keeps the first (now shut-down) provider and a
 * re-enable would silently no-op. Safe if never initialized; idempotent.
 *
 * Flush and shutdown run SEQUENTIALLY per provider, and that is not tidiness.
 * They used to be pushed into one array and awaited by a single `Promise.all`,
 * i.e. started concurrently against the same provider — and
 * `MeterProvider.forceFlush()` opens with `if (this._shutdown) { diag.warn(…);
 * return; }`. Whichever call won the race decided whether the flush happened at
 * all; it worked only because the synchronous `_shutdown` read happened to be
 * scheduled first. Awaiting the flush before starting the shutdown removes the
 * race instead of relying on scheduling order.
 */
export async function shutdownTelemetry(): Promise<void> {
  const hadTracer = !!tracerProvider;
  const hadMeter = !!meterProvider;
  if (tracerProvider) {
    await tracerProvider.forceFlush().catch(() => {});
    await tracerProvider.shutdown().catch(() => {});
  }
  if (meterProvider) {
    await meterProvider.forceFlush().catch(() => {});
    await meterProvider.shutdown().catch(() => {});
  }
  // Reset the global API so a subsequent initTelemetry() can re-register
  // (setGlobal*Provider only takes effect once until the slot is disabled).
  if (hadTracer) otelTrace.disable();
  if (hadMeter) {
    otelMetrics.disable();
    // Rebind the core facade's instrument cache back to the no-op meter so
    // getMetrics() after disable is inert rather than holding dead instruments.
    const { rebuildMetrics } = await import('@origintrail-official/dkg-core');
    rebuildMetrics();
  }
  tracerProvider = null;
  meterProvider = null;
}

/**
 * @deprecated No-op compatibility shim for the pre-PR #1317 telemetry API. Node
 * metrics flow through the `@origintrail-official/dkg-core` facade
 * (`getMetrics()`), not this call. Kept so old callers don't break at import.
 */
export function recordGauge(_name: string, _value: number): void {
  /* no-op (browser-safe): real metrics go through getMetrics() */
}

/**
 * @deprecated No-op compatibility shim for the pre-PR #1317 telemetry API. Spans
 * are created via the core facade `withSpan()`/`getTracer()`. Kept so old
 * callers don't break at import.
 */
export function setOperationSpan(_operationId: string, _operationName: string): void {
  /* no-op (browser-safe): real spans go through withSpan() */
}
