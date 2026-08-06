import { Agent, request as httpRequest, type IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import {
  SYSTEM_RECORD_MAX_MATERIALIZER_WRITE_CONCURRENCY,
} from '@origintrail-official/dkg-core/system-record-v1';

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
  /** Internal accountant hook installed by the atomic executor wrapper. */
  readonly replaceRetainedBytes?: (bytes: number) => void;
}

/**
 * Per-call body limits for the managed materializer transport.
 *
 * They are optional on `post()` only to preserve the B2 caller while the B3
 * transaction executor is introduced. A caller that supplies limits must
 * supply both: silently bounding only one direction would leave the other
 * allocation unbounded while making the call look protected.
 */
export interface ManagedHttpBodyLimits {
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  /**
   * Called before the transport allocates or grows its bounded encoded response
   * buffer. The argument is the new total buffer capacity, not a delta.
   */
  readonly reserveResponseCapacity?: (capacityBytes: number) => void;
}

interface ManagedHttpDispatchV1 {
  readonly result: Promise<ManagedHttpResponse>;
  readonly physicalSettlement: Promise<void>;
}

function assertByteLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

const INITIAL_CHUNKED_RESPONSE_CAPACITY = 64 * 1024;

function boundedResponseCapacity(current: number, required: number, maximum: number): number {
  if (required > maximum) {
    throw new Error(`managed SPARQL response body exceeded ${maximum} bytes`);
  }
  if (current >= required) return current;
  const doubled = current === 0
    ? Math.min(INITIAL_CHUNKED_RESPONSE_CAPACITY, maximum)
    : current > Math.floor(maximum / 2) ? maximum : current * 2;
  return Math.min(maximum, Math.max(required, doubled));
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
      // Imported, not restated. The comment above cites this frozen limit as
      // the justification for the pool size, so hardcoding `1` would let a
      // future bump leave the pool pinned at one with a comment still claiming
      // the two agree.
      maxSockets: SYSTEM_RECORD_MAX_MATERIALIZER_WRITE_CONCURRENCY,
      maxFreeSockets: SYSTEM_RECORD_MAX_MATERIALIZER_WRITE_CONCURRENCY,
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
    limits?: ManagedHttpBodyLimits,
  ): Promise<ManagedHttpResponse> {
    if (this.destroyed) {
      throw new Error(
        `managed HTTP client for child generation ${this.generation} is destroyed`,
      );
    }

    if (limits) {
      assertByteLimit('managed HTTP maxRequestBytes', limits.maxRequestBytes);
      assertByteLimit('managed HTTP maxResponseBytes', limits.maxResponseBytes);
    }
    if (signal?.aborted) {
      throw new Error('managed SPARQL request aborted');
    }

    // Measure the immutable string before Buffer.from() allocates the payload.
    // This is deliberately outside dispatch: a one-byte-over request must not
    // create an HTTP request, enter the Agent queue, or allocate a second copy.
    const requestBytes = Buffer.byteLength(body, 'utf8');
    if (limits && requestBytes > limits.maxRequestBytes) {
      throw new Error(
        `managed SPARQL request body is ${requestBytes} bytes; ` +
          `maximum is ${limits.maxRequestBytes} bytes`,
      );
    }

    const work = this.dispatch(
      url,
      contentType,
      body,
      requestBytes,
      timeoutMs,
      signal,
      limits?.maxResponseBytes,
      limits?.reserveResponseCapacity,
    );
    this.inflight.add(work.physicalSettlement);
    void work.physicalSettlement.then(() => this.inflight.delete(work.physicalSettlement));
    return await work.result;
  }

  private dispatch(
    url: string,
    contentType: string,
    body: string,
    requestBytes: number,
    timeoutMs: number,
    signal?: AbortSignal,
    maxResponseBytes?: number,
    reserveResponseCapacity?: (capacityBytes: number) => void,
  ): ManagedHttpDispatchV1 {
    let settlePhysical!: () => void;
    const physicalSettlement = new Promise<void>((resolve) => {
      settlePhysical = resolve;
    });
    const result = new Promise<ManagedHttpResponse>((resolve, reject) => {
      let payload: Buffer | null = Buffer.from(body, 'utf8');

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
      let response: IncomingMessage | undefined;
      let settled = false;
      let physicalSettled = false;
      let deadline: NodeJS.Timeout | undefined;
      let onAbort: (() => void) | undefined;
      let cleanupResponse = () => undefined;

      const completePhysicalSettlement = () => {
        if (physicalSettled) return;
        physicalSettled = true;
        settlePhysical();
      };

      const cleanupSettlement = () => {
        if (deadline) {
          clearTimeout(deadline);
          deadline = undefined;
        }
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort);
          onAbort = undefined;
        }
      };
      const succeed = (value: ManagedHttpResponse) => {
        if (settled) return;
        settled = true;
        cleanupSettlement();
        payload = null;
        cleanupResponse();
        completePhysicalSettlement();
        resolve(value);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanupSettlement();
        reject(error);
      };

      const terminate = (error: Error) => {
        if (settled) return;
        // Release every owned body reference synchronously, initiate teardown,
        // then settle the caller. The separate physical promise remains in the
        // client-owned set until the request close event proves teardown.
        payload = null;
        cleanupResponse();
        response?.destroy();
        request?.destroy();
        fail(error);
        if (!request) completePhysicalSettlement();
      };

      deadline = setTimeout(
        () => terminate(new Error(`managed SPARQL request exceeded ${timeoutMs}ms`)),
        timeoutMs,
      );

      let req: ReturnType<typeof httpRequest>;
      try {
        req = httpRequest(
          url,
          {
            method: 'POST',
            agent: this.agent,
            headers: {
              'Content-Type': contentType,
              'Content-Length': requestBytes,
            },
          },
          (res: IncomingMessage) => {
            response = res;
            const status = res.statusCode;
            let responseBuffer: Buffer | null = null;
            let responseChunks: Buffer[] | null = maxResponseBytes === undefined ? [] : null;
            let responseBytes = 0;

            const failResponse = (error: Error) => terminate(error);
            const onResponseError = (error: Error) => terminate(error);
            const onResponseAborted = () =>
              terminate(new Error('managed SPARQL response aborted before completion'));
            const onResponseClose = () => {
              if (!res.complete) {
                terminate(new Error('managed SPARQL response closed before completion'));
              }
            };
            const onResponseData = (chunk: Buffer | string) => {
              if (settled) return;
              const encoded = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
              const chunkBytes = encoded.byteLength;
              if (maxResponseBytes !== undefined
                  && chunkBytes > maxResponseBytes - responseBytes) {
                failResponse(
                  new Error(
                    `managed SPARQL response body exceeded ${maxResponseBytes} bytes`,
                  ),
                );
                return;
              }
              if (declaredLength !== undefined && chunkBytes > declaredLength - responseBytes) {
                failResponse(new Error('managed SPARQL response exceeded its Content-Length'));
                return;
              }
              if (maxResponseBytes !== undefined) {
                const requiredCapacity = responseBytes + chunkBytes;
                if (responseBuffer === null || requiredCapacity > responseBuffer.byteLength) {
                  // Content-Length-free responses grow one owned buffer. The
                  // accountant sees the new TOTAL capacity before allocation;
                  // its conservative 3x weighting covers old + new buffers and
                  // the incoming chunk while copying, as well as buffer + final
                  // two-byte-weighted JS string during conversion.
                  const capacity = boundedResponseCapacity(
                    responseBuffer?.byteLength ?? 0,
                    requiredCapacity,
                    maxResponseBytes,
                  );
                  try {
                    reserveResponseCapacity?.(capacity);
                    const grown = Buffer.allocUnsafe(capacity);
                    responseBuffer?.copy(grown, 0, 0, responseBytes);
                    responseBuffer = grown;
                  } catch (cause) {
                    failResponse(new Error('managed SPARQL response buffer growth failed', { cause }));
                    return;
                  }
                }
              }
              if (responseBuffer) encoded.copy(responseBuffer, responseBytes);
              else responseChunks?.push(encoded);
              responseBytes += chunkBytes;
            };
            const onResponseEnd = () => {
              if (settled) return;
              if (declaredLength !== undefined && declaredLength !== responseBytes) {
                terminate(
                  new Error(
                    `managed SPARQL response body received ${responseBytes} bytes; ` +
                      `Content-Length declared ${declaredLength} bytes`,
                  ),
                );
                return;
              }
              try {
                const encoded = maxResponseBytes === undefined
                  ? Buffer.concat(responseChunks ?? [], responseBytes)
                  : responseBuffer ?? Buffer.alloc(0);
                const responseBody = encoded.toString('utf8', 0, responseBytes);
                responseBuffer = null;
                responseChunks = null;
                succeed({ status: status as number, body: responseBody });
              } catch (cause) {
                terminate(new Error('managed SPARQL response conversion failed', { cause }));
              }
            };
            cleanupResponse = () => {
              responseBuffer = null;
              responseChunks = null;
              res.removeListener('error', onResponseError);
              res.removeListener('aborted', onResponseAborted);
              res.removeListener('close', onResponseClose);
              res.removeListener('data', onResponseData);
              res.removeListener('end', onResponseEnd);
            };
            res.on('error', onResponseError);
            res.on('aborted', onResponseAborted);
            res.on('close', onResponseClose);

            if (
              status === undefined ||
              !Number.isSafeInteger(status) ||
              status < 100 ||
              status > 999
            ) {
              failResponse(new Error('managed SPARQL response has an invalid HTTP status'));
              return;
            }

            const contentLengthHeader = res.headers['content-length'];
            let declaredLength: number | undefined;
            if (contentLengthHeader !== undefined) {
              if (
                Array.isArray(contentLengthHeader) ||
                !/^\d+$/.test(contentLengthHeader) ||
                !Number.isSafeInteger(Number(contentLengthHeader))
              ) {
                failResponse(new Error('managed SPARQL response has an invalid Content-Length'));
                return;
              }
              declaredLength = Number(contentLengthHeader);
              if (maxResponseBytes !== undefined && declaredLength > maxResponseBytes) {
                failResponse(
                  new Error(
                    `managed SPARQL response body declares ${declaredLength} bytes; ` +
                      `maximum is ${maxResponseBytes} bytes`,
                  ),
                );
                return;
              }
            }
            if (maxResponseBytes !== undefined && declaredLength !== undefined) {
              // A trustworthy Content-Length can allocate exactly once. Chunked
              // responses grow below as bytes arrive; reserving their whole
              // 4-MiB protocol ceiling here would consume a 12-MiB weighted lease
              // even when the actual body is only a few bytes.
              const capacity = declaredLength;
              try {
                reserveResponseCapacity?.(capacity);
              } catch (cause) {
                failResponse(new Error('managed SPARQL response exceeds its transient byte bound', {
                  cause,
                }));
                return;
              }
              try {
                responseBuffer = Buffer.allocUnsafe(capacity);
              } catch (cause) {
                failResponse(new Error('managed SPARQL response buffer allocation failed', { cause }));
                return;
              }
            }

            res.on('data', onResponseData);
            res.on('end', onResponseEnd);
          },
        );
      } catch (error) {
        payload = null;
        cleanupResponse();
        completePhysicalSettlement();
        fail(error);
        return;
      }
      request = req;
      const onRequestError = (error: Error) => terminate(error);
      req.once('close', completePhysicalSettlement);

      // Socket-level idle timeout, kept ALONGSIDE the wall-clock deadline
      // above rather than instead of it: this one detects a connection that
      // has gone quiet mid-exchange, while the deadline bounds the total call
      // including time spent waiting for a socket. `destroy()` tears down only
      // this request's socket, which is what makes a timed-out write
      // indeterminate rather than silently retryable on a live connection.
      req.setTimeout(timeoutMs, () => {
        terminate(new Error(`managed SPARQL request exceeded ${timeoutMs}ms`));
      });
      req.on('error', onRequestError);

      onAbort = () => terminate(new Error('managed SPARQL request aborted'));
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        req.end(payload);
        payload = null;
      } catch (error) {
        terminate(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return Object.freeze({ result, physicalSettlement });
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
    return this.destroyAndSettleUntil(performance.now() + timeoutMs);
  }

  /**
   * Deadline-sharing form used by lifecycle recovery. The absolute monotonic
   * deadline was minted before child retirement, so socket cleanup consumes
   * the SAME budget as stop/prove, replacement start and exact reconciliation.
   */
  async destroyAndSettleUntil(absoluteDeadlineMs: number): Promise<void> {
    if (!Number.isFinite(absoluteDeadlineMs)) {
      throw new Error('managed HTTP settlement deadline must be finite');
    }
    this.destroyed = true;

    // Destroy BEFORE settling, not after. Destroying the agent tears down
    // in-use sockets, which forces every inflight request to reject promptly;
    // awaiting first meant this method's duration was
    // `max(callerTimeoutMs across inflight) + poll` and the `timeoutMs`
    // parameter did not bound the phase it names. Measured: a caller with a
    // 4 s request made `destroyAndSettle(5000)` take 3831 ms of pure waiting,
    // and with a server dribbling one byte per 100 ms it did not return at all
    // within 8 s, because the socket-inactivity timer kept being reset.
    //
    // That ordering mattered most exactly where it was least visible: this is
    // step 1 of the enable handoff, so a slow or chatty endpoint could stall
    // the transition, leave the seal uncommitted, and hang daemon teardown —
    // on a HEALTHY-looking endpoint rather than a dead one.
    this.agent.destroy();

    // Poll the owned set itself instead of racing a snapshot of its promises.
    // `Promise.race` would return at the deadline while the request promises
    // kept running behind a released lifecycle barrier. Destroy forces each
    // request to settle; this loop joins their `finally` cleanup and the socket
    // close events before reporting success.
    while (this.inflight.size > 0 || this.openSocketCount > 0) {
      if (performance.now() >= absoluteDeadlineMs) {
        throw new Error(
          `managed HTTP client for child generation ${this.generation} still holds ` +
            `${this.openSocketCount} socket(s) and ${this.inflight.size} request(s) after destroy; ` +
            'the retired generation cannot be proven dead',
        );
      }
      const remainingMs = absoluteDeadlineMs - performance.now();
      await new Promise((r) => setTimeout(r, Math.max(1, Math.min(10, remainingMs))));
      // Re-destroy is idempotent and reaps sockets that became free after the
      // first call (a response that completed while we were waiting).
      this.agent.destroy();
    }
  }
}
