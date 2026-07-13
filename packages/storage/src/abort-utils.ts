export function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

export function raceAgainstAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    let listening = false;
    const cleanup = () => {
      if (!listening) return;
      listening = false;
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (reason) => {
        cleanup();
        reject(reason);
      },
    );
    if (signal.aborted) {
      onAbort();
    } else {
      listening = true;
      signal.addEventListener('abort', onAbort, { once: true });
      // Close the check/listen race if the signal aborted while the listener
      // was being attached.
      if (signal.aborted) onAbort();
    }
  });
}
