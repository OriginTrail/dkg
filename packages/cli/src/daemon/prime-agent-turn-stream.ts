import {
  pipeLocalAgentSseStream,
  writeLocalAgentSseChunk,
  writeLocalAgentSseEvent,
  type LocalAgentSseReader,
  type LocalAgentSseRequest,
  type LocalAgentSseResponse,
  type LocalAgentSseStreamResult,
} from './local-agent-sse.js';

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left.slice();
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}

export type PrimeAgentStreamTurn = {
  text: string;
  finalEvent: Record<string, unknown>;
  errorEvent?: Record<string, unknown>;
};

export type PrimeAgentStreamCommitResult =
  | { ok: true; finalEvent: Record<string, unknown> }
  | { ok: false; errorEvent: Record<string, unknown> };

/**
 * Prime-specific event-dialect adapter layered on the generic SSE transport.
 * Deltas pass through immediately. Prime error/final frames are held while the
 * durable commit is awaited, then released in order; commit failure emits its
 * replacement error and never acknowledges a final frame.
 */
export async function pipePrimeAgentTurnSseStream(
  req: LocalAgentSseRequest,
  res: LocalAgentSseResponse,
  reader: LocalAgentSseReader,
  commit: (turn: PrimeAgentStreamTurn) => Promise<PrimeAgentStreamCommitResult>,
): Promise<LocalAgentSseStreamResult> {
  let text = '';
  let finalEvent: Record<string, unknown> | undefined;
  let errorEvent: Record<string, unknown> | undefined;
  let heldErrorFrame: Uint8Array | undefined;

  const streamed = await pipeLocalAgentSseStream(req, res, reader, {
    endResponseOnTerminal: false,
    onFrame: ({ event, frame, separator }) => {
      if (event?.type === 'delta' && typeof event.text === 'string') {
        text += event.text;
        return { forward: true };
      }
      if (event?.type === 'error') {
        errorEvent = event;
        heldErrorFrame = concatBytes(frame, separator);
        return { forward: false };
      }
      if (event?.type === 'final') {
        if (typeof event.text === 'string') text = event.text;
        finalEvent = event;
        return { forward: false, terminal: true };
      }
      return { forward: true };
    },
  });

  if (!streamed.clientGone && streamed.terminal && finalEvent) {
    const committed = await commit({ text, finalEvent, errorEvent });
    if (committed.ok) {
      if (heldErrorFrame && !res.writableEnded) {
        await writeLocalAgentSseChunk(res, heldErrorFrame);
      }
      await writeLocalAgentSseEvent(res, committed.finalEvent);
    } else {
      await writeLocalAgentSseEvent(res, committed.errorEvent);
    }
  } else if (!streamed.clientGone && heldErrorFrame && !res.writableEnded) {
    // Preserve a malformed bridge stream that ended after `error` without the
    // required final frame; there is no complete exchange to commit.
    await writeLocalAgentSseChunk(res, heldErrorFrame);
  }

  if (!res.writableEnded) res.end();
  return streamed;
}
