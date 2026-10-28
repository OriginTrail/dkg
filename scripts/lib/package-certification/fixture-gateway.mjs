import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

export function createFixtureGateway({ upstreamPort, upstreamHost = 'host.docker.internal' }) {
  assert.ok(Number.isInteger(upstreamPort) && upstreamPort > 0 && upstreamPort <= 65535, 'invalid registry port');
  return http.createServer((request, response) => {
    const upstream = http.request({
      host: upstreamHost, port: upstreamPort, path: request.url,
      method: request.method, headers: request.headers,
    }, result => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createFixtureGateway({ upstreamPort: Number(process.argv[2]) }).listen(4873, '0.0.0.0');
}
