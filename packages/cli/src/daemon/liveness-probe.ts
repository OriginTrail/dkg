import { request, type ClientRequest } from 'node:http';

export const LIVENESS_PROBE_TIMEOUT_MS = 5_000;

export type ProbeOutcome = 'http_response' | 'deadline' | 'connect_error' |
  'request_error' | 'premature_close' | 'malformed_response' | 'setup_error' | 'cancelled';

/** Only fixed vocabulary and numeric measurements may leave the transport layer. */
export interface LivenessProbeResult {
  outcome: ProbeOutcome;
  elapsedMs: number;
  connected: boolean;
  headersReceived: boolean;
  statusCode?: number;
  errorCode?: string;
}

const ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH',
  'ENETUNREACH', 'ETIMEDOUT', 'EPIPE', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE',
  'ERR_OUT_OF_RANGE', 'ERR_SOCKET_BAD_PORT', 'HPE_INVALID_CONSTANT', 'HPE_INVALID_HEADER_TOKEN',
  'HPE_INVALID_VERSION', 'HPE_INVALID_STATUS', 'HPE_HEADER_OVERFLOW',
  'HPE_UNEXPECTED_CONTENT_LENGTH', 'HPE_INVALID_CONTENT_LENGTH',
]);

function safeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ERROR_CODES.has(code) ? code : 'UNKNOWN';
}

/** Bounded, monotonic durations; never serialize Infinity or negative clock deltas. */
export function livenessElapsedMs(start: number): number {
  const elapsed = performance.now() - start;
  return Number.isFinite(elapsed) ? Math.min(2_147_483_647, Math.max(0, Math.round(elapsed))) : 0;
}

/** Any parsed HTTP response is alive; neither authentication nor store health is required. */
export function probeWorkerLiveness(
  port: number,
  host = '127.0.0.1',
  timeoutMs = LIVENESS_PROBE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<LivenessProbeResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    let settled = false;
    let connected = false;
    let headersReceived = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let probe: ClientRequest | undefined;
    const cancel = () => settle('cancelled');
    const settle = (outcome: ProbeOutcome, errorCode?: string, statusCode?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', cancel);
      // Retain the request error listener: destroy can emit a late error.
      probe?.destroy();
      resolve({ outcome, elapsedMs: livenessElapsedMs(started), connected, headersReceived,
        ...(errorCode === undefined ? {} : { errorCode }),
        ...(statusCode === undefined ? {} : { statusCode }) });
    };
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      probe = request({ host, port, method: 'HEAD', path: '/api/__dkg_liveness_probe__', agent: false },
        (response) => {
          headersReceived = true;
          response.resume();
          settle(response.statusCode === undefined ? 'malformed_response' : 'http_response',
            undefined, response.statusCode);
        });
      probe.once('socket', (socket) => {
        if (!socket.connecting) connected = true;
        else socket.once('connect', () => { connected = true; });
      });
      probe.once('error', (error) => {
        const code = safeErrorCode(error);
        const outcome = code.startsWith('HPE_') ? 'malformed_response'
          : connected && code === 'ECONNRESET' ? 'premature_close'
          : connected ? 'request_error' : 'connect_error';
        settle(outcome, code);
      });
      probe.once('close', () => settle('premature_close'));
      deadline = setTimeout(() => settle('deadline'), timeoutMs);
      deadline.unref?.();
      probe.end();
    } catch (error) {
      settle('setup_error', safeErrorCode(error));
    }
  });
}

/** Compatibility adapter for callers that only need the liveness policy. */
export async function probeWorkerAlive(
  port: number, host = '127.0.0.1', timeoutMs = LIVENESS_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return (await probeWorkerLiveness(port, host, timeoutMs)).outcome === 'http_response';
}
