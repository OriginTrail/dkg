import { generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

/** A DER element: tag, definite length, contents. */
function der(tag: number, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  const length: number[] = [];
  for (let n = body.length; n > 0; n >>= 8) length.unshift(n & 0xff);
  const head = body.length < 0x80 ? [body.length] : [0x80 | length.length, ...length];
  return Buffer.concat([Buffer.from([tag, ...head]), body]);
}

const sequence = (...contents: Buffer[]): Buffer => der(0x30, ...contents);
const objectId = (hex: string): Buffer => der(0x06, Buffer.from(hex, 'hex'));
const utcTime = (date: Date): Buffer =>
  der(0x17, Buffer.from(date.toISOString().replace(/[-:T]|\.\d+/g, '').slice(2)));

/**
 * A self-signed P-256 certificate for `localhost` and 127.0.0.1, valid for a
 * day, built at run time so no key is committed and none expires.
 */
export function selfSignedLocalhostCertificate(): { readonly cert: string; readonly key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdsaWithSha256 = sequence(objectId('2a8648ce3d040302'));
  const commonNameLocalhost = sequence(der(0x31, sequence(objectId('550403'), der(0x0c, Buffer.from('localhost')))));
  const now = Date.now();
  const subjectAltName = sequence(
    objectId('551d11'),
    der(0x04, sequence(der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1])))),
  );
  const toBeSigned = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    ecdsaWithSha256,
    commonNameLocalhost,
    sequence(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 86_400_000))),
    commonNameLocalhost,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(subjectAltName)),
  );
  const certificate = sequence(
    toBeSigned,
    ecdsaWithSha256,
    der(0x03, Buffer.from([0]), sign('sha256', toBeSigned, privateKey)),
  );
  const base64 = certificate.toString('base64').match(/.{1,64}/g)!.join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

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
  const { cert, key } = selfSignedLocalhostCertificate();
  const httpVersions: string[] = [];
  const connections = new Set<{ destroy(): void }>();
  const server = http2.createSecureServer({ cert, key, allowHTTP1: true }, (req, res) => {
    httpVersions.push(req.httpVersion);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
  });
  server.on('session', (session) => connections.add(session));
  server.on('secureConnection', (socket) => connections.add(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `https://localhost:${(server.address() as AddressInfo).port}/`,
    cert,
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
