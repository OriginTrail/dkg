import { randomUUID } from 'node:crypto';
import { open, readFile, mkdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface SourceWorkerJobState {
  fingerprint?: string;
  lastRunAt?: string;
  assertionName?: string;
  shareOperationId?: string;
  intentKey?: string;
  lastJobIds?: string[];
  lastJobStatuses?: Record<string, string>;
  lastStatus?: string;
  pendingPublisherJobIds?: string[];
  finalDaemonStatus?: string;
  txHash?: string;
  ual?: string;
  failureDetails?: SourceWorkerJobFailureDetails;
  lastError?: string;
  attemptCount?: number;
  manualReviewRequired?: boolean;
  manualReviewReason?: string;
}

export interface SourceWorkerJobFailureDetails {
  status?: string;
  code?: string;
  message?: string;
  details?: unknown;
}

export interface SourceWorkerJobStatusSnapshot {
  status: string;
  txHash?: string;
  ual?: string;
  failureDetails?: SourceWorkerJobFailureDetails;
}

export type SourceWorkerJobStatusResult = string | SourceWorkerJobStatusSnapshot;

export interface SourceWorkerState {
  sources: Record<string, SourceWorkerJobState>;
}

export interface SourceWorkerSource {
  id: string;
  maxRetries?: number;
}

export interface SourcePreparationResult<TAsset = unknown> {
  fingerprint: string;
  assets: TAsset[];
  warnings?: string[];
}

export interface SourceKindHandler<TSource = SourceWorkerSource, TAsset = unknown> {
  /**
   * Return a stable fingerprint for source content that affects emitted assets.
   * Changed content must produce a different fingerprint; unchanged content
   * must keep the same fingerprint across runs.
   */
  computeFingerprint(source: TSource): Promise<string>;
  prepare(source: TSource): Promise<SourcePreparationResult<TAsset>>;
}

export interface SourceWorkerResult {
  sourceId: string;
  skipped: boolean;
  reason?: string;
  jobIds?: string[];
  jobStatuses?: Record<string, string>;
  status?: string;
  pendingPublisherJobIds?: string[];
  finalDaemonStatus?: string;
  txHash?: string;
  ual?: string;
  failureDetails?: SourceWorkerJobFailureDetails;
  nextState: SourceWorkerJobState;
}

export interface SourceWorkerDeps<TSource extends SourceWorkerSource> {
  now(): string;
  /**
   * Return a stable fingerprint for source content that affects emitted
   * triples/assets. Changed content must produce a different fingerprint;
   * unchanged content must keep the same fingerprint across runs. Do not
   * include wall-clock time, random values, transient job status, or polling
   * noise.
   */
  getFingerprint(source: TSource): Promise<string>;
  processSource(source: TSource, fingerprint: string, state: SourceWorkerJobState | undefined): Promise<SourceWorkerResult>;
  getJobStatus(jobId: string): Promise<SourceWorkerJobStatusResult>;
}

export async function loadSourceWorkerState(path: string): Promise<SourceWorkerState> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as SourceWorkerState;
    return normalizeSourceWorkerState(parsed);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { sources: {} };
    throw error;
  }
}

