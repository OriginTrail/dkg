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
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('error', reject);
        },
      );

      // A hard deadline on the whole exchange. `destroy()` here tears down this
      // request's socket only, which is what makes a timed-out write
      // indeterminate rather than silently retryable on a live connection.
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`managed SPARQL request exceeded ${timeoutMs}ms`));
      });
      req.on('error', reject);

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
