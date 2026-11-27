import type { IncomingMessage, ServerResponse } from 'node:http';

export type LocalAgentSseRequest = Pick<IncomingMessage, 'on'>;
export type LocalAgentSseResponse = Pick<
  ServerResponse,
  'on' | 'off' | 'writeHead' | 'write' | 'end' | 'writableEnded'
>;
export type LocalAgentSseReader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<unknown>;
  releaseLock: () => void;
};

/** Compatibility names retained for existing OpenClaw and Hermes callers. */
export type OpenClawStreamRequest = LocalAgentSseRequest;
export type OpenClawStreamResponse = LocalAgentSseResponse;
export type OpenClawStreamReader = LocalAgentSseReader;

/**
 * Head of every local-agent SSE response. `no-transform` keeps compressing
 * proxies from holding small frames back, and `X-Accel-Buffering: no` turns
 * off nginx-family proxy buffering for this response: keepalive comments only
 * defeat proxy idle timeouts if they are flushed to the client.
 */
const LOCAL_AGENT_SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/**
 * Writes the 200 SSE head and sends it at once. Node otherwise holds a written
 * head until the first body byte, so a proxy saw no response at all until the
 * agent's first text arrived.
 */
export function writeLocalAgentSseHead(
  res: Pick<ServerResponse, 'writeHead'> & { flushHeaders?: () => void },
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(200, { ...LOCAL_AGENT_SSE_HEADERS, ...extraHeaders });
  res.flushHeaders?.();
}

/** SSE comment frame: every reader skips comment lines, so it carries only liveness. */
export const LOCAL_AGENT_SSE_KEEPALIVE_FRAME = ': keepalive\n\n';

/**
 * A tool-heavy turn can run for minutes without a transcript byte, and proxies
 * end a response that shows no progress, commonly after 60 to 100 s. Same
 * cadence as the Prime Agent bridge heartbeat.
 */
export const LOCAL_AGENT_SSE_KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Writes a keepalive comment every `intervalMs` until the returned stop
 * function runs or the response finishes, closes or fails. `canWrite` lets a
 * pump hold the comment while one frame is only partly forwarded.
 */
export function startLocalAgentSseKeepalive(
  res: LocalAgentSseResponse,
  options: { intervalMs?: number; canWrite?: () => boolean } = {},
): () => void {
  const intervalMs = options.intervalMs ?? LOCAL_AGENT_SSE_KEEPALIVE_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
    res.off('finish', stop);
    res.off('close', stop);
    res.off('error', stop);
  };
  if (!(intervalMs > 0)) return stop;
  timer = setInterval(() => {
    if (res.writableEnded || (res as { destroyed?: boolean }).destroyed) {
      stop();
      return;
    }
    if (options.canWrite && !options.canWrite()) return;
    try {
      res.write(LOCAL_AGENT_SSE_KEEPALIVE_FRAME);
    } catch {
      stop();
    }
  }, intervalMs);
  timer.unref?.();
  res.on('finish', stop);
  res.on('close', stop);
  res.on('error', stop);
  return stop;
}

export async function writeLocalAgentSseChunk(
  res: LocalAgentSseResponse,
  chunk: Uint8Array,
): Promise<void> {
  if (res.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err);
    };
    res.on('drain', onDrain);
    res.on('close', onClose);
    res.on('error', onError);
  });
}

/** Largest complete SSE event retained while looking for its separator. */
const SSE_FRAME_SCAN_LIMIT = 1_000_000;
const LF = 0x0a;
const CR = 0x0d;

/**
 * Byte-space match of the frame-separator grammar `/\r?\n\r?\n/` at `index`.
 * Returns the exclusive end offset of the separator, or -1 when no complete
 * separator starts here.
 */
function matchSseSeparatorAt(bytes: Uint8Array, index: number): number {
  let i = index;
  if (bytes[i] === CR) {
    if (bytes[i + 1] !== LF) return -1;
    i += 2;
  } else if (bytes[i] === LF) {
    i += 1;
  } else {
    return -1;
  }
  if (bytes[i] === LF) return i + 1;
  if (bytes[i] === CR && bytes[i + 1] === LF) return i + 2;
  return -1;
}

