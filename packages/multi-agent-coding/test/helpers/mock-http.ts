/**
 * Mock HTTP request/response factories for handler tests.
 *
 * Follows the same pattern as origin-trail-game's createMockReq/createMockRes.
 */

import { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

/**
 * Create a mock IncomingMessage with the given method, URL, and optional body.
 * If a body is provided, it will be emitted asynchronously as data/end events.
 */
export function createMockReq(
  method: string,
  path: string,
  body?: any,
  headers?: Record<string, string>,
): IncomingMessage & { url: string } {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = path;
  req.headers = headers ?? {};

  if (body !== undefined) {
    // Use process.nextTick to ensure listeners are attached before emitting.
    // setTimeout(0) can be unreliable on Windows or with fake timers.
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  } else {
    // For requests without a body (GET, etc.), emit 'end' immediately
    // so that any accidental readBody call doesn't hang.
    process.nextTick(() => {
      req.emit('end');
    });
  }

  return req;
}

/**
 * Create a mock ServerResponse that captures status code and response body.
 * Access the captured values via the returned object's `status` and `body` getters.
 */
export function createMockRes(): { res: ServerResponse; body: string; status: number } {
  const result = { body: '', status: 0 };
  const res = {
    writeHead(status: number, _headers: any) {
      result.status = status;
    },
    end(data?: string) {
      result.body = data ?? '';
    },
  } as any;
  return {
    res,
    get body() { return result.body; },
    get status() { return result.status; },
  };
}
