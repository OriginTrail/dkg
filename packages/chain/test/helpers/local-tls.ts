import { readFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * A test-only self-signed certificate for `localhost` and 127.0.0.1, valid
 * until 2126. `test/fixtures/localhost-tls/localhost.cnf` describes it and
 * gives the command that regenerates both files.
 */
const LOCALHOST_CERT = readFileSync(new URL('../fixtures/localhost-tls/localhost-cert.pem', import.meta.url), 'utf8');
const LOCALHOST_KEY = readFileSync(new URL('../fixtures/localhost-tls/localhost-key.pem', import.meta.url), 'utf8');

function closeAll(server: net.Server, connections: Set<{ destroy(): void }>): Promise<void> {
  for (const connection of connections) connection.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

export interface JsonRpcTlsServer {
  /** `https://localhost:<port>/`. */
  readonly url: string;
  readonly cert: string;
  /** `req.httpVersion` of each request, in arrival order. */
  readonly httpVersions: string[];
  close(): Promise<void>;
}

/** A TLS JSON-RPC server that offers both `h2` and `http/1.1`, as public RPC endpoints do. */
export async function startHttp2AndHttp1JsonRpcServer(): Promise<JsonRpcTlsServer> {
  const httpVersions: string[] = [];
  const connections = new Set<{ destroy(): void }>();
  const server = http2.createSecureServer({ cert: LOCALHOST_CERT, key: LOCALHOST_KEY, allowHTTP1: true }, (req, res) => {
    httpVersions.push(req.httpVersion);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
  });
  server.on('session', (session) => connections.add(session));
  server.on('secureConnection', (socket) => connections.add(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `https://localhost:${(server.address() as AddressInfo).port}/`,
    cert: LOCALHOST_CERT,
    httpVersions,
    close: () => closeAll(server, connections),
  };
}

export interface ConnectProxy {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** The `host:port` of each CONNECT request, in arrival order. */
  readonly connects: string[];
  close(): Promise<void>;
}

/** An HTTP proxy that tunnels CONNECT requests to 127.0.0.1. */
export async function startConnectProxy(): Promise<ConnectProxy> {
  const connects: string[] = [];
  const connections = new Set<{ destroy(): void }>();
  const server = http.createServer((_req, res) => {
    res.statusCode = 405;
    res.end();
  });
  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    connects.push(req.url ?? '');
    connections.add(client);
    const upstream = net.connect(Number(new URL(`http://${req.url}`).port), '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    connections.add(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    connects,
    close: () => closeAll(server, connections),
  };
}
