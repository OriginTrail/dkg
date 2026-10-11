// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal JSON-RPC 2.0 client for an external signer, over HTTP(S) or over
 * HTTP on a unix domain socket. One POST per call, a hard deadline per call,
 * and no retries: a signing request is sent at most once.
 *
 * Secrets: the bearer token is only ever written to the `Authorization`
 * header. It is never part of an error message, and error text received from
 * the signer is scrubbed of it before it is surfaced. Endpoint descriptions
 * in errors are host-only (`https://host:port` or `unix:<socket path>`).
 */
import http from 'node:http';
import https from 'node:https';
import { RemoteSignerError } from './remote-signer-errors.js';

export interface RemoteSignerTransportOptions {
  /** `http://` or `https://` URL of the signer's JSON-RPC endpoint. */
  url?: string;
  /** Unix domain socket on which the signer serves HTTP; requests go to `/`. */
  socketPath?: string;
  /** Sent as `Authorization: Bearer <token>`. */
  authToken?: string;
  /** Deadline for one request, from connect to the last response byte. */
  timeoutMs?: number;
}

export const DEFAULT_REMOTE_SIGNER_TIMEOUT_MS = 30_000;
export const MAX_REMOTE_SIGNER_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SURFACED_TEXT = 300;
const METHOD_NOT_FOUND = -32601;

type Target =
  | { kind: 'url'; url: URL; secure: boolean }
  | { kind: 'socket'; socketPath: string };

export class RemoteSignerTransport {
  /** Host-only endpoint description, safe to log. */
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly #target: Target;
  readonly #authToken?: string;
  readonly #agent: http.Agent;
  #nextId = 1;

  constructor(options: RemoteSignerTransportOptions) {
    const hasUrl = typeof options.url === 'string' && options.url.trim() !== '';
    const hasSocket = typeof options.socketPath === 'string' && options.socketPath.trim() !== '';
    if (hasUrl === hasSocket) {
      throw configError('configure exactly one of url or socketPath');
    }
    if (hasUrl) {
      let url: URL;
      try {
        url = new URL(options.url!.trim());
      } catch {
        throw configError('url is not a valid URL');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw configError('url must use http: or https:');
      }
      if (url.username !== '' || url.password !== '') {
        throw configError('url must not embed credentials; use an auth token instead');
      }
      const secure = url.protocol === 'https:';
      this.#target = { kind: 'url', url, secure };
      this.endpoint = `${url.protocol}//${url.host}`;
      this.#agent = secure
        ? new https.Agent({ keepAlive: true })
        : new http.Agent({ keepAlive: true });
    } else {
      const socketPath = options.socketPath!.trim();
      this.#target = { kind: 'socket', socketPath };
      this.endpoint = `unix:${socketPath}`;
      this.#agent = new http.Agent({ keepAlive: true });
    }
    if (options.authToken !== undefined) {
      if (typeof options.authToken !== 'string' || !/^[\x21-\x7e]+$/.test(options.authToken)) {
        throw configError('the auth token must be a non-empty string of visible ASCII characters');
      }
      this.#authToken = options.authToken;
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_REMOTE_SIGNER_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_REMOTE_SIGNER_TIMEOUT_MS) {
      throw configError(`timeoutMs must be an integer between 1 and ${MAX_REMOTE_SIGNER_TIMEOUT_MS}`);
    }
    this.timeoutMs = timeoutMs;
  }

