export type CatchupMode = 'background' | 'foreground';

export const FOREGROUND_CATCHUP_SYNC_PRIORITY = 2_000;
export const CATCHUP_BACKPRESSURE_RETRY_DELAYS_MS = [100, 250, 500] as const;

export interface CatchupPlaneResult {
  deferredBackpressure?: number;
}

export interface CatchupPlaneContext {
  priority?: number;
}

export interface CatchupPlanePolicyOptions<
  TDurable extends CatchupPlaneResult,
  TShared extends CatchupPlaneResult,
> {
  mode: CatchupMode;
  includeSharedMemory: boolean;
  syncDurable: (context: CatchupPlaneContext) => Promise<TDurable>;
  syncSharedMemory: (context: CatchupPlaneContext) => Promise<TShared>;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}

export interface CatchupPlanePolicyResult<
  TDurable extends CatchupPlaneResult,
  TShared extends CatchupPlaneResult,
> {
  durable: TDurable;
  shared: TShared | null;
}

export function catchupPriorityForMode(mode: CatchupMode): number | undefined {
  return mode === 'foreground' ? FOREGROUND_CATCHUP_SYNC_PRIORITY : undefined;
}

async function runCatchupPlane<T extends CatchupPlaneResult>(
  mode: CatchupMode,
  run: (context: CatchupPlaneContext) => Promise<T>,
  options: Pick<CatchupPlanePolicyOptions<T, T>, 'retryDelaysMs' | 'wait'>,
): Promise<T> {
  const context = { priority: catchupPriorityForMode(mode) };
  let result = await run(context);
  if (mode !== 'foreground') return result;

  const retryDelaysMs = options.retryDelaysMs ?? CATCHUP_BACKPRESSURE_RETRY_DELAYS_MS;
  const wait = options.wait ?? ((delayMs: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  }));
  for (const delayMs of retryDelaysMs) {
    if ((result.deferredBackpressure ?? 0) === 0) return result;
    await wait(delayMs);
    result = await run(context);
  }
  return result;
}

/**
 * Canonical foreground/background catch-up policy shared by the in-agent and
 * worker-backed runners. Durable metadata must settle before SWM starts; when
 * only SWM is deferred, retries never refetch the already-completed durable
 * plane.
 */
export async function runCatchupPlanesWithPolicy<
  TDurable extends CatchupPlaneResult,
  TShared extends CatchupPlaneResult,
>(
  options: CatchupPlanePolicyOptions<TDurable, TShared>,
): Promise<CatchupPlanePolicyResult<TDurable, TShared>> {
  const durable = await runCatchupPlane(options.mode, options.syncDurable, options);
  if (!options.includeSharedMemory || (durable.deferredBackpressure ?? 0) > 0) {
    return { durable, shared: null };
  }

  const shared = await runCatchupPlane(options.mode, options.syncSharedMemory, options);
  return { durable, shared };
}
