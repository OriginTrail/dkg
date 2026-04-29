import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface SourceWorkerJobState {
  fingerprint?: string;
  lastRunAt?: string;
  lastJobIds?: string[];
  lastJobStatuses?: Record<string, string>;
  lastStatus?: string;
  lastError?: string;
  attemptCount?: number;
  manualReviewRequired?: boolean;
  manualReviewReason?: string;
}

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
  nextState: SourceWorkerJobState;
}

export interface SourceWorkerDeps<TSource extends SourceWorkerSource> {
  now(): string;
  getFingerprint(source: TSource): Promise<string>;
  processSource(source: TSource, fingerprint: string, state: SourceWorkerJobState | undefined): Promise<SourceWorkerResult>;
  getJobStatus(jobId: string): Promise<string>;
}

export async function loadSourceWorkerState(path: string): Promise<SourceWorkerState> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as SourceWorkerState;
    return { sources: parsed.sources ?? {} };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { sources: {} };
    throw error;
  }
}

export async function saveSourceWorkerState(path: string, state: SourceWorkerState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
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
    const statuses = current?.lastJobIds?.length
      ? Object.fromEntries(await Promise.all(current.lastJobIds.map(async (jobId) => [jobId, await deps.getJobStatus(jobId)] as const)))
      : {};
    const aggregate = aggregateStatuses(statuses);

    if (current?.fingerprint === fingerprint && current.manualReviewRequired) {
      nextState.sources[source.id] = {
        ...current,
        lastRunAt: deps.now(),
        lastJobStatuses: statuses,
        lastStatus: 'manual-review-required',
      };
      continue;
    }

    if (current?.fingerprint === fingerprint && isActiveStatus(aggregate)) {
      nextState.sources[source.id] = {
        ...current,
        lastRunAt: deps.now(),
        lastJobStatuses: statuses,
        lastStatus: aggregate,
      };
      continue;
    }

    if (current?.fingerprint === fingerprint && isSuccessStatus(aggregate)) {
      nextState.sources[source.id] = {
        ...current,
        lastRunAt: deps.now(),
        lastJobStatuses: statuses,
        lastStatus: aggregate,
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
        attemptCount: nextAttemptCount,
        manualReviewRequired: true,
        manualReviewReason: `max retries exceeded (${maxRetries})`,
      };
      continue;
    }

    try {
      const result = await deps.processSource(source, fingerprint, current);
      nextState.sources[source.id] = result.nextState;
    } catch (error: any) {
      nextState.sources[source.id] = {
        ...current,
        fingerprint,
        lastRunAt: deps.now(),
        lastStatus: 'failed',
        lastError: error?.message ?? String(error),
        attemptCount: nextAttemptCount,
      };
    }
  }

  await saveSourceWorkerState(statePath, nextState);
  return nextState;
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

function isActiveStatus(status: string | undefined): boolean {
  return status === 'accepted' || status === 'claimed' || status === 'validated' || status === 'broadcast' || status === 'included' || status === 'queued' || status === 'in-flight';
}
