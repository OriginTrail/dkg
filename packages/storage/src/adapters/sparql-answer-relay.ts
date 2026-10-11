// SPDX-License-Identifier: Apache-2.0

/**
 * The answer to a read whose caller may leave while the answer is being read.
 *
 * A managed Oxigraph read is left running when its caller stops waiting, so the
 * server's answer can still arrive (or be under way) for a caller that has gone.
 * Nothing may be buffered for such a caller: a streamed answer would otherwise
 * keep the server producing, and the client buffering, for the whole client
 * deadline. Only the very start of the answer is worth reading, to see whether
 * the server has finished with the request: a short answer ends inside a small
 * budget, a long one is streaming, and it is cancelled.
 *
 * `relayAnswer` hands the consumer the answer's body through a pull-based relay
 * (one chunk per read the consumer asks for, no read-ahead, nothing held back).
 * That is what lets the relay keep the transport's single reader when the
 * caller leaves in the middle of the body: the consumer's read fails at once
 * with the caller's reason, and the relay carries on from there, discarding.
 * While the caller stays, the relay only forwards.
 */

/** What {@link relayAnswer} hands back. */
export interface RelayedAnswer {
  /** The answer the consumer reads: the transport's status and headers, its body relayed. */
  readonly response: Response;
  /**
   * Call once the consumer has finished or failed. Waits until nothing is
   * reading the transport's body any more (letting go of it when the consumer
   * stopped short and its caller is still there, or waiting for the discard
   * that took over when the caller left) and reports whether the server was
   * seen to reach the clean end of its body: read out by the consumer, or
   * discarded within the budget after the caller left. Anything else (a failed
   * or aborted body, a body cancelled for exceeding the budget or by the
   * consumer) shows nothing about the server. Never rejects.
   */
  finish(): Promise<boolean>;
}

/**
 * Read and throw away the rest of a body, for at most `budgetBytes`. Resolves
 * `true` when the body reached its clean end inside the budget, `false` when it
 * is longer (it is cancelled, which closes the connection) or fails. `first` is
 * a read that has already been made. Nothing is accumulated, and the bytes read
 * are bounded by the budget plus one chunk (the budget is checked per chunk).
 */
async function discardRest(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  budgetBytes: number,
  first?: ReadableStreamReadResult<Uint8Array>,
): Promise<boolean> {
  let discarded = 0;
  try {
    let chunk = first ?? await reader.read();
    for (;;) {
      if (chunk.done) return true;
      discarded += chunk.value.byteLength;
      if (discarded > budgetBytes) {
        await reader.cancel().catch(() => undefined);
        return false;
      }
      chunk = await reader.read();
    }
  } catch {
    return false;
  }
}

/**
 * Relay `response`'s body to a consumer for as long as `callerLeft` has not
 * fired. When it fires (or has fired already) the consumer is failed with its
 * reason and the rest of the body is discarded, up to `discardBudgetBytes`.
 */
export function relayAnswer(
  response: Response,
  callerLeft: AbortSignal,
  discardBudgetBytes: number,
): RelayedAnswer {
  const body = response.body;
  // An answer without a body has nothing to read: the server is done with it.
  if (body === null || body === undefined) return { response, finish: () => Promise.resolve(true) };

  const reader = body.getReader();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let settle!: (serverFinished: boolean) => void;
  const settled = new Promise<boolean>((resolve) => { settle = resolve; });
  let isSettled = false;
  let abandoned = false;
  // A read made for the consumer is pending: it owns the reader until it returns.
  let reading = false;

  const finishWith = (serverFinished: boolean) => {
    isSettled = true;
    callerLeft.removeEventListener('abort', onLeft);
    settle(serverFinished);
  };

  function onLeft() {
    abandoned = true;
    // Fail the consumer's pending and later reads at once, then discard from here.
    controller.error(callerLeft.reason);
    if (!reading) void discardRest(reader, discardBudgetBytes).then(finishWith);
  }

  const relay = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    async pull(c) {
      reading = true;
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        // The transport's body failed, or its request was aborted.
        reading = false;
        finishWith(false);
        if (!abandoned) c.error(error);
        return;
      }
      reading = false;
      if (abandoned) {
        // The caller left while this read was pending: the consumer has been
        // failed already, so this chunk is discarded, and so is the rest.
        finishWith(await discardRest(reader, discardBudgetBytes, chunk));
        return;
      }
      // The consumer let go while this read was pending: nobody wants the chunk.
      if (isSettled) return;
      if (chunk.done) {
        c.close();
        finishWith(true);
        return;
      }
      c.enqueue(chunk.value);
    },
    cancel(reason) {
      // The consumer stopped reading (a size limit, say): let go of the transport.
      finishWith(false);
      return reader.cancel(reason).catch(() => undefined);
    },
  }, { highWaterMark: 0 });

  if (callerLeft.aborted) onLeft();
  else callerLeft.addEventListener('abort', onLeft, { once: true });

  return {
    response: new Response(relay, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    finish() {
      if (!abandoned && !isSettled) {
        // The consumer stopped short with its caller still there: nothing will
        // read the rest of the body, so let go of it.
        finishWith(false);
        void reader.cancel().catch(() => undefined);
      }
      return settled;
    },
  };
}
