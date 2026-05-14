import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sanitizeConfig } from './config.js';
import { createPayload, getSparql, validateQueryContainsMarker } from './payload.js';
import { createFailureRecord, errorMessage, extractFailures, roundMs, summarizeOperations } from './stats.js';
import type {
  BenchmarkClient,
  BenchmarkConfig,
  BenchmarkOperation,
  BenchmarkPayload,
  BenchmarkResult,
  MeasuredOperation,
  OperationTiming,
} from './types.js';

const TERMINAL_ASYNC_STATUSES = new Set(['finalized', 'failed', 'cancelled']);

export async function runPublishAsyncGetBenchmark(
  config: BenchmarkConfig,
  client: BenchmarkClient,
  now = () => performance.now(),
): Promise<BenchmarkResult> {
  await assertDaemonAvailable(client, config.timeoutMs);
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const operations: OperationTiming[] = [];

  for (let i = 1; i <= config.warmups; i += 1) {
    await runIteration({ config, client, now, operations, runId, iteration: i, warmup: true });
  }
  for (let i = 1; i <= config.repeat; i += 1) {
    await runIteration({ config, client, now, operations, runId, iteration: i, warmup: false });
  }

  return {
    benchmark: 'publish-async-get',
    startedAt,
    finishedAt: new Date().toISOString(),
    config: sanitizeConfig(config),
    operations,
    summaries: summarizeOperations(operations),
    failures: extractFailures(operations),
  };
}

async function runIteration(args: {
  config: BenchmarkConfig;
  client: BenchmarkClient;
  now: () => number;
  operations: OperationTiming[];
  runId: string;
  iteration: number;
  warmup: boolean;
}): Promise<void> {
  const { config, client, now, operations, runId, iteration, warmup } = args;
  const syncPayload = createPayload(config, runId, iteration, 'sync', warmup);
  const syncContext = reproductionContext(config, iteration, syncPayload, { flow: 'sync' });

  const syncPublish = await measureOperation('syncPublish', iteration, warmup, syncContext, config.timeoutMs, now, async () => {
    await client.sharedMemoryWrite(config.contextGraphId, syncPayload.quads);
    const result = await client.publishFromSharedMemory(
      config.contextGraphId,
      { rootEntities: [syncPayload.rootEntity] },
      false,
    );
    if (!result.kcId) {
      throw new Error('Synchronous publish response did not include kcId');
    }
    return result;
  });
  operations.push(syncPublish.timing);

  if (syncPublish.ok) {
    const sparql = getSparql(syncPayload.rootEntity);
    const getContext = reproductionContext(config, iteration, syncPayload, {
      flow: 'get',
      kcId: syncPublish.value?.kcId,
      sparql,
    });
    const get = await measureOperation('get', iteration, warmup, getContext, config.timeoutMs, now, async () => {
      const response = await client.query(sparql, config.contextGraphId, { view: config.getView });
      validateQueryContainsMarker(response.result, syncPayload.marker);
      return response;
    });
    operations.push(get.timing);
  } else {
    operations.push(createFailureRecord(
      'get',
      iteration,
      new Error('Skipped because syncPublish failed for the payload that get validates'),
      reproductionContext(config, iteration, syncPayload, { flow: 'get', skippedAfter: 'syncPublish' }),
      warmup,
    ));
  }

  const asyncPayload = createPayload(config, runId, iteration, 'async', warmup);
  const asyncBaseContext = reproductionContext(config, iteration, asyncPayload, { flow: 'async' });
  let shareOperationId: string;
  try {
    const prepared = await withTimeout(
      client.sharedMemoryWrite(config.contextGraphId, asyncPayload.quads),
      config.timeoutMs,
      'async shared-memory write',
    );
    shareOperationId = prepared.shareOperationId ?? '';
    if (!shareOperationId) throw new Error('Shared-memory write response did not include shareOperationId');
  } catch (error) {
    operations.push(createFailureRecord('asyncEnqueue', iteration, error, { ...asyncBaseContext, phase: 'sharedMemoryWrite' }, warmup));
    operations.push(createFailureRecord('asyncCompletion', iteration, new Error('Skipped because async enqueue preparation failed'), {
      ...asyncBaseContext,
      skippedAfter: 'sharedMemoryWrite',
    }, warmup));
    return;
  }

  const enqueue = await measureOperation('asyncEnqueue', iteration, warmup, {
    ...asyncBaseContext,
    shareOperationId,
  }, config.timeoutMs, now, async () => {
    const result = await client.publisherEnqueue({
      contextGraphId: config.contextGraphId,
      shareOperationId,
      roots: [asyncPayload.rootEntity],
      namespace: config.namespace,
      scope: config.scope,
      authorityProofRef: config.authorityProofRef,
      swmId: 'swm-main',
      transitionType: 'CREATE',
      authorityType: 'owner',
    });
    if (!result.jobId) throw new Error('Async enqueue response did not include jobId');
    return result;
  });
  operations.push(enqueue.timing);

  if (!enqueue.ok || !enqueue.value?.jobId) {
    operations.push(createFailureRecord('asyncCompletion', iteration, new Error('Skipped because asyncEnqueue failed'), {
      ...asyncBaseContext,
      shareOperationId,
      skippedAfter: 'asyncEnqueue',
    }, warmup));
    return;
  }

  const completion = await measureOperation('asyncCompletion', iteration, warmup, {
    ...asyncBaseContext,
    shareOperationId,
    jobId: enqueue.value.jobId,
  }, config.timeoutMs, now, () => waitForAsyncCompletion(config, client, enqueue.value!.jobId!));
  operations.push(completion.timing);
}

