import type {
  DaemonPluginApi,
} from './types.js';

export function registerHermesRoutes(api: DaemonPluginApi): void {
  api.registerHttpRoute({
    method: 'GET',
    path: '/api/hermes/status',
    handler: async (_req, res) => {
      res.json({
        adapter: 'hermes',
        framework: 'hermes-agent',
        status: 'connected',
        version: '0.0.1',
      });
    },
  });
}
