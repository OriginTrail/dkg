import type { IncomingMessage, ServerResponse } from 'node:http';
import { SignedAuthPending, verifyHttpSignedRequestAfterBody } from './auth.js';

/**
 * response-level
 * fail-closed enforcement for body-carrying signed requests.
 *
 * When `httpAuthGuard` stashes `__dkgSignedAuth` for a signed request
 * whose body has not yet been read, the HMAC is verified lazily via
 * `readBody*()` → `enforceSignedRequestPostBody`. Routes that ignore
 * the body (refresh / revoke / fire-and-forget endpoints) never
 * trigger the lazy check, so the request is accepted on the bearer
 * token alone — any `x-dkg-signature` (fresh, stale, or forged)
 * slips through. The original only closed the explicit
 * `Content-Length: 0` path; chunked empty bodies and non-chunked
 * bodies on non-reading routes remained exploitable.
 *
 * We install a one-shot guard on `res.writeHead` / `res.end` that
 * checks `__dkgSignedAuth.verified` at response time. If the flag
 * is still false we rewrite the response to `401 Unauthorized` —
 * the route handler never sees its intended response emitted to
 * the client. Routes that correctly read the body hit
 * `enforceSignedRequestPostBody` first and flip `verified = true`,
 * making the guard a pass-through on the first response call.
 *
 * Implementation note: we also hook `res.end(null)` / `res.end()` to
 * catch streaming responses, and mark the guard as "spent" so the
 * wrappers don't recurse when we ourselves call writeHead/end to
 * emit the 401 response.
 *
 * This function now ALSO drives
 * the eager pre-handler drain. The bot pointed out that the
 * response-time guard alone is insufficient: it rewrites the
 * response to 401, but the handler has already run and any
 * state-mutating side effect has already happened on a forged
 * signature. The fix is to also kick off a body drain + HMAC verify
 * BEFORE returning, returning a `Promise<boolean>` that callers MUST
 * `await` so the route handler does not run until the signature is
 * confirmed.
 *
 * Both the eager drain and the response wrappers share the captured
 * `origWriteHead` / `origEnd` and the queue, so the failure 401 is
 * emitted cleanly through the unwrapped methods AND the queued
 * handler emissions are dropped (failure) or replayed (success)
 * without races. On success, the buffered body is stashed on
 * `req.__dkgPrebufferedBody` so daemon body readers can resolve
 * without re-attaching listeners on an exhausted stream.
 */
