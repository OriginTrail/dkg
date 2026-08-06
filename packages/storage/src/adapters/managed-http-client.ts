import { Agent, request as httpRequest, type IncomingMessage } from 'node:http';

/**
 * A connection pool the managed lane actually OWNS (#2052 Stack B2).
 *
 * `SparqlHttpStore` dispatches through the global `fetch`, whose sockets belong
 * to Node's process-wide dispatcher and are shared with every other consumer in
 * the process. That is fine for ordinary traffic, but it makes one requirement
 * of the system-record lane unimplementable: before binding a replacement child,
 * recovery must DESTROY the retired generation's client and prove no request
 * issued against it can still reach a listener. You cannot destroy a pool you do
 * not own, and you must not destroy a pool everyone else is using.
 *
 * So the managed write path gets its own `http.Agent`. `destroy()` closes every
 * socket that agent owns — sockets that, by construction, only this generation
 * ever used. That turns "the old client is gone" from an assumption into a
 * fact the supervisor can assert.
 *
 * `node:http` rather than `undici`: undici is not a dependency of this monorepo
 * and does not resolve, while `http.Agent` is built in, gives synchronous
 * `destroy()` semantics, and exposes live socket counts for the leak assertions
 * the live conformance gate needs. The managed endpoint is always loopback
 * (`127.0.0.1`), so there is no TLS or HTTP/2 requirement to trade away.
 */

export interface ManagedHttpResponse {
  readonly status: number;
  readonly body: string;
}

