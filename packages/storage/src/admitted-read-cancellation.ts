import { composeAbortSignals } from './abortable-store-work-lifecycle.js';

interface ReadDeadline {
  readonly signal: AbortSignal;
  check(): void;
  waitFor<T>(work: Promise<T>): Promise<T>;
}
/** Share the original deadline, while each admitted read can cancel its transport. */
export async function withAdmittedReadCancellation<Context extends ReadDeadline, T>(
  deadline: Context, signal: AbortSignal | undefined, work: (context: Context) => Promise<T>,
): Promise<T> {
  const scope = composeAbortSignals(deadline.signal, signal === deadline.signal ? undefined : signal);
  const check = () => { deadline.check(); scope.signal!.throwIfAborted(); };
  const waitFor = async <R>(pending: Promise<R>): Promise<R> => {
    try { return await deadline.waitFor(pending); }
    finally { check(); }
  };
  try {
    check();
    const result = await work({ ...deadline, signal: scope.signal!, check, waitFor });
    check();
    return result;
  } finally { scope.dispose(); }
}