function findSseSeparator(
  bytes: Uint8Array,
  startIndex = 0,
): { start: number; end: number } | null {
  for (let index = startIndex; index < bytes.length; index += 1) {
    const end = matchSseSeparatorAt(bytes, index);
    if (end >= 0) return { start: index, end };
  }
  return null;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left.slice();
  const combined = new Uint8Array(left.length + right.length);
  combined.set(left, 0);
  combined.set(right, left.length);
  return combined;
}

function parseSseJsonEvent(frame: Uint8Array): Record<string, unknown> | null {
  const decoded = new TextDecoder().decode(frame);
  for (const line of decoded.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return null;
}

export type LocalAgentSseFrameAction = {
  /** Forward this frame byte-for-byte to the downstream response. */
  forward: boolean;
  /** Stop at this semantic frame and intentionally drop every later byte. */
  terminal?: boolean;
};

export type LocalAgentSseFrame = {
  event: Record<string, unknown> | null;
  frame: Uint8Array;
  separator: Uint8Array;
};

export type LocalAgentSseStreamResult = {
  terminal: boolean;
  clientGone: boolean;
};

/**
 * Canonical local-agent SSE pump. It owns byte-safe frame splitting, split
 * separators, malformed/oversized frames, backpressure, cancellation, and
 * terminal truncation. Integrations customize only semantic frame policy.
 */
export async function pipeLocalAgentSseStream(
  req: LocalAgentSseRequest,
  res: LocalAgentSseResponse,
  reader: LocalAgentSseReader,
  options: {
    onFrame?: (
      frame: LocalAgentSseFrame,
    ) => LocalAgentSseFrameAction | Promise<LocalAgentSseFrameAction>;
    endResponseOnTerminal?: boolean;
    /** Keepalive comment cadence while the pump runs; 0 or unset sends none. */
    keepaliveIntervalMs?: number;
  } = {},
): Promise<LocalAgentSseStreamResult> {
  let clientGone = false;
  let terminal = false;
  let buffer: Uint8Array = new Uint8Array(0);
  let scanOffset = 0;
  let oversizedFrame = false;
  let oversizedTail: Uint8Array = new Uint8Array(0);
  const endResponseOnTerminal = options.endResponseOnTerminal !== false;
  // Whole frames go out in one write, so a comment between writes lands on a
  // frame boundary; only an oversized frame is forwarded in pieces.
  const stopKeepalive = startLocalAgentSseKeepalive(res, {
    intervalMs: options.keepaliveIntervalMs ?? 0,
    canWrite: () => !oversizedFrame,
  });

  const cancelUpstream = () => {
    if (clientGone) return;
    clientGone = true;
    void reader.cancel().catch(() => {});
  };

  req.on('aborted', cancelUpstream);
  res.on('close', () => {
    if (!res.writableEnded) cancelUpstream();
  });
  res.on('error', cancelUpstream);

  const handleFrame = async (
    frame: Uint8Array,
    separator: Uint8Array,
  ): Promise<boolean> => {
    const event = parseSseJsonEvent(frame);
    const action = options.onFrame
      ? await options.onFrame({ event, frame, separator })
      : { forward: true, terminal: event?.type === 'final' };
    if (action.forward && !clientGone && !res.writableEnded) {
      await writeLocalAgentSseChunk(res, concatBytes(frame, separator));
    }
    if (action.terminal) terminal = true;
    return terminal;
  };

  const inspectBufferedFrames = async (atEof = false): Promise<boolean> => {
    let boundary = findSseSeparator(buffer, scanOffset);
    while (boundary) {
      const frame = buffer.slice(0, boundary.start);
      const separator = buffer.slice(boundary.start, boundary.end);
      buffer = buffer.slice(boundary.end);
      scanOffset = 0;
      if (await handleFrame(frame, separator)) {
        buffer = new Uint8Array(0);
        scanOffset = 0;
        return true;
      }
      boundary = findSseSeparator(buffer);
    }

    scanOffset = Math.max(0, buffer.length - 3);
    if (atEof && buffer.length > 0) {
      const frame = buffer;
      buffer = new Uint8Array(0);
      scanOffset = 0;
      return handleFrame(frame, new Uint8Array(0));
    }

    if (buffer.length > SSE_FRAME_SCAN_LIMIT) {
      const partialFrame = buffer;
      oversizedTail = buffer.slice(Math.max(0, buffer.length - 3));
      buffer = new Uint8Array(0);
      scanOffset = 0;
      // Set before the write: a keepalive must wait while it awaits drain.
      oversizedFrame = true;
      if (!clientGone && !res.writableEnded) {
        await writeLocalAgentSseChunk(res, partialFrame);
      }
    }
    return false;
  };

  const consumeOversizedFrame = async (chunk: Uint8Array): Promise<Uint8Array> => {
    const combined = concatBytes(oversizedTail, chunk);
    const boundary = findSseSeparator(combined);
    if (!boundary) {
      if (!clientGone && !res.writableEnded) await writeLocalAgentSseChunk(res, chunk);
      oversizedTail = combined.slice(Math.max(0, combined.length - 3));
      return new Uint8Array(0);
    }
    const endInChunk = boundary.end - oversizedTail.length;
    if (endInChunk > 0 && !clientGone && !res.writableEnded) {
      await writeLocalAgentSseChunk(res, chunk.slice(0, endInChunk));
    }
    oversizedFrame = false;
    oversizedTail = new Uint8Array(0);
    return chunk.slice(Math.max(0, endInChunk));
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || clientGone) break;
      if (value === undefined || value.length === 0) continue;
      const unconsumed = oversizedFrame ? await consumeOversizedFrame(value) : value;
      if (clientGone || unconsumed.length === 0) continue;
      buffer = concatBytes(buffer, unconsumed);
      if (await inspectBufferedFrames()) {
        if (endResponseOnTerminal && !res.writableEnded) res.end();
        void reader.cancel().catch(() => {});
        break;
      }
    }
    if (!clientGone && !terminal && !oversizedFrame) {
      if (await inspectBufferedFrames(true)) {
        if (endResponseOnTerminal && !res.writableEnded) res.end();
        void reader.cancel().catch(() => {});
      }
    }
  } finally {
    stopKeepalive();
    reader.releaseLock();
  }
  return { terminal, clientGone };
}