async function measureOperation<T>(
  operation: BenchmarkOperation,
  iteration: number,
  warmup: boolean,
  context: Record<string, unknown>,
  timeoutMs: number,
  now: () => number,
  fn: () => Promise<T>,
): Promise<MeasuredOperation<T>> {
  const start = now();
  try {
    const value = await withTimeout(fn(), timeoutMs, operation);
    return {
      ok: true,
      value,
      timing: { operation, iteration, warmup, success: true, durationMs: roundMs(now() - start), context },
    };
  } catch (error) {
    return {
      ok: false,
      timing: createFailureRecord(operation, iteration, error, context, warmup, now() - start),
    };
  }
}

async function waitForAsyncCompletion(
  config: BenchmarkConfig,
  client: BenchmarkClient,
  jobId: string,
): Promise<{ jobId: string; status: string }> {
  const deadline = performance.now() + config.timeoutMs;
  let lastStatus = 'unknown';

  while (performance.now() <= deadline) {
    const response = await client.publisherJob(jobId);
    const job = response.job;
    const status = String(job?.status ?? 'unknown');
    lastStatus = status;
    if (config.asyncSuccessStatuses.includes(status)) return { jobId, status };
    if (TERMINAL_ASYNC_STATUSES.has(status)) {
      throw new Error(`Async publisher job ${jobId} reached ${status}: ${job?.error ?? job?.lastError ?? 'no error detail'}`);
    }
    await sleep(config.pollIntervalMs);
  }

  throw new Error(`Timed out waiting ${config.timeoutMs}ms for async publisher job ${jobId}; last status=${lastStatus}`);
}

async function assertDaemonAvailable(client: BenchmarkClient, timeoutMs: number): Promise<void> {
  try {
    await withTimeout(client.status(), Math.min(timeoutMs, 10_000), 'daemon status');
  } catch (error) {
    throw new Error(
      'DKG daemon is unavailable. Start a local node with `dkg start`, set DKG_API_PORT, or pass --api-url. ' +
      `Status check failed: ${errorMessage(error)}`,
    );
  }
}

function reproductionContext(
  config: BenchmarkConfig,
  iteration: number,
  payload: BenchmarkPayload,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const target = config.apiUrl
    ? `--api-url ${config.apiUrl}`
    : config.apiPort
      ? `--api-port ${config.apiPort}`
      : 'default API discovery';

  return {
    operationCommand: `pnpm --filter @origintrail-official/dkg benchmark:publish-async-get -- ` +
      `--context-graph-id ${config.contextGraphId} --repeat 1 --warmups 0 ` +
      `--payload-size ${config.payloadSizeBytes} --fixture ${config.fixture}`,
    apiTarget: target,
    contextGraphId: config.contextGraphId,
    iteration,
    rootEntity: payload.rootEntity,
    marker: payload.marker,
    payloadSizeBytes: config.payloadSizeBytes,
    fixture: config.fixture,
    ...extra,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
