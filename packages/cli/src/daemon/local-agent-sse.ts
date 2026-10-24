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
  } = {},
): Promise<LocalAgentSseStreamResult> {
  let clientGone = false;
  let terminal = false;
  let buffer: Uint8Array = new Uint8Array(0);
  let scanOffset = 0;
  let oversizedFrame = false;
  let oversizedTail: Uint8Array = new Uint8Array(0);
  const endResponseOnTerminal = options.endResponseOnTerminal !== false;

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
      if (!clientGone && !res.writableEnded) {
        await writeLocalAgentSseChunk(res, buffer);
      }
      oversizedTail = buffer.slice(Math.max(0, buffer.length - 3));
      buffer = new Uint8Array(0);
      scanOffset = 0;
      oversizedFrame = true;
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

export async function pipeOpenClawStream(
  req: OpenClawStreamRequest,
  res: OpenClawStreamResponse,
  reader: OpenClawStreamReader,
): Promise<void> {
  await pipeLocalAgentSseStream(req, res, reader);
}

/** Compatibility binding retained while existing callers migrate names. */
export const writeOpenClawStreamChunk = writeLocalAgentSseChunk;
