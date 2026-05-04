/**
 * Shared in-process mocks for unit-testing daemon route handlers.
 *
 * Contract: each helper produces the minimum surface a route handler needs
 * (a fake IncomingMessage, a fake ServerResponse, a partial RequestContext)
 * with NO real daemon, NO network, NO chain, and NO Hardhat. Tests invoke
 * the route handler directly and assert on captured side effects.
 *
 * Used by:
 *   - daemon-routes-kafka.test.ts (slice 03 — privacy envelope)
 *   - reserved for slice 02 (local-vs-shared CG) and slice 07 (subscription)
 *     once those tickets land, both of which exercise routes/kafka.ts and
 *     need identical mocks.
 */

import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestContext } from '../../src/daemon/routes/context.js';

const DEFAULT_AGENT_ADDRESS = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/**
 * Make a minimal fake IncomingMessage. Body (if provided) is JSON-encoded
 * and emitted via 'data'/'end' events on the next tick — matching what
 * readBody() in `http-utils.ts` consumes.
 *
 * Defaults to POST so the common case stays terse; pass `method`/`url`
 * overrides for routes that accept other verbs/paths.
 */
export function makeFakeRequest(
  body: object | null,
  overrides: { method?: string; url?: string } = {},
): IncomingMessage {
  const emitter = new EventEmitter() as unknown as IncomingMessage;
  emitter.method = overrides.method ?? 'POST';
  emitter.url = overrides.url ?? '/';

  // Emit data/end on the next tick so listeners are attached first
  setImmediate(() => {
    if (body !== null) {
      emitter.emit('data', Buffer.from(JSON.stringify(body)));
    }
    emitter.emit('end');
  });

  return emitter;
}

export interface FakeResponse {
  res: ServerResponse;
  getResult: () => { status: number; body: unknown };
}

/**
 * Make a fake ServerResponse that captures the status + JSON body written
 * via writeHead/end. jsonResponse() in http-utils.ts calls
 * writeHead(status, headers) then end(body), so both overloads must work.
 */
export function makeFakeResponse(): FakeResponse {
  let capturedStatus = 0;
  let capturedBody: unknown = null;

  const res = new EventEmitter() as unknown as ServerResponse;
  (res as any).writeHead = (status: number, _headers?: unknown) => {
    capturedStatus = status;
    return res;
  };
  (res as any).end = (data?: string) => {
    try {
      capturedBody = data ? JSON.parse(data) : null;
    } catch {
      capturedBody = data;
    }
    return res;
  };

  return {
    res,
    getResult: () => ({ status: capturedStatus, body: capturedBody }),
  };
}

export interface PublishCall {
  cgId: string;
  envelope: unknown;
}

export type PublishHook = (cgId: string, envelope: unknown) => Promise<unknown>;

/**
 * Build a minimal RequestContext with a mock agent.publish that captures
 * every call. All fields are overridable so route-specific tests can
 * inject a different `path`, `requestAgentAddress`, etc.
 *
 * The returned `publishCalls` array is shared mutable state — assert on it
 * after invoking the route handler.
 */
export function makeRequestContext(
  req: IncomingMessage,
  res: ServerResponse,
  overrides: Partial<RequestContext> & { onPublish?: PublishHook } = {},
): { ctx: RequestContext; publishCalls: PublishCall[] } {
  const publishCalls: PublishCall[] = [];
  // Strip the test-only `onPublish` before merging the rest into the ctx.
  const { onPublish, ...ctxOverrides } = overrides;

  const mockAgent = {
    async publish(cgId: string, envelope: unknown) {
      publishCalls.push({ cgId, envelope });
      if (onPublish) return onPublish(cgId, envelope);
      return { ual: 'did:dkg:test/1', kcId: '1', status: 'confirmed' as const };
    },
  };

  const ctx: Partial<RequestContext> = {
    req,
    res,
    agent: mockAgent as unknown as RequestContext['agent'],
    requestAgentAddress: DEFAULT_AGENT_ADDRESS,
    path: req.url ?? '/',
    ...ctxOverrides,
  };

  return { ctx: ctx as RequestContext, publishCalls };
}
