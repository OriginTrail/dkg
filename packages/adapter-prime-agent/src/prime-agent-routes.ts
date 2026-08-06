/**
 * Package-local routes. Exactly one, matching adapter-hermes' 18-line
 * `hermes-routes.ts`: a status probe so an operator can confirm the adapter
 * loaded inside the daemon. Everything user-facing lives on daemon-owned
 * routes.
 */

import type { DaemonPluginApi } from './types.js';

export function registerPrimeAgentRoutes(api: DaemonPluginApi): void {
  api.registerHttpRoute({
    method: 'GET',
    path: '/api/prime-agent/status',
    handler: (_req: unknown, res: unknown) => {
      const response = res as { writeHead: (s: number, h: Record<string, string>) => void; end: (b: string) => void };
      const body = JSON.stringify({
        adapter: 'prime-agent',
        framework: 'prime-intellect-prime-agent',
        status: 'connected',
        version: '10.0.12',
      });
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(body);
    },
  });
}
