import {
  bindProvenOxigraphGenerationV1,
  type OxigraphSupervisorOperationContextV1,
} from './oxigraph-supervisor-operation-context.js';
import type {
  OxigraphSupervisorShutdownOperationsV1,
} from './oxigraph-supervisor-shutdown-operations.js';
import { sleepOxigraphSupervisorV1 } from './oxigraph-supervisor-lifecycle.js';

interface StartOxigraphSupervisorOptionsV1 {
  readonly context: OxigraphSupervisorOperationContextV1;
  readonly shutdown: OxigraphSupervisorShutdownOperationsV1;
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
    context,
    shutdown,
    binaryPath,
    location,
    queryTimeoutS,
    launchSummary,
  } = options;
  const { child, probes, bind, readyTimeoutMs, readyIntervalMs, log } = context;
  log(
    queryTimeoutS !== undefined
      ? `Starting Oxigraph server on ${bind} (location: ${location}, query timeout: ${queryTimeoutS}s)…`
      : `Starting Oxigraph server on ${bind} (location: ${location})…`,
  );
  if (launchSummary) log(launchSummary);
  child.spawn();

  const deadline = Date.now() + readyTimeoutMs;
  let attempt = 0;
  let childDied = false;
  while (Date.now() < deadline) {
    attempt += 1;
    if (!child.alive()) {
      childDied = true;
      break;
    }
    const listenerPid = await probes.probeReady();
    if (listenerPid !== null) {
      if (child.alive()) {
        const generation = bindProvenOxigraphGenerationV1(
          context,
          child.current()!,
          listenerPid,
        );
        log(
          `Oxigraph server ready on ${bind} after ${attempt} probe(s) ` +
            `(generation ${generation}).`,
        );
        return;
      }
      childDied = true;
      break;
    }
    await sleepOxigraphSupervisorV1(readyIntervalMs);
  }

  shutdown.beginTermination();
  await shutdown.stopLocked();
  const stderrHint = child.stderrTail().trim()
    ? ` Last server output:\n${child.stderrTail().trim()}`
    : '';
  throw new Error(
    childDied
      ? `Oxigraph server exited during startup on ${bind} ` +
        `(binary: ${binaryPath}, location: ${location}). ` +
        `The port may already be in use by another process.${stderrHint}`
      : `Oxigraph server did not become ready on ${bind} within ${readyTimeoutMs}ms ` +
        `(binary: ${binaryPath}, location: ${location}).${stderrHint}`,
  );
}
