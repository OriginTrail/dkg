import type { OxigraphSupervisorChildV1 } from './oxigraph-supervisor-child.js';
import type { OxigraphSupervisorGenerationV1 } from './oxigraph-supervisor-generation.js';

interface StartOxigraphSupervisorOptionsV1 {
  readonly beginTermination: () => void;
  readonly stopLocked: () => Promise<void>;
  readonly child: Pick<OxigraphSupervisorChildV1, 'stderrTail'>;
  readonly generation: Pick<OxigraphSupervisorGenerationV1, 'spawnAndProve'>;
  readonly bind: string;
  readonly readyTimeoutMs: number;
  readonly log: (message: string) => void;
  readonly binaryPath: string;
  readonly location: string;
  readonly queryTimeoutS?: number;
  readonly launchSummary: string | null | undefined;
}

/** Initial spawn/readiness phase; failures close and reap inline under the lifecycle lock. */
export async function startOxigraphSupervisorV1(
  options: StartOxigraphSupervisorOptionsV1,
): Promise<void> {
  const {
    beginTermination,
    stopLocked,
    child,
    generation,
    bind,
    readyTimeoutMs,
    log,
    binaryPath,
    location,
    queryTimeoutS,
    launchSummary,
  } = options;
  log(
    queryTimeoutS !== undefined
      ? `Starting Oxigraph server on ${bind} (location: ${location}, query timeout: ${queryTimeoutS}s)…`
      : `Starting Oxigraph server on ${bind} (location: ${location})…`,
  );
  if (launchSummary) log(launchSummary);
  const result = await generation.spawnAndProve();
  if (result.status === 'ready') {
    log(
      `Oxigraph server ready on ${bind} after ${result.attempts} probe(s) ` +
        `(generation ${result.generation}).`,
    );
    return;
  }

  beginTermination();
  await stopLocked();
  const stderrHint = child.stderrTail().trim()
    ? ` Last server output:\n${child.stderrTail().trim()}`
    : '';
  throw new Error(
    result.status === 'child-exited'
      ? `Oxigraph server exited during startup on ${bind} ` +
        `(binary: ${binaryPath}, location: ${location}). ` +
        `The port may already be in use by another process.${stderrHint}`
      : `Oxigraph server did not become ready on ${bind} within ${readyTimeoutMs}ms ` +
        `(binary: ${binaryPath}, location: ${location}).${stderrHint}`,
  );
}