export async function saveSourceWorkerState(path: string, state: SourceWorkerState): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let tempFile: FileHandle | undefined;

  try {
    tempFile = await open(tempPath, 'wx');
    await tempFile.writeFile(JSON.stringify(state, null, 2) + '\n', 'utf8');
    await tempFile.sync();
    await tempFile.close();
    tempFile = undefined;

    await rename(tempPath, path);
    await syncDirectory(dir);
  } catch (error) {
    if (tempFile) {
      await tempFile.close().catch(() => undefined);
    }
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function runSourceWorkerOnce<TSource extends SourceWorkerSource>(
  sources: readonly TSource[],
  statePath: string,
  deps: SourceWorkerDeps<TSource>,
): Promise<SourceWorkerState> {
  const state = await loadSourceWorkerState(statePath);
  const nextState: SourceWorkerState = { sources: { ...state.sources } };

  for (const source of sources) {
    const current = state.sources[source.id];
    const fingerprint = await deps.getFingerprint(source);
    const jobIdsToPoll = getPublisherJobIdsToPoll(current);
    const collected = jobIdsToPoll.length > 0
      ? await collectJobStatuses(jobIdsToPoll, deps)
      : emptyCollectedJobStatuses();
    const statuses = mergeJobStatuses(current?.lastJobStatuses, collected.statuses);
    const aggregate = aggregateStatuses(statuses);
    const pendingPublisherJobIds = derivePendingPublisherJobIds(statuses);
    const txHash = collected.txHash ?? current?.txHash;
    const ual = collected.ual ?? current?.ual;
    const finalDaemonStatus = pendingPublisherJobIds.length > 0
      ? undefined
      : normalizeFinalStatus(aggregate || current?.finalDaemonStatus || current?.lastStatus);
    const failureStatus = failureStatusForDetails(
      finalDaemonStatus,
      aggregate || current?.lastStatus,
      current?.manualReviewRequired,
    );
    const failureDetails = failureStatus
      ? collected.failureDetails ?? current?.failureDetails ?? deriveFailureDetails(failureStatus, current?.lastError)
      : undefined;

    if (current?.fingerprint === fingerprint && current.manualReviewRequired) {
      nextState.sources[source.id] = {
        ...current,
        lastRunAt: deps.now(),
        lastJobStatuses: statuses,
        lastStatus: 'manual-review-required',
        pendingPublisherJobIds,
        finalDaemonStatus,
        txHash,
        ual,
        failureDetails,
      };
      continue;
    }

    if (current?.fingerprint === fingerprint && isActiveStatus(aggregate)) {
      nextState.sources[source.id] = {
        ...current,
        lastRunAt: deps.now(),
        lastJobStatuses: statuses,
        lastStatus: aggregate,
        pendingPublisherJobIds,
        finalDaemonStatus: undefined,
        txHash,
        ual,
        failureDetails: undefined,
      };
      continue;
    }

    if (current?.fingerprint === fingerprint && isSuccessStatus(aggregate)) {
      nextState.sources[source.id] = {
        ...current,
        lastRunAt: deps.now(),
        lastJobStatuses: statuses,
        lastStatus: normalizeFinalStatus(aggregate) ?? aggregate,
        pendingPublisherJobIds,
        finalDaemonStatus: normalizeFinalStatus(aggregate),
        txHash,
        ual,
        lastError: undefined,
        failureDetails: undefined,
      };
      continue;
    }

    if (current?.fingerprint === fingerprint && isFailureStatus(aggregate)) {
      nextState.sources[source.id] = {
        ...current,
        lastRunAt: deps.now(),
        lastJobStatuses: statuses,
        lastStatus: 'failed',
        pendingPublisherJobIds,
        finalDaemonStatus: 'failed',
        txHash,
        ual,
        failureDetails: failureDetails ?? { status: 'failed' },
      };
      continue;
    }

    const nextAttemptCount = current?.fingerprint === fingerprint ? (current.attemptCount ?? 0) + 1 : 1;
    const maxRetries = source.maxRetries ?? 3;
    if (current?.fingerprint === fingerprint && nextAttemptCount > maxRetries) {
      nextState.sources[source.id] = {
        ...current,
        lastRunAt: deps.now(),
        lastJobStatuses: statuses,
        lastStatus: 'manual-review-required',
        lastError: `max retries exceeded (${maxRetries})`,
        pendingPublisherJobIds,
        finalDaemonStatus,
        txHash,
        ual,
        failureDetails: failureDetails ?? { status: 'manual-review-required', message: `max retries exceeded (${maxRetries})` },
        attemptCount: nextAttemptCount,
        manualReviewRequired: true,
        manualReviewReason: `max retries exceeded (${maxRetries})`,
      };
      continue;
    }

    try {
      const result = await deps.processSource(source, fingerprint, current);
      nextState.sources[source.id] = normalizeProcessedState(result);
    } catch (error: any) {
      nextState.sources[source.id] = {
        ...current,
        fingerprint,
        lastRunAt: deps.now(),
        lastStatus: 'failed',
        lastError: error?.message ?? String(error),
        pendingPublisherJobIds: [],
        finalDaemonStatus: 'failed',
        failureDetails: { status: 'failed', message: error?.message ?? String(error) },
        attemptCount: nextAttemptCount,
      };
    }
  }

  await saveSourceWorkerState(statePath, nextState);
  return nextState;
}

interface CollectedJobStatuses {
  statuses: Record<string, string>;
  txHash?: string;
  ual?: string;
  failureDetails?: SourceWorkerJobFailureDetails;
}

function emptyCollectedJobStatuses(): CollectedJobStatuses {
  return { statuses: {} };
}

async function collectJobStatuses<TSource extends SourceWorkerSource>(
  jobIds: readonly string[],
  deps: SourceWorkerDeps<TSource>,
): Promise<CollectedJobStatuses> {
  const entries = await Promise.all(jobIds.map(async (jobId) => {
    const snapshot = normalizeJobStatusResult(await deps.getJobStatus(jobId));
    return [jobId, snapshot] as const;
  }));
  return {
    statuses: Object.fromEntries(entries.map(([jobId, snapshot]) => [jobId, snapshot.status])),
    txHash: entries.find(([, snapshot]) => snapshot.txHash)?.[1].txHash,
    ual: entries.find(([, snapshot]) => snapshot.ual)?.[1].ual,
    failureDetails: entries.find(([, snapshot]) => snapshot.failureDetails)?.[1].failureDetails,
  };
}

function normalizeJobStatusResult(result: SourceWorkerJobStatusResult): SourceWorkerJobStatusSnapshot {
  return typeof result === 'string' ? { status: result } : result;
}

function normalizeSourceWorkerState(state: SourceWorkerState): SourceWorkerState {
  return {
    sources: Object.fromEntries(
      Object.entries(state.sources ?? {}).map(([sourceId, sourceState]) => [
        sourceId,
        normalizeSourceWorkerJobState(sourceState),
      ]),
    ),
  };
}

function normalizeSourceWorkerJobState(state: SourceWorkerJobState): SourceWorkerJobState {
  const statuses = state.lastJobStatuses ?? {};
  const pendingPublisherJobIds = Object.prototype.hasOwnProperty.call(state, 'pendingPublisherJobIds')
    ? (state.pendingPublisherJobIds ?? []).filter((jobId) => {
        const status = statuses[jobId];
        return status === undefined || isActiveStatus(status);
      })
    : getPublisherJobIdsToPoll(state);
  const mergedPendingPublisherJobIds = unique([
    ...pendingPublisherJobIds,
    ...derivePendingPublisherJobIds(statuses),
  ]);
  const aggregate = aggregateStatuses(statuses);
  const finalDaemonStatus = mergedPendingPublisherJobIds.length > 0
    ? undefined
    : state.finalDaemonStatus ?? normalizeFinalStatus(aggregate || state.lastStatus);
  const failureStatus = failureStatusForDetails(finalDaemonStatus, aggregate || state.lastStatus, state.manualReviewRequired);
  return {
    ...state,
    pendingPublisherJobIds: mergedPendingPublisherJobIds,
    finalDaemonStatus,
    failureDetails: failureStatus
      ? state.failureDetails ?? deriveFailureDetails(failureStatus, state.lastError)
      : undefined,
  };
}

function normalizeProcessedState(result: SourceWorkerResult): SourceWorkerJobState {
  const statuses = result.nextState.lastJobStatuses ?? result.jobStatuses ?? {};
  const pendingPublisherJobIds = result.nextState.pendingPublisherJobIds
    ?? result.pendingPublisherJobIds
    ?? deriveProcessedPendingPublisherJobIds(result, statuses);
  const finalDaemonStatus = result.nextState.finalDaemonStatus ?? result.finalDaemonStatus;
  const resultStatus = result.nextState.lastStatus ?? result.status;
  const failureStatus = failureStatusForDetails(
    finalDaemonStatus,
    resultStatus,
    result.nextState.manualReviewRequired,
  );
  return {
    ...result.nextState,
    pendingPublisherJobIds,
    finalDaemonStatus,
    txHash: result.nextState.txHash ?? result.txHash,
    ual: result.nextState.ual ?? result.ual,
    lastError: isSuccessStatus(finalDaemonStatus) || isSuccessStatus(resultStatus)
      ? undefined
      : result.nextState.lastError,
    failureDetails: failureStatus
      ? result.nextState.failureDetails ?? result.failureDetails
      : undefined,
  };
}

function deriveProcessedPendingPublisherJobIds(
  result: SourceWorkerResult,
  statuses: Record<string, string>,
): string[] {
  const activeJobIds = derivePendingPublisherJobIds(statuses);
  if (activeJobIds.length > 0) {
    return activeJobIds;
  }
  if (Object.keys(statuses).length === 0 && isActiveStatus(result.nextState.lastStatus ?? result.status)) {
    return result.nextState.lastJobIds ?? result.jobIds ?? [];
  }
  return [];
}

function getPublisherJobIdsToPoll(state: SourceWorkerJobState | undefined): string[] {
  if (!state) return [];
  if (Object.prototype.hasOwnProperty.call(state, 'pendingPublisherJobIds')) {
    return state.pendingPublisherJobIds ?? [];
  }
  const statuses = state.lastJobStatuses ?? {};
  const statusEntries = Object.entries(statuses);
  const activeJobIds = statusEntries
    .filter(([, status]) => isActiveStatus(status))
    .map(([jobId]) => jobId);
  if (activeJobIds.length > 0) {
    return activeJobIds;
  }
  if (statusEntries.length === 0 && isActiveStatus(state.lastStatus)) {
    return state.lastJobIds ?? [];
  }
  return [];
}

function mergeJobStatuses(
  previous: Record<string, string> | undefined,
  next: Record<string, string>,
): Record<string, string> {
  return Object.keys(next).length > 0 ? { ...(previous ?? {}), ...next } : (previous ?? {});
}

function derivePendingPublisherJobIds(statuses: Record<string, string>): string[] {
  return Object.entries(statuses)
    .filter(([, status]) => isActiveStatus(status))
    .map(([jobId]) => jobId);
}

function aggregateStatuses(statuses: Record<string, string>): string {
  const values = Object.values(statuses);
  if (values.length === 0) return '';
  if (values.every((status) => status === 'finalized' || status === 'completed')) return 'finalized';
  if (values.some((status) => status === 'failed' || status === 'error')) return 'failed';
  if (values.some((status) => isActiveStatus(status))) return 'in-flight';
  return values[0] ?? '';
}

function isSuccessStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'finalized' || status === 'no-matching-rows';
}

