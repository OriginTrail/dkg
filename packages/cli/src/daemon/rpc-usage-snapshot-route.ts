import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RpcUsageCumulativeSnapshot } from '@origintrail-official/dkg-chain';

export const RPC_USAGE_SNAPSHOT_PATH = '/api/diagnostics/rpc-usage';

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

/**
 * Serve the already-authenticated, loopback-only accounting snapshot. Keeping
 * the route outside `/api/status` prevents public health polling from exposing
 * diagnostics or changing the status contract.
 */
export function handleRpcUsageSnapshotRequest(input: {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly authenticated: boolean;
  readonly snapshot: () => RpcUsageCumulativeSnapshot;
}): boolean {
  if (input.url.pathname !== RPC_USAGE_SNAPSHOT_PATH) return false;

  if (!input.authenticated) {
    input.res.writeHead(401, { 'Content-Type': 'application/json' });
    input.res.end(JSON.stringify({ error: 'Unauthorized' }));
    return true;
  }
  if (!isLoopbackAddress(input.req.socket.remoteAddress)) {
    input.res.writeHead(403, { 'Content-Type': 'application/json' });
    input.res.end(JSON.stringify({ error: 'Local access required' }));
    return true;
  }
  if (input.req.method !== 'GET') {
    input.res.writeHead(405, {
      'Content-Type': 'application/json',
      Allow: 'GET',
    });
    input.res.end(JSON.stringify({ error: 'Method not allowed' }));
    return true;
  }

  input.res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  input.res.end(JSON.stringify(input.snapshot()));
  return true;
}
