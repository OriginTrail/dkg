/** Blazegraph read-only transaction lifecycle. The transaction is released on every exit. */
export async function withBlazegraphReadSnapshot<T>(
  sparqlUrl: string,
  timeoutMs: number,
  read: (transactionId: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const endpoint = new URL(sparqlUrl);
  const basePath = endpoint.pathname.replace(/(?:\/namespace\/[^/]+)?\/sparql\/?$/, '');
  if (basePath === endpoint.pathname) throw new Error('Blazegraph snapshot requires a SPARQL endpoint URL');
  endpoint.pathname = `${basePath}/tx`;
  endpoint.search = 'timestamp=-1';
  const beginSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const begin = await fetch(endpoint.toString(), { method: 'POST', signal: beginSignal });
  if (begin.status !== 201) throw new Error(`Blazegraph read snapshot creation failed (${begin.status})`);

  // Location is available as soon as the server has created the transaction.
  // Body parsing can fail or be aborted, so register its cleanup first.
  let transactionId = begin.headers.get('Location')?.match(/\/tx\/(-?\d+)(?:\?|$)/)?.[1];
  let readSucceeded = false;
  let result!: T;
  let releaseFailure: unknown;
  try {
    const body = await begin.text();
    transactionId ??= body.match(/\btxId="(-?\d+)"/)?.[1];
    if (!transactionId) throw new Error('Blazegraph did not return a snapshot transaction ID');
    if (body.match(/\breadOnly="(true|false)"/)?.[1] !== 'true') {
      throw new Error('Blazegraph did not return a read-only snapshot transaction');
    }
    result = await read(transactionId);
    readSucceeded = true;
  } finally {
    if (transactionId) {
      endpoint.pathname = `${basePath}/tx/${transactionId}`;
      endpoint.search = 'ABORT';
      try {
        const end = await fetch(endpoint.toString(), {
          method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        });
        if (end.status !== 200) releaseFailure = new Error(`Blazegraph read snapshot release failed (${end.status})`);
      } catch (error) {
        releaseFailure = error;
      }
      if (releaseFailure && !readSucceeded) {
        try {
          console.warn('Blazegraph read snapshot release failed after read error', releaseFailure);
        } catch {
          // Diagnostics must not replace the original read failure.
        }
      }
    }
  }
  if (releaseFailure) throw releaseFailure;
  return result;
}
