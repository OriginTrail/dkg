import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { createKafkaPlugin } from '../src/index.js';
if (false) {
  createKafkaPlugin({
    extension: {
      // @ts-expect-error extension schemas must be plain Zod objects, not scalar schemas.
      schema: z.string(),
      augment: () => ({}),
    },
  });
}
function mockReqRes(method: string, urlPath: string, body?: unknown) {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const reqStream = Readable.from([payload]) as unknown as IncomingMessage;
  (reqStream as unknown as Record<string, unknown>).method = method;
  (reqStream as unknown as Record<string, unknown>).url = urlPath;
  (reqStream as unknown as Record<string, unknown>).headers = { host: 'localhost' };
  const captured: { statusCode: number; body: unknown } = { statusCode: 0, body: undefined };
  const res = {
    writeHead(status: number) { captured.statusCode = status; return this; },
    end(payload?: string) {
      if (payload) { try { captured.body = JSON.parse(payload); } catch { captured.body = payload; } }
      return this;
    },
    setHeader() {},
    get writableEnded() { return captured.statusCode !== 0; },
    get headersSent() { return captured.statusCode !== 0; },
  } as unknown as ServerResponse;
  return { req: reqStream, res, captured };
}
describe('createKafkaPlugin factory wiring', () => {
  it('default base path dispatches POST /register through to the handler', async () => {
    const plugin = createKafkaPlugin({ contextGraphId: 'urn:cg:demo' });
    const { req, res, captured } = mockReqRes('POST', '/api/kafka/streams/register', {
      name: 'n', kafkaBootstrapUrl: 'u', kafkaTopicName: 't',
    });
    const publishAsync = vi.fn().mockResolvedValue({ captureID: 'cap-x' });
    await plugin.handle({
      req, res,
      agent: { publishAsync },
      publisherControl: { getStatus: vi.fn() },
      publisherRuntime: { walletIds: ['0xwallet'] },
      config: {},
      path: '/api/kafka/streams/register',
    } as never);
    expect(captured.statusCode).toBe(202);
    expect(publishAsync).toHaveBeenCalledTimes(1);
    // Admission is argument 0 now; the context graph moved to 1.
    expect(publishAsync.mock.calls[0][1]).toBe('urn:cg:demo');
    expect(publishAsync.mock.calls[0][0]).toMatchObject({ kind: 'agent' });
  });
  it('forwards publishOptions through the factory to publishAsync', async () => {
    const plugin = createKafkaPlugin({
      contextGraphId: 'urn:cg:demo',
      publishOptions: { accessPolicy: 'public' },
    });
    const { req, res } = mockReqRes('POST', '/api/kafka/streams/register', {
      name: 'n', kafkaBootstrapUrl: 'u', kafkaTopicName: 't',
    });
    const publishAsync = vi.fn().mockResolvedValue({ captureID: 'cap-x' });
    await plugin.handle({
      req, res,
      agent: { publishAsync },
      publisherControl: { getStatus: vi.fn() },
      publisherRuntime: { walletIds: ['0xwallet'] },
      config: {},
      path: '/api/kafka/streams/register',
    } as never);
    expect(publishAsync.mock.calls[0][3]).toEqual({ accessPolicy: 'public' });
  });
  it('respects custom basePath override', async () => {
    const plugin = createKafkaPlugin({ basePath: '/custom/kafka', contextGraphId: 'urn:cg:demo' });
    const { req, res, captured } = mockReqRes('POST', '/custom/kafka/register', {
      name: 'n', kafkaBootstrapUrl: 'u', kafkaTopicName: 't',
    });
    const publishAsync = vi.fn().mockResolvedValue({ captureID: 'cap-x' });
    await plugin.handle({
      req, res,
      agent: { publishAsync },
      publisherControl: { getStatus: vi.fn() },
      publisherRuntime: { walletIds: ['0xwallet'] },
      config: {},
      path: '/custom/kafka/register',
    } as never);
    expect(captured.statusCode).toBe(202);
  });
});