  /** Send one JSON-RPC call and return its `result`. Never retried. */
  async request(method: string, params: readonly unknown[]): Promise<unknown> {
    const id = this.#nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const { status, text } = await this.#post(body, method);
    const details = { endpoint: this.endpoint, method, httpStatus: status };
    if (status === 401 || status === 403) {
      throw new RemoteSignerError(
        'REMOTE_SIGNER_UNAUTHORIZED',
        `Remote signer at ${this.endpoint} refused the credentials for ${method} (HTTP ${status})`,
        details,
      );
    }
    const httpOk = status >= 200 && status < 300;
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      envelope = undefined;
    }
    if (!isRecord(envelope)) {
      throw httpOk
        ? new RemoteSignerError(
          'REMOTE_SIGNER_BAD_RESPONSE',
          `Remote signer at ${this.endpoint} returned a non-JSON-RPC response to ${method}`,
          details,
        )
        : httpError(this.endpoint, method, status);
    }
    if (envelope.error !== undefined && envelope.error !== null) {
      const rpcError = isRecord(envelope.error) ? envelope.error : {};
      const rpcCode = typeof rpcError.code === 'number' ? rpcError.code : undefined;
      const reason = this.#surfaced(rpcError.message);
      throw new RemoteSignerError(
        rpcCode === METHOD_NOT_FOUND ? 'REMOTE_SIGNER_METHOD_NOT_SUPPORTED' : 'REMOTE_SIGNER_REJECTED',
        `Remote signer at ${this.endpoint} rejected ${method}` +
          `${rpcCode === undefined ? '' : ` (JSON-RPC ${rpcCode})`}${reason ? `: ${reason}` : ''}`,
        { ...details, ...(rpcCode === undefined ? {} : { rpcCode }) },
      );
    }
    if (!httpOk) throw httpError(this.endpoint, method, status);
    if ((envelope.id !== id && envelope.id !== String(id)) || !('result' in envelope)) {
      throw new RemoteSignerError(
        'REMOTE_SIGNER_BAD_RESPONSE',
        `Remote signer at ${this.endpoint} returned a malformed JSON-RPC response to ${method}`,
        details,
      );
    }
    return envelope.result;
  }

  /** Close idle keep-alive connections. Further requests reconnect. */
  destroy(): void {
    this.#agent.destroy();
  }

  #post(body: string, method: string): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    };
    if (this.#authToken !== undefined) headers.authorization = `Bearer ${this.#authToken}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        action();
      };
      const onResponse = (res: http.IncomingMessage): void => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            settle(() => reject(new RemoteSignerError(
              'REMOTE_SIGNER_BAD_RESPONSE',
              `Remote signer at ${this.endpoint} sent more than ${MAX_RESPONSE_BYTES} bytes for ${method}`,
              { endpoint: this.endpoint, method },
            )));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => settle(() => resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
        })));
        res.on('error', (err) => settle(() => reject(this.#transportError(err, method))));
        // A connection dropped mid-response ends in 'close' without 'end'.
        res.on('close', () => settle(() => reject(this.#transportError({ code: 'ECONNRESET' }, method))));
      };
      const target = this.#target;
      const options: http.RequestOptions = { method: 'POST', headers, agent: this.#agent };
      let req: http.ClientRequest;
      if (target.kind === 'socket') {
        req = http.request({ ...options, socketPath: target.socketPath, path: '/' }, onResponse);
      } else if (target.secure) {
        req = https.request(target.url, options, onResponse);
      } else {
        req = http.request(target.url, options, onResponse);
      }
      timer = setTimeout(() => {
        settle(() => reject(new RemoteSignerError(
          'REMOTE_SIGNER_TIMEOUT',
          `Remote signer at ${this.endpoint} did not answer ${method} within ${this.timeoutMs} ms`,
          { endpoint: this.endpoint, method },
        )));
        req.destroy();
      }, this.timeoutMs);
      req.on('error', (err) => settle(() => reject(this.#transportError(err, method))));
      req.end(body);
    });
  }

  #transportError(err: unknown, method: string): RemoteSignerError {
    const code = (err as { code?: unknown } | null)?.code;
    const reason = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'connection failed';
    return new RemoteSignerError(
      'REMOTE_SIGNER_UNAVAILABLE',
      `Remote signer at ${this.endpoint} is unavailable for ${method} (${reason})`,
      { endpoint: this.endpoint, method, cause: err },
    );
  }

  /** Signer-provided text, bounded, single-line and with the auth token removed. */
  #surfaced(value: unknown): string {
    if (typeof value !== 'string') return '';
    let text = value;
    if (this.#authToken !== undefined) text = text.split(this.#authToken).join('[redacted]');
    text = text.replace(/\p{Cc}+/gu, ' ').trim();
    return text.length > MAX_SURFACED_TEXT ? `${text.slice(0, MAX_SURFACED_TEXT)}…` : text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function configError(message: string): RemoteSignerError {
  return new RemoteSignerError('REMOTE_SIGNER_CONFIG', `Invalid remote signer configuration: ${message}`);
}

function httpError(endpoint: string, method: string, status: number): RemoteSignerError {
  return new RemoteSignerError(
    'REMOTE_SIGNER_HTTP_ERROR',
    `Remote signer at ${endpoint} answered ${method} with HTTP ${status}`,
    { endpoint, method, httpStatus: status },
  );
}
