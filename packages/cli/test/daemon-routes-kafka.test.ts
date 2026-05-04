/**
 * Unit tests for the Kafka route adapter's privacy-envelope logic.
 *
 * The route adapter (packages/cli/src/daemon/routes/kafka.ts) is responsible
 * for wrapping the bare KA in either `{ private: KA }` or `{ public: KA }`
 * before passing it to agent.publish(). The kafka package itself stays agnostic.
 *
 * These tests invoke handleKafkaRoutes directly with a minimal RequestContext
 * mock — no real daemon, no network, no chain. The fakes live in
 * test/helpers/route-test-utils.ts and are reused by future route tests.
 */

import { describe, it, expect } from 'vitest';
import { handleKafkaRoutes } from '../src/daemon/routes/kafka.js';
import {
  makeFakeRequest,
  makeFakeResponse,
  makeRequestContext,
} from './helpers/route-test-utils.js';

const KAFKA_ENDPOINT_URL = '/api/kafka/endpoint';

const VALID_BASE_BODY = {
  contextGraphId: 'devnet-test',
  broker: 'kafka.example.com:9092',
  topic: 'orders.created',
  messageFormat: 'application/json',
};

describe('Kafka route adapter — privacy envelope', () => {
  it('wraps with { private: KA } when private: true is in request body', async () => {
    const req = makeFakeRequest({ ...VALID_BASE_BODY, private: true }, { url: KAFKA_ENDPOINT_URL });
    const { res, getResult } = makeFakeResponse();
    const { ctx, publishCalls } = makeRequestContext(req, res);

    await handleKafkaRoutes(ctx);

    const { status, body } = getResult();
    expect(status).toBe(200);

    expect(publishCalls).toHaveLength(1);
    const { envelope } = publishCalls[0]!;
    expect(envelope).toHaveProperty('private');
    expect(envelope).not.toHaveProperty('public');

    // Response must echo the resolved private flag
    expect((body as Record<string, unknown>).private).toBe(true);
  });

  it('wraps with { public: KA } when private: false is in request body', async () => {
    const req = makeFakeRequest({ ...VALID_BASE_BODY, private: false }, { url: KAFKA_ENDPOINT_URL });
    const { res, getResult } = makeFakeResponse();
    const { ctx, publishCalls } = makeRequestContext(req, res);

    await handleKafkaRoutes(ctx);

    const { status, body } = getResult();
    expect(status).toBe(200);

    expect(publishCalls).toHaveLength(1);
    const { envelope } = publishCalls[0]!;
    expect(envelope).toHaveProperty('public');
    expect(envelope).not.toHaveProperty('private');

    // Response must echo the resolved private flag
    expect((body as Record<string, unknown>).private).toBe(false);
  });

  it('defaults to { private: KA } when private field is omitted from request body', async () => {
    // No `private` field — route defaults to private: true
    const req = makeFakeRequest(VALID_BASE_BODY, { url: KAFKA_ENDPOINT_URL });
    const { res, getResult } = makeFakeResponse();
    const { ctx, publishCalls } = makeRequestContext(req, res);

    await handleKafkaRoutes(ctx);

    const { status, body } = getResult();
    expect(status).toBe(200);

    expect(publishCalls).toHaveLength(1);
    const { envelope } = publishCalls[0]!;
    expect(envelope).toHaveProperty('private');
    expect(envelope).not.toHaveProperty('public');

    // Response echoes resolved private flag = true (default)
    expect((body as Record<string, unknown>).private).toBe(true);
  });

  it('returns 400 when contextGraphId is missing', async () => {
    const req = makeFakeRequest(
      { broker: 'x:9092', topic: 't', messageFormat: 'application/json' },
      { url: KAFKA_ENDPOINT_URL },
    );
    const { res, getResult } = makeFakeResponse();
    const { ctx } = makeRequestContext(req, res);

    await handleKafkaRoutes(ctx);

    expect(getResult().status).toBe(400);
  });

  it('returns 400 when broker is missing', async () => {
    const req = makeFakeRequest(
      { contextGraphId: 'devnet-test', topic: 't', messageFormat: 'application/json' },
      { url: KAFKA_ENDPOINT_URL },
    );
    const { res, getResult } = makeFakeResponse();
    const { ctx } = makeRequestContext(req, res);

    await handleKafkaRoutes(ctx);

    expect(getResult().status).toBe(400);
  });

  it('returns 400 when "private" is a non-boolean value (e.g. string "false")', async () => {
    // The route enforces a strict boolean for `private` to keep the privacy
    // contract unambiguous. Truthy/falsy coercion would create an unsafe
    // ambiguity at a privacy boundary.
    const req = makeFakeRequest({ ...VALID_BASE_BODY, private: 'false' }, { url: KAFKA_ENDPOINT_URL });
    const { res, getResult } = makeFakeResponse();
    const { ctx, publishCalls } = makeRequestContext(req, res);

    await handleKafkaRoutes(ctx);

    const { status, body } = getResult();
    expect(status).toBe(400);
    expect((body as Record<string, unknown>).error).toMatch(/"private" must be a boolean/);
    // No publish should have happened
    expect(publishCalls).toHaveLength(0);
  });
});