export class OwnedManagedHttpClient {
  private readonly agent: Agent;
  private destroyed = false;
  /** Requests issued against THIS client that have not settled yet. */
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly generation: string) {
    this.agent = new Agent({
      keepAlive: true,
      // One socket: the materializer's write concurrency is pinned to 1 by
      // SYSTEM_RECORD_MAX_MATERIALIZER_WRITE_CONCURRENCY, so a larger pool
      // would only widen the set of sockets recovery has to prove dead.
      maxSockets: 1,
      maxFreeSockets: 1,
    });
  }

  get childGeneration(): string {
    return this.generation;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Live socket count, for leak assertions in the live conformance gate. */
  get openSocketCount(): number {
    const count = (buckets: NodeJS.ReadOnlyDict<unknown[]>): number =>
      Object.values(buckets).reduce<number>((total, list) => total + (list?.length ?? 0), 0);
    return (
      count(this.agent.sockets as NodeJS.ReadOnlyDict<unknown[]>) +
      count(this.agent.freeSockets as NodeJS.ReadOnlyDict<unknown[]>)
    );
  }

  /**
   * POST a SPARQL body.
   *
   * Rejects immediately once destroyed, so a request that raced a generation
   * change can never open a socket against a replacement listener.
   */
  async post(
    url: string,
    contentType: string,
    body: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ManagedHttpResponse> {
    if (this.destroyed) {
      throw new Error(
        `managed HTTP client for child generation ${this.generation} is destroyed`,
      );
    }

    const work = this.dispatch(url, contentType, body, timeoutMs, signal);
    this.inflight.add(work);
    try {
      return await work;
    } finally {
      this.inflight.delete(work);
    }
  }

  private dispatch(
    url: string,
    contentType: string,
    body: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ManagedHttpResponse> {
    return new Promise<ManagedHttpResponse>((resolve, reject) => {
      const payload = Buffer.from(body, 'utf8');

      /**
       * Wall-clock deadline over the WHOLE call, armed before the request is
       * even created.
       *
       * `req.setTimeout()` alone is not sufficient and quietly under-enforces:
       * it bounds socket-ACTIVE time, so a request queued behind a busy socket
       * is not counted at all. With `maxSockets: 1` that is not a corner case —
       * a second concurrent call waits for the first to finish. Measured before
       * this guard existed: a call with a 500 ms timeout resolved SUCCESSFULLY
       * after 3822 ms.
       *
       * That is the dangerous shape of the bug. It does not fail loudly, it
       * silently returns success far outside the deadline the caller was
       * promised — blowing the 1,000 ms apply bound and the three-second slice
       * while looking healthy. The system-record lane treats its apply timeout
       * as a SAFETY bound, so it has to cover queue wait too.
       */
      let request: ReturnType<typeof httpRequest> | undefined;
      let settled = false;
      const deadline = setTimeout(() => {
        const expiry = new Error(`managed SPARQL request exceeded ${timeoutMs}ms`);
        // Settle FIRST, then tear down. Destroying a request that has not yet
        // been assigned a socket does not emit `error` until one arrives, so
        // relying on the teardown to reject leaves the caller blocked long past
        // its deadline: measured 3825 ms for a 500 ms timeout, with the right
        // error message and the wrong latency. The deadline must bound when the
        // CALLER is released, not merely when we start cleaning up.
        fail(expiry);
        request?.destroy(expiry);
      }, timeoutMs);
      const succeed = (value: ManagedHttpResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(value);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(error);
      };

      const req = httpRequest(
        url,
        {
          method: 'POST',
          agent: this.agent,
          headers: {
            'Content-Type': contentType,
            'Content-Length': payload.byteLength,
          },
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            succeed({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('error', fail);
        },
      );
      request = req;

      // Socket-level idle timeout, kept ALONGSIDE the wall-clock deadline
      // above rather than instead of it: this one detects a connection that
      // has gone quiet mid-exchange, while the deadline bounds the total call
      // including time spent waiting for a socket. `destroy()` tears down only
      // this request's socket, which is what makes a timed-out write
      // indeterminate rather than silently retryable on a live connection.
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`managed SPARQL request exceeded ${timeoutMs}ms`));
      });
      req.on('error', fail);

      const onAbort = () => req.destroy(new Error('managed SPARQL request aborted'));
      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error('managed SPARQL request aborted'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => signal.removeEventListener('abort', onAbort));
      }

      req.end(payload);
    });
  }

  /**
   * Destroy this generation's pool, await every request issued against it, and
   * PROVE the sockets are actually gone.
   *
   * Settlement is awaited rather than merely requested: an outstanding promise
   * that has not settled is precisely the state in which a late response could
   * still be attributed to the wrong child. Rejections are absorbed because a
   * destroyed socket makes its request fail by design.
   *
   * The socket poll is not defensive padding — it is the difference between
   * "destroy was called" and "no socket from this generation can carry a byte".
   * `Agent.destroy()` tears sockets down ASYNCHRONOUSLY: they leave the agent's
   * `sockets`/`freeSockets` maps on their `close` event, one turn of the loop
   * later at the earliest. The live conformance gate caught exactly this,
   * reporting one live socket immediately after destroy. Returning there would
   * have let a replacement child bind while a retired keep-alive socket was
   * still open, which is the precise stale-generation window the whole design
   * exists to close.
   *
   * Failure to reach zero within the bound is TERMINAL rather than retried: if
   * a socket will not close we cannot assert the old writer is gone, and the
   * caller must fail closed instead of binding a replacement.
   */
  async destroyAndSettle(timeoutMs = 5_000): Promise<void> {
    this.destroyed = true;
    await Promise.allSettled([...this.inflight]);
    this.agent.destroy();

    const deadline = Date.now() + timeoutMs;
    while (this.openSocketCount > 0) {
      if (Date.now() > deadline) {
        throw new Error(
          `managed HTTP client for child generation ${this.generation} still holds ` +
            `${this.openSocketCount} socket(s) ${timeoutMs}ms after destroy; ` +
            'the retired generation cannot be proven dead',
        );
      }
      await new Promise((r) => setTimeout(r, 10));
      // Re-destroy is idempotent and reaps sockets that became free after the
      // first call (a response that completed while we were waiting).
      this.agent.destroy();
    }
  }
}
