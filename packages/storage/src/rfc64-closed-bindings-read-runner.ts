import {
  composeAbortSignals,
  raceStoreWorkAgainstAbort,
} from './abortable-store-work-lifecycle.js';
import { snapshotExactOrdinaryDataRecord } from './closed-data-snapshot.js';

export interface Rfc64ClosedBindingsReadOptionsV1 {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export function snapshotRfc64ClosedBindingsReadOptionsV1(
  input: unknown,
  maxTimeoutMs: number,
  label: string,
  invalid: (message: string, cause?: unknown) => never,
): Rfc64ClosedBindingsReadOptionsV1 {
  let options: Readonly<Record<string, unknown>>;
  try {
    options = snapshotExactOrdinaryDataRecord(
      input,
      hasOwnKey(input, 'signal') ? ['signal', 'timeoutMs'] : ['timeoutMs'],
      label,
      (message) => { throw new Error(message); },
    );
  } catch (cause) {
    invalid(`${label} has an invalid field set`, cause);
  }
  if (
    typeof options.timeoutMs !== 'number'
    || !Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 1
    || options.timeoutMs > maxTimeoutMs
  ) {
    invalid(`timeoutMs must be an integer from 1 to ${maxTimeoutMs}`);
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    invalid('signal must be an AbortSignal');
  }
  return Object.freeze({
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }) as Rfc64ClosedBindingsReadOptionsV1;
}

interface Rfc64ClosedBindingsReadRunV1<TRow, TDecoded> {
  readonly options: Rfc64ClosedBindingsReadOptionsV1;
  readonly deadlineLabel: string;
  readonly dispatch: (signal: AbortSignal | undefined) => Promise<readonly TRow[]>;
  readonly decode: (rows: readonly TRow[]) => TDecoded;
}

/** One shared cancellation/deadline lifecycle for all closed bindings reads. */
export async function runRfc64ClosedBindingsReadV1<TRow, TDecoded>(
  run: Rfc64ClosedBindingsReadRunV1<TRow, TDecoded>,
): Promise<TDecoded | undefined> {
  const deadlineAt = performance.now() + run.options.timeoutMs;
  const deadlineSignal = AbortSignal.timeout(run.options.timeoutMs);
  const signalScope = composeAbortSignals(run.options.signal, deadlineSignal);
  try {
    assertBeforeDeadline(signalScope.signal, deadlineAt, run.deadlineLabel);
    let rows: readonly TRow[];
    try {
      rows = await raceStoreWorkAgainstAbort(
        run.dispatch(signalScope.signal),
        signalScope.signal,
      );
    } catch (cause) {
      // A synchronous embedded adapter can block the event loop beyond the
      // deadline and then reject before AbortSignal.timeout dispatches. Apply
      // the same monotonic deadline fence to the rejection path so backend
      // errors cannot escape after the caller-visible bound.
      assertBeforeDeadline(signalScope.signal, deadlineAt, run.deadlineLabel);
      throw cause;
    }
    assertBeforeDeadline(signalScope.signal, deadlineAt, run.deadlineLabel);
    if (rows.length === 0) return undefined;
    const decoded = run.decode(rows);
    assertBeforeDeadline(signalScope.signal, deadlineAt, run.deadlineLabel);
    return decoded;
  } finally {
    signalScope.dispose();
  }
}

function hasOwnKey(input: unknown, key: string): boolean {
  return input !== null
    && typeof input === 'object'
    && Object.prototype.hasOwnProperty.call(input, key);
}

function assertBeforeDeadline(
  signal: AbortSignal | undefined,
  deadlineAt: number,
  label: string,
): void {
  signal?.throwIfAborted();
  if (performance.now() >= deadlineAt) {
    throw new DOMException(`${label} deadline exceeded`, 'TimeoutError');
  }
}
