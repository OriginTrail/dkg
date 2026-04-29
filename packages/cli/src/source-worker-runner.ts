import { pathToFileURL } from 'node:url';
import {
  loadSourceWorkerState,
  runSourceWorkerOnce,
  type SourceWorkerDeps,
  type SourceWorkerJobState,
  type SourceWorkerSource,
} from '@origintrail-official/dkg-agent';
import {
  createDaemonAsyncLiftJobClient,
  createDaemonSharedMemoryWriteClient,
  type AsyncLiftJobClient,
  type SharedMemoryWriteClient,
} from './source-worker-daemon-client.js';
import { loadSourceWorkerConfig, type SourceWorkerConfig } from './source-worker-config.js';

export interface SourceWorkerHandlerContext<TSource extends SourceWorkerSource = SourceWorkerSource> {
  config: SourceWorkerConfig<TSource>;
  sharedMemory: SharedMemoryWriteClient;
  asyncLift: AsyncLiftJobClient;
}

export interface SourceWorkerHandlerModule<TSource extends SourceWorkerSource = SourceWorkerSource> {
  createSourceWorkerDeps(context: SourceWorkerHandlerContext<TSource>): Promise<
  Pick<SourceWorkerDeps<TSource>, 'getFingerprint' | 'processSource'>
  > | Pick<SourceWorkerDeps<TSource>, 'getFingerprint' | 'processSource'>;
}

export async function runConfiguredSourceWorker(configPath: string, options: { once?: boolean } = {}): Promise<void> {
  const config = await loadSourceWorkerConfig<SourceWorkerSource>(configPath);
  const sharedMemory = createDaemonSharedMemoryWriteClient(config.daemonUrl, config.daemonToken);
  const asyncLift = createDaemonAsyncLiftJobClient(config.daemonUrl, config.daemonToken);
  const handlerModule = await loadHandlerModule(config);
  const workerDeps = await handlerModule.createSourceWorkerDeps({
    config,
    sharedMemory,
    asyncLift,
  });

  const deps: SourceWorkerDeps<SourceWorkerSource> = {
    now() {
      return new Date().toISOString();
    },
    getFingerprint: workerDeps.getFingerprint,
    processSource: workerDeps.processSource,
    getJobStatus(jobId: string) {
      return asyncLift.getJobStatus(jobId);
    },
  };

  const runOnce = async () => {
    const previousState = await loadSourceWorkerState(config.stateFile);
    const state = await runSourceWorkerOnce(config.sources as SourceWorkerSource[], config.stateFile, deps);
    for (const source of config.sources as SourceWorkerSource[]) {
      const priorState = previousState.sources[source.id];
      const nextState = state.sources[source.id];
      console.log(formatSourceWorkerMessage(source.id, priorState, nextState));
    }
  };

  await runOnce();
  if (options.once) return;

  let running = false;
  setInterval(() => {
    void (async () => {
      if (running) {
        console.warn('[source-worker] skipping interval tick because previous run is still in progress');
        return;
      }
      running = true;
      try {
        await runOnce();
      } catch (error) {
        console.error('[source-worker] loop failed:', error instanceof Error ? error.message : String(error));
      } finally {
        running = false;
      }
    })();
  }, config.pollIntervalMs);
}

async function loadHandlerModule<TSource extends SourceWorkerSource>(
  config: SourceWorkerConfig<TSource>,
): Promise<SourceWorkerHandlerModule<TSource>> {
  const namespace = await import(pathToFileURL(config.handlerModule).href);
  const candidate = config.handlerExport
    ? namespace[config.handlerExport]
    : (namespace.default ?? namespace.sourceWorker ?? namespace);
  if (!candidate || typeof candidate.createSourceWorkerDeps !== 'function') {
    throw new Error(
      `Source worker handler module must export createSourceWorkerDeps()${config.handlerExport ? ` via ${config.handlerExport}` : ''}`,
    );
  }
  return candidate as SourceWorkerHandlerModule<TSource>;
}

function formatSourceWorkerMessage(
  sourceId: string,
  priorState: SourceWorkerJobState | undefined,
  state: SourceWorkerJobState | undefined,
): string {
  if (!state) return `[source-worker] ${sourceId}: no state`;
  if (state.manualReviewRequired) {
    return `[source-worker] ${sourceId}: manual review required (${state.manualReviewReason ?? state.lastError ?? 'unknown reason'})`;
  }
  const sameFingerprint = Boolean(priorState?.fingerprint && priorState.fingerprint === state.fingerprint);
  const sameJobs = sameStringArray(priorState?.lastJobIds, state.lastJobIds);
  if (state.lastStatus === 'finalized' || state.lastStatus === 'completed') {
    const jobs = state.lastJobIds?.length ? ` jobs=${state.lastJobIds.join(',')}` : '';
    if (sameFingerprint && sameJobs) {
      return `[source-worker] ${sourceId}: skipped (${state.lastStatus})${jobs}`;
    }
    return `[source-worker] ${sourceId}: published${jobs}`;
  }
  if (state.lastStatus === 'failed') {
    return `[source-worker] ${sourceId}: failed (${state.lastError ?? 'unknown error'})`;
  }
  if (state.lastStatus === 'in-flight') {
    const jobs = state.lastJobIds?.length ? ` jobs=${state.lastJobIds.join(',')}` : '';
    return `[source-worker] ${sourceId}: in-flight${jobs}`;
  }
  if (state.lastStatus === 'no-matching-rows') {
    return `[source-worker] ${sourceId}: skipped (no-matching-rows)`;
  }
  if (state.lastStatus && state.fingerprint) {
    return `[source-worker] ${sourceId}: skipped (${state.lastStatus})`;
  }
  return `[source-worker] ${sourceId}: state updated`;
}

function sameStringArray(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}