export type DurableLocalAgentTurn = {
  text: string;
  finalEvent: Record<string, unknown>;
  errorEvent?: Record<string, unknown>;
};

export type DurableLocalAgentTurnCommitResult =
  | { ok: true; finalEvent: Record<string, unknown> }
  | { ok: false; errorEvent: Record<string, unknown> };

/**
 * One lifecycle owner for local-agent streams whose terminal acknowledgement
 * depends on a durable commit. Deltas pass through immediately. Error/final
 * frames are held, the commit hook is awaited, and only then is the terminal
 * outcome released. A commit failure emits its replacement error and never a
 * final acknowledgement.
 */
export async function pipeDurableLocalAgentTurnSseStream(
  req: LocalAgentSseRequest,
  res: LocalAgentSseResponse,
  reader: LocalAgentSseReader,
  commit: (turn: DurableLocalAgentTurn) => Promise<DurableLocalAgentTurnCommitResult>,
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

export async function writeLocalAgentSseEvent(
  res: LocalAgentSseResponse,
  event: Record<string, unknown>,
): Promise<void> {
  if (res.writableEnded || (res as { destroyed?: boolean }).destroyed) return;
  await writeLocalAgentSseChunk(
    res,
    new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
  );
}

/**
 * Byte-for-byte relay for the OpenClaw and Hermes channel bridges. Their own
 * frames stop while the agent runs tools, so the daemon keeps the response
 * alive itself (#3886).
 */
export async function pipeOpenClawStream(
  req: OpenClawStreamRequest,
  res: OpenClawStreamResponse,
  reader: OpenClawStreamReader,
): Promise<void> {
  await pipeLocalAgentSseStream(req, res, reader, {
    keepaliveIntervalMs: LOCAL_AGENT_SSE_KEEPALIVE_INTERVAL_MS,
  });
}

/** Compatibility binding retained while existing callers migrate names. */
export const writeOpenClawStreamChunk = writeLocalAgentSseChunk;
