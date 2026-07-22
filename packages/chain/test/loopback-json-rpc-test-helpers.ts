import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LoopbackJsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

export interface LoopbackJsonRpcServer {
  readonly url: string;
  readonly calls: LoopbackJsonRpcRequest[];
  readonly stop: () => Promise<void>;
}

export type LoopbackJsonRpcHandler = (
  call: LoopbackJsonRpcRequest,
  response: ServerResponse,
  request: IncomingMessage,
) => void | Promise<void>;

export interface LoopbackJsonRpcTestHarness {
  readonly start: (handler: LoopbackJsonRpcHandler) => Promise<LoopbackJsonRpcServer>;
  readonly stopAll: () => Promise<void>;
}

/** Suite-local loopback JSON-RPC lifecycle with deterministic teardown. */
export function createLoopbackJsonRpcTestHarness(): LoopbackJsonRpcTestHarness {
  const activeServers: LoopbackJsonRpcServer[] = [];

  const start = async (handler: LoopbackJsonRpcHandler): Promise<LoopbackJsonRpcServer> => {
    const calls: LoopbackJsonRpcRequest[] = [];
    const server = createServer(async (request, response) => {
      try {
        const parsed = JSON.parse(await readRequestBody(request)) as LoopbackJsonRpcRequest;
        calls.push(parsed);
        await handler(parsed, response, request);
      } catch (cause) {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
        if (!response.writableEnded) {
          response.end(cause instanceof Error ? cause.message : 'failure');
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    let stopped = false;
    const loopback = Object.freeze({
      url: `http://127.0.0.1:${address.port}`,
      calls,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await closeServer(server);
      },
    });
    activeServers.push(loopback);
    return loopback;
  };

  return Object.freeze({
    start,
    stopAll: async () => {
      await Promise.all(activeServers.splice(0).map((server) => server.stop()));
    },
  });
}

export function sendJsonRpcResult(
  response: ServerResponse,
  request: LoopbackJsonRpcRequest,
  result: unknown,
): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}

export function sendJsonRpcError(
  response: ServerResponse,
  request: LoopbackJsonRpcRequest,
  code: number,
  message: string,
  data?: string,
): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    jsonrpc: '2.0',
    id: request.id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