export function installSignedRequestResponseGuard(
  req: IncomingMessage,
  res: ServerResponse,
  corsOrigin?: string,
): Promise<boolean> {
  type GuardedRes = ServerResponse & {
    __dkgSignedAuthGuardInstalled?: boolean;
    __dkgSignedAuthEagerDrainPromise?: Promise<boolean>;
  };
  const guarded = res as GuardedRes;
  if (guarded.__dkgSignedAuthGuardInstalled) {
    // Idempotence: a second `httpAuthGuard` call (or a legacy caller
    // that triggers the guard install path twice) returns the SAME
    // eager-drain Promise so awaiters never see two competing drain
    // outcomes for the same request.
    return (
      guarded.__dkgSignedAuthEagerDrainPromise ?? Promise.resolve(true)
    );
  }
  guarded.__dkgSignedAuthGuardInstalled = true;

  const origWriteHead = res.writeHead.bind(res) as typeof res.writeHead;
  const origEnd = res.end.bind(res) as typeof res.end;
  // a handler can leak
  // response bytes through `res.write()` (which auto-flushes implicit
  // headers on first call) or via the explicit `res.flushHeaders()`,
  // before the deferred HMAC verification flips `pending.verified`.
  // Bind the originals so we can safely replay them after verification.
  const origWrite = res.write.bind(res) as typeof res.write;
  const origFlushHeaders = (res as ServerResponse & { flushHeaders?: () => void }).flushHeaders
    ? ((res as ServerResponse & { flushHeaders: () => void }).flushHeaders.bind(res) as () => void)
    : undefined;
  // `spent === true` means we already rewrote the response to 401;
  // every subsequent writeHead/end call from the original handler
  // collapses to a silent no-op so we never get an ERR_STREAM_WRITE_
  // AFTER_END from Node when the handler drains its intended success
  // payload into a socket we've already closed.
  let spent = false;

  // Legitimate clients can send a
  // signed request with `Transfer-Encoding: chunked` + an immediately-
  // terminating body (`0\r\n\r\n`) — for example a refresh/revoke POST
  // whose semantics don't need a payload but whose framing still opts
  // into chunked transfer. The handler for such routes correctly
  // ignores the body. Before r25-2 that combination would hit the
  // fail-closed arm below and emit 401, because `pending.verified`
  // is only flipped by `enforceSignedRequestPostBody`, which needs
  // the handler to explicitly call `readBody*()`.
  //
  // Fix: if the handler emits a response without verifying the
  // HMAC, DEFER its response while we drain whatever body remains
  // on the wire, then finish the verification ourselves and either
  //   (a) replay the handler's intended response on success, or
  //   (b) rewrite it to 401 on any failure.
  //
  // The drain is bounded by `MAX_BODY_BYTES` so a signed request
  // with a never-ending chunked body can't keep us in the
  // reader loop forever. We explicitly DO NOT resume until
  // verification is required, so body-carrying handlers that
  // call `readBody*()` themselves continue to take the
  // synchronous verification path in `enforceSignedRequestPostBody`
  // and the guard collapses into a transparent pass-through.
  const MAX_DRAIN_BYTES = 10 * 1024 * 1024;
  let drainedChunks: Buffer[] = [];
  let drainedBytes = 0;
  let drainAttached = false;
  let drainOverflow = false;

  const attachDrainListeners = (): void => {
    if (drainAttached) return;
    drainAttached = true;
    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      drainedBytes += buf.length;
      if (drainedBytes > MAX_DRAIN_BYTES) {
        drainOverflow = true;
        drainedChunks = [];
        return;
      }
      if (!drainOverflow) drainedChunks.push(buf);
    };
    (req as IncomingMessage).on('data', onData);
  };

  // auth.ts:1202). The previous
  // implementation relied solely on the request emitting `end`/`close`/
  // `error` to resolve the wait. Under chunked Transfer-Encoding a
  // misbehaving / malicious client can send an incomplete chunked body
  // (e.g. an open chunk extension or never-arriving terminating
  // `0\r\n\r\n`) and stay silent forever. The wait would then never
  // resolve, the handler's response would stay queued in `queue[]`
  // forever, and the socket / FD / queued response object would all
  // remain pinned — a slowloris / FD-exhaustion vector against any
  // signed route that ignores the body.
  //
  // Fix: race the natural-end resolution against an explicit
  // `SIGNED_REQUEST_DRAIN_TIMEOUT_MS` deadline. On expiry we destroy
  // the request (releasing the socket) and the surrounding
  // `deferAndResolve` calls `failClosed` so the queued response is
  // rewritten to a 401. The default budget of 30s is generous for
  // legitimate clients on slow links but tight enough to bound any
  // single misbehaving connection's hold on a worker / socket.
  const SIGNED_REQUEST_DRAIN_TIMEOUT_MS = (() => {
    const raw = process.env.DKG_SIGNED_REQUEST_DRAIN_TIMEOUT_MS;
    if (typeof raw === 'string' && raw.length > 0) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 30_000;
  })();

  const waitForRequestEnd = (): Promise<{ timedOut: boolean }> =>
    new Promise((resolve) => {
      const reqAny = req as IncomingMessage & { complete?: boolean; readableEnded?: boolean };
      // — auth.ts:1205). The previous
      // fast-path `(complete || readableEnded)` was UNSAFE.
      // `req.complete === true` only means Node's HTTP parser has
      // finished reading the body off the socket — buffered body
      // bytes may still be sitting in the IncomingMessage's internal
      // read buffer waiting for `resume()` (or a `read()` call) to
      // flow them through `data` listeners. Resolving here without
      // calling `resume()` left `drainedChunks` empty and the
      // surrounding `Buffer.concat(drainedChunks)` bound the HMAC to
      // an EMPTY string — which re-opened the body-binding bypass
      // for signed POST/PUT routes whose handler ignores the body.
      //
      // Only `readableEnded === true` is a safe fast-path: it means
      // the 'end' event has ALREADY been emitted, which (per Node
      // stream contract) requires the consumer to have read all
      // buffered bytes. `attachDrainListeners()` ran synchronously
      // before this Promise was constructed, so any buffered bytes
      // were captured in `drainedChunks` before `end` fired.
      //
      // For the `complete && !readableEnded` case we fall through
      // and call `resume()` so the buffered data flushes through our
      // `data` listener and we then await `end`.
      if (reqAny.readableEnded) { resolve({ timedOut: false }); return; }

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (timedOut: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        // auth.ts:1202). DO NOT
        // destroy the request stream here. The caller (`deferAndResolve`)
        // needs the socket alive for the `failClosed` 401 write to
        // reach the wire. The caller is responsible for tearing down
        // the request AFTER the response has been emitted.
        resolve({ timedOut });
      };
      const done = (): void => finish(false);
      req.once('end', done);
      req.once('close', done);
      req.once('error', done);
      timer = setTimeout(() => finish(true), SIGNED_REQUEST_DRAIN_TIMEOUT_MS);
      // Allow the process to exit even if a stuck request is mid-wait.
      if (typeof (timer as { unref?: () => unknown }).unref === 'function') {
        (timer as { unref: () => unknown }).unref();
      }
      req.resume();
    });

  // After failClosed has written the
  // 401, tear down the request stream so the socket is released. This
  // is what actually closes the slowloris hold — the response is
  // already on the wire by the time we do this.
  const destroyStuckRequest = (): void => {
    try {
      (req as IncomingMessage).destroy(new Error('signed-request body drain timed out'));
    } catch {
      // ignore — best-effort socket teardown.
    }
  };

  // the prior check
  //   `req.complete || req.readableEnded` && `drainedBytes === 0`
  // was wrong — `req.complete` only means "Node finished parsing" and
  // `drainedBytes === 0` only means "we have not attached our drain
  // listeners yet", neither of which is evidence that the wire body
  // was zero-length. A chunked-or-CL>0 request whose body had been
  // fully buffered into the socket but never read by the handler would
  // pass this gate and bind the HMAC to an empty string, accepting
  // tampered bodies.
  //
  // Fix: gate the passive path on the request *framing* declared by
  // the client. Only short-circuit when the headers prove the request
  // is body-less (Content-Length: 0, OR no Content-Length and no
  // Transfer-Encoding — RFC 9112 §6.1: a non-chunked request with no
  // Content-Length has no body). `Transfer-Encoding: chunked` is
  // unconditionally rejected here because we cannot tell from the
  // headers alone whether the chunks were empty; that case MUST flow
  // through the deferred `attachDrainListeners` → `waitForRequestEnd`
  // path so the HMAC is bound to whatever bytes actually arrived.
  const isFramingBodylessByHeaders = (): boolean => {
    const headers = req.headers ?? {};
    const teRaw = headers['transfer-encoding'];
    const teHeader = Array.isArray(teRaw) ? teRaw.join(', ') : (teRaw ?? '');
    if (/chunked/i.test(teHeader)) return false;
    const clRaw = headers['content-length'];
    const clHeader = Array.isArray(clRaw) ? clRaw[0] : clRaw;
    if (typeof clHeader === 'string' && clHeader.length > 0) {
      const n = Number(clHeader);
      return Number.isFinite(n) && n <= 0;
    }
    // No Content-Length and no chunked → semantically bodyless per RFC.
    return true;
  };

  const tryPassiveEmptyBodyVerification = (): boolean => {
    const pending = (req as unknown as {
      __dkgSignedAuth?: SignedAuthPending & { verified?: boolean };
    }).__dkgSignedAuth;
    if (!pending || pending.verified) return true;
    if (!isFramingBodylessByHeaders()) return false;
    if (drainedBytes !== 0) return false;
    const outcome = verifyHttpSignedRequestAfterBody(req, '');
    if (!outcome.ok) return false;
    pending.verified = true;
    return true;
  };

  const failClosed = (reason = 'HMAC verification never completed (handler did not read request body)'): void => {
    spent = true;
    try {
      origWriteHead.call(res, 401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="dkg-node"',
        'Access-Control-Allow-Origin': corsOrigin ?? '*',
      });
      (origEnd as (chunk?: string) => ServerResponse)(
        JSON.stringify({ error: `Signed request rejected: ${reason}` }),
      );
    } catch {
      // res already destroyed — nothing else we can do.
    }
  };

  // A queued writeHead / write / end / flushHeaders emission whose
  // fate depends on the async drain-and-verify. We replay them in the
  // exact order the handler emitted them so the status arrives before
  // the payload, preserving the semantics the handler intended.
  //
  // the queue now also holds `write`
  // chunks and `flushHeaders` markers — those used to bypass the guard
  // entirely and stream response bytes to the wire while the HMAC was
  // still unverified.
  type Queued =
    | { kind: 'writeHead'; args: Parameters<ServerResponse['writeHead']> }
    | { kind: 'write'; args: Parameters<ServerResponse['write']> }
    | { kind: 'end'; args: Parameters<ServerResponse['end']> }
    | { kind: 'flushHeaders' };
  const queue: Queued[] = [];

  const flushQueue = (): void => {
    for (const q of queue) {
      try {
        if (q.kind === 'writeHead') origWriteHead(...q.args);
        else if (q.kind === 'write') origWrite(...q.args);
        else if (q.kind === 'flushHeaders') {
          if (origFlushHeaders) origFlushHeaders();
        } else origEnd(...q.args);
      } catch {
        // res destroyed mid-flush; give up gracefully.
      }
    }
    queue.length = 0;
  };

  let deferred = false;
  const deferAndResolve = (): void => {
    if (deferred) return;
    deferred = true;
    void (async () => {
      try {
        // When the eager drain
        // (kicked off synchronously inside `httpAuthGuard` for the
        // body-carrying signed-request branch) is in flight or has
        // already completed, await its outcome instead of attaching
        // OUR own data listener. Two reasons:
        //
        //   1. Race-freedom. Two concurrent drain listeners would
        //      both observe each chunk, but only the first one to
        //      see `'end'` fire its 'end' handler synchronously sets
        //      `pending.verified`. A late listener would observe an
        //      empty buffer (`Buffer.concat([])`) and fail HMAC
        //      verification against a body that already verified —
        //      a spurious 401 for a legitimate signed request.
        //
        //   2. Single-source-of-truth. The eager drain stashes the
        //      body on `req.__dkgPrebufferedBody` so daemon body
        //      readers don't re-attach listeners on an exhausted
        //      stream. The response guard would otherwise need its
        //      own copy of the same buffer.
        const eagerExtras = req as IncomingMessage & {
          __dkgEagerDrainPromise?: Promise<boolean>;
        };
        if (eagerExtras.__dkgEagerDrainPromise) {
          const ok = await eagerExtras.__dkgEagerDrainPromise;
          if (!ok) {
            // The eager drain has already emitted its own 401 (with
            // a precise reason). Mark the response guard spent so
            // any further writeHead/end/write/flushHeaders from the
            // handler collapses into a no-op instead of trampling
            // the in-flight 401.
            spent = true;
            return;
          }
          // pending.verified is now true (set by the eager drain) —
          // flush the queued handler emissions intact.
          flushQueue();
          return;
        }

        // No eager drain ran (legacy non-signed-mode call site, or a
        // unit-test that exercises the response guard directly). Fall
        // back to the response-guard's own drain.
        attachDrainListeners();
        const waitOutcome = await waitForRequestEnd();
        if (waitOutcome.timedOut) {
          // auth.ts:1202). A signed
          // request whose body never finishes arriving (e.g. chunked
          // framing held open by a slowloris attacker) used to keep
          // the queued response and the socket pinned indefinitely.
          // We now fail-closed on the explicit drain deadline AND
          // proactively tear down the still-open request stream so the
          // socket is released back to the OS even if the client never
          // sends `end`.
          failClosed('signed request body drain timed out');
          destroyStuckRequest();
          return;
        }
        if (drainOverflow) { failClosed('request body exceeded maximum drain size'); return; }
        const body = Buffer.concat(drainedChunks);
        const outcome = verifyHttpSignedRequestAfterBody(req, body);
        if (!outcome.ok) { failClosed(outcome.reason); return; }
        const pending = (req as unknown as {
          __dkgSignedAuth?: SignedAuthPending & { verified?: boolean };
        }).__dkgSignedAuth;
        if (pending) pending.verified = true;
        flushQueue();
      } catch {
        failClosed('verification failed');
      }
    })();
  };

  const pending = (): SignedAuthPending & { verified?: boolean } | undefined =>
    (req as unknown as {
      __dkgSignedAuth?: SignedAuthPending & { verified?: boolean };
    }).__dkgSignedAuth;

  (res as ServerResponse).writeHead = ((...args: Parameters<ServerResponse['writeHead']>) => {
    if (spent) return res;
    const p = pending();
    if (!p || p.verified) return origWriteHead(...args);
    // Try the cheap path first: chunked empty bodies that have
    // already been parsed by Node by the time the handler emits
    // writeHead fall through here (complete && observed 0 bytes).
    if (tryPassiveEmptyBodyVerification()) return origWriteHead(...args);
    // Otherwise queue this writeHead and kick off the async
    // drain-and-verify. The queued call is replayed once the
    // signature has been confirmed against whatever the wire
    // actually delivered.
    queue.push({ kind: 'writeHead', args });
    deferAndResolve();
    return res;
  }) as ServerResponse['writeHead'];

  (res as ServerResponse).end = ((...args: Parameters<ServerResponse['end']>) => {
    if (spent) return res;
    const p = pending();
    if (!p || p.verified) return origEnd(...args);
    if (tryPassiveEmptyBodyVerification()) return origEnd(...args);
    queue.push({ kind: 'end', args });
    deferAndResolve();
    return res;
  }) as ServerResponse['end'];

  // also wrap `write` so streaming response bytes
  // cannot be flushed to the wire ahead of HMAC verification. Node will
  // implicitly call `writeHead(200)` on the first `write()` call if the
  // handler did not call it explicitly, so wrapping `write` is what
  // physically prevents the data leak.
  (res as ServerResponse).write = ((...args: Parameters<ServerResponse['write']>) => {
    if (spent) return false;
    const p = pending();
    if (!p || p.verified) return origWrite(...args);
    if (tryPassiveEmptyBodyVerification()) return origWrite(...args);
    queue.push({ kind: 'write', args });
    deferAndResolve();
    return true;
  }) as ServerResponse['write'];

  if (origFlushHeaders) {
    (res as ServerResponse & { flushHeaders: () => void }).flushHeaders = (() => {
      if (spent) return;
      const p = pending();
      if (!p || p.verified) {
        origFlushHeaders();
        return;
      }
      if (tryPassiveEmptyBodyVerification()) {
        origFlushHeaders();
        return;
      }
      queue.push({ kind: 'flushHeaders' });
      deferAndResolve();
    }) as () => void;
  }

  // Kick off the eager pre-handler drain
  // and HMAC verification. The returned Promise is what
  // `httpAuthGuard` returns (and what the daemon `await`s) — until
  // it resolves, the route handler does NOT run, so any
  // state-mutating side effect on a forged signature is impossible.
  //
  // We share the captured `origWriteHead` / `origEnd` (so the 401
  // failure path is emitted through the unwrapped methods, not the
  // queue-wrappers we just installed) AND the queue + spent flag
  // (so a non-awaiting legacy caller's interleaved handler
  // emissions are either flushed on success or dropped on failure
  // without races).
  //
  // Stash the body Buffer on `req.__dkgPrebufferedBody` on success
  // so daemon body readers (`readBody` / `readBodyBuffer`) resolve
  // from the buffer rather than re-attaching listeners on a stream
  // we have already exhausted.
  type EagerExtras = {
    __dkgPrebufferedBody?: Buffer;
  };
  const reqExtras = req as IncomingMessage & EagerExtras;

  const eagerDrainPromise = (async (): Promise<boolean> => {
    try {
      // Fast path: the body is framing-bodyless per the headers AND
      // nothing has arrived on the wire. Bind HMAC to "" and return.
      if (isFramingBodylessByHeaders()) {
        const outcome = verifyHttpSignedRequestAfterBody(req, '');
        if (!outcome.ok) {
          spent = true;
          failClosed(outcome.reason);
          return false;
        }
        const p = pending();
        if (p) p.verified = true;
        reqExtras.__dkgPrebufferedBody = Buffer.alloc(0);
        return true;
      }

      // Body-carrying path: drain bounded, verify, then either
      // succeed (handler will run; queue is empty so flushQueue is
      // a no-op) or fail-close.
      attachDrainListeners();
      const waitOutcome = await waitForRequestEnd();
      if (waitOutcome.timedOut) {
        spent = true;
        failClosed('signed request body drain timed out');
        destroyStuckRequest();
        return false;
      }
      if (drainOverflow) {
        spent = true;
        failClosed('request body exceeded maximum drain size');
        return false;
      }
      const body = Buffer.concat(drainedChunks);
      const outcome = verifyHttpSignedRequestAfterBody(req, body);
      if (!outcome.ok) {
        spent = true;
        failClosed(outcome.reason);
        return false;
      }
      const p = pending();
      if (p) p.verified = true;
      reqExtras.__dkgPrebufferedBody = body;
      // If a non-awaiting caller's handler already queued
      // emissions while we were draining, replay them now.
      flushQueue();
      return true;
    } catch {
      spent = true;
      failClosed('verification failed');
      return false;
    }
  })();

  guarded.__dkgSignedAuthEagerDrainPromise = eagerDrainPromise;
  return eagerDrainPromise;
}
