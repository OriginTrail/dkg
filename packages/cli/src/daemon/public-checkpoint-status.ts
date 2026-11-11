// SPDX-License-Identifier: Apache-2.0
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
/** Answers liveness during the bounded bootstrap; never exposes a ready API or secrets. */
export async function startCheckpointStartupStatus(port: number, host = '127.0.0.1') {
  const server = createServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ready: false, state: 'public-bootstrap-starting' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(port, host, resolve);
  });
  let closing: Promise<void> | undefined;
  return { port: (server.address() as AddressInfo).port, close: () => closing ??= new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}