function isFailureStatus(status: string | undefined): boolean {
  return status === 'failed' || status === 'error';
}

function isActiveStatus(status: string | undefined): boolean {
  return status === 'accepted' || status === 'claimed' || status === 'validated' || status === 'broadcast' || status === 'included' || status === 'queued' || status === 'in-flight';
}

function normalizeFinalStatus(status: string | undefined): string | undefined {
  if (!status) return undefined;
  if (status === 'completed' || status === 'finalized') return 'finalized';
  if (status === 'failed' || status === 'error') return 'failed';
  return undefined;
}

function failureStatusForDetails(
  finalDaemonStatus: string | undefined,
  status: string | undefined,
  manualReviewRequired: boolean | undefined,
): string | undefined {
  if (manualReviewRequired || status === 'manual-review-required') {
    return 'manual-review-required';
  }
  if (isFailureStatus(finalDaemonStatus)) {
    return finalDaemonStatus;
  }
  if (isFailureStatus(status)) {
    return status;
  }
  return undefined;
}

function deriveFailureDetails(
  status: string | undefined,
  message: string | undefined,
): SourceWorkerJobFailureDetails | undefined {
  if (!status) {
    return undefined;
  }
  return {
    status,
    message,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function syncDirectory(path: string): Promise<void> {
  let dir: FileHandle | undefined;
  try {
    dir = await open(path, 'r');
    await dir.sync();
  } catch (error: any) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error?.code)) {
      throw error;
    }
  } finally {
    if (dir) {
      await dir.close().catch(() => undefined);
    }
  }
}
