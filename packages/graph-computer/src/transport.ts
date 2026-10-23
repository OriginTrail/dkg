import { getAddress } from 'ethers';
import { GraphComputerError } from './errors.js';
import { signHttpRequest } from './signing.js';
import type { GraphComputerOptions, RequestOptions } from './types.js';

type Body = (address: string) => Promise<unknown> | unknown;
type Request = RequestOptions & { method?: string; body?: Body; retry?: boolean; invocationId?: string };

export class Transport {
  private readonly origin: URL;
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private identity?: string;

  constructor(readonly options: GraphComputerOptions) {
    if (!!options.signer === !!options.localAgent) throw new TypeError('Choose a signer or an authenticated local agent');
    if (options.localAgent) {
      if (typeof options.localAgent.authToken !== 'string' || !options.localAgent.authToken.trim()) throw new TypeError('Local agent requires the node session credential');
      getAddress(options.localAgent.address);
    }
    this.origin = new URL(options.nodeUrl);
    if (!['http:', 'https:'].includes(this.origin.protocol) || this.origin.username || this.origin.password
      || this.origin.pathname !== '/' || this.origin.search || this.origin.hash) {
      throw new TypeError('nodeUrl must be an HTTP(S) origin without credentials, path, query or fragment');
    }
    assertPeer(options.peerId);
    if (options.executorPeerId !== undefined) assertPeer(options.executorPeerId);
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = integer(options.timeoutMs ?? 60_000, 1, 2_147_483_647, 'timeoutMs');
    this.retries = integer(options.retries ?? 2, 0, 5, 'retries');
    this.retryDelayMs = integer(options.retryDelayMs ?? 250, 0, 5_000, 'retryDelayMs');
    this.maxResponseBytes = integer(options.maxResponseBytes ?? 4 * 1024 * 1024, 1, 64 * 1024 * 1024, 'maxResponseBytes');
  }

  async address(): Promise<string> {
    const address = getAddress(this.options.localAgent?.address ?? await this.options.signer!.getAddress());
    if (this.identity !== undefined && address !== this.identity) throw new Error('Signer changed identity; create a new client');
    this.identity = address;
    return address;
  }

  async request(path: string, request: Request = {}): Promise<unknown> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin.origin || url.pathname + url.search !== path || url.hash) {
      throw new TypeError('Request path must preserve its exact encoding and stay on the configured node');
    }
    const method = request.method ?? 'GET';
    const attempts = request.retry ? this.retries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const abort = () => controller.abort(new GraphComputerError('ABORTED', 'Request aborted'));
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) abort();
      const timer = setTimeout(() => controller.abort(new GraphComputerError('TIMEOUT', 'Request deadline exceeded')), this.timeoutMs);
      let sent = false;
      let retryAfterMs = 0;
      try {
        return await abortable(async () => {
          controller.signal.throwIfAborted();
          let body: string | undefined;
          let headers: Record<string, string>;
          try {
            const address = await this.address();
            body = request.body ? JSON.stringify(await request.body(address)) : undefined;
            controller.signal.throwIfAborted();
            headers = this.options.localAgent
              ? { Authorization: `Bearer ${this.options.localAgent.authToken}`, 'Content-Type': 'application/json', 'X-DKG-Program-Agent': address }
              : await signHttpRequest(this.options.signer!, address, this.options.peerId, method, path, body);
          } catch (cause) {
            controller.signal.throwIfAborted();
            throw new GraphComputerError('SIGNING_FAILED', 'Could not sign the request', { cause });
          }
          controller.signal.throwIfAborted();
          let response: Response;
          try {
            sent = true;
            response = await this.fetch(url, {
              method, headers, body, signal: controller.signal, redirect: 'error', credentials: 'omit',
            });
          } catch (cause) {
            controller.signal.throwIfAborted();
            throw new GraphComputerError('NETWORK_ERROR', 'Could not reach the DKG node', { cause });
          }
          const text = await this.readResponse(response);
          let data: unknown;
          try { data = JSON.parse(text); } catch { data = undefined; }
          if (!response.ok) {
            const error = isRecord(data) ? data : {};
            const after = response.headers.get('retry-after');
            if (after) {
              const value = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now();
              if (Number.isFinite(value)) retryAfterMs = Math.max(0, value);
            }
            throw new GraphComputerError(typeof error.code === 'string' ? error.code : 'HTTP_ERROR',
              typeof error.error === 'string' ? error.error : `DKG returned HTTP ${response.status}`,
              { status: response.status, details: data });
          }
          if (data === undefined) throw new GraphComputerError('INVALID_RESPONSE', 'DKG returned a non-JSON success response', { status: response.status });
          return data;
        }, controller.signal);
      } catch (cause) {
        const error = cause instanceof GraphComputerError ? cause
          : new GraphComputerError('INVALID_RESPONSE', 'Could not read the DKG response', { cause });
        const retryable = sent && !request.signal?.aborted && (
          ['NETWORK_ERROR', 'TIMEOUT'].includes(error.code)
          || (['HTTP_ERROR', 'PROGRAM_TARGET_NODE_UNREACHABLE'].includes(error.code)
            && [429, 502, 503, 504].includes(error.status ?? 0))
        );
        if (!retryable || attempt + 1 >= attempts) {
          throw new GraphComputerError(error.code, error.message, {
            status: error.status, details: error.details, cause: error.cause,
            invocationId: request.invocationId,
          });
        }
        // Clear attempt resources before waiting, and never shorten a server Retry-After.
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', abort);
        if (retryAfterMs > 5_000) {
          throw new GraphComputerError(error.code, error.message, {
            status: error.status, details: error.details, invocationId: request.invocationId,
          });
        }
        try {
          await delay(Math.max(retryAfterMs, Math.min(5_000, this.retryDelayMs * 2 ** attempt)), request.signal);
        } catch {
          throw new GraphComputerError('ABORTED', 'Request aborted', { invocationId: request.invocationId });
        }
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', abort);
      }
    }
    throw new Error('Unreachable');
  }

  private async readResponse(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxResponseBytes) {
          void reader.cancel().catch(() => {});
          throw new GraphComputerError('RESPONSE_TOO_LARGE', 'DKG response exceeded maxResponseBytes');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function abortable<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([work(), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function assertPeer(value: string): void {
  if (typeof value !== 'string' || !/^\S{1,512}$/.test(value)) throw new TypeError('A node peer ID is required');
}
