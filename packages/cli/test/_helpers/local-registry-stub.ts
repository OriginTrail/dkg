import { createServer, type Server } from 'node:http';

export interface RegistryRoute {
  status: number;
  body: string;
}

/** A real, resettable HTTP registry shared by integration tests. */
export interface LocalRegistryStub {
  readonly routes: Map<string, RegistryRoute>;
  readonly seenAuthorizationHeaders: Array<string | null>;
  readonly baseUrl: string;
  start(): Promise<void>;
  close(): Promise<void>;
  reset(): void;
}

export function createLocalRegistryStub(): LocalRegistryStub {
  const routes = new Map<string, RegistryRoute>();
  const seenAuthorizationHeaders: Array<string | null> = [];
  let server: Server | undefined;
  let baseUrl = '';

  return {
    routes,
    seenAuthorizationHeaders,
    get baseUrl(): string {
      if (!baseUrl) throw new Error('Local registry stub has not been started');
      return baseUrl;
    },
    async start(): Promise<void> {
      if (server) return;
      server = createServer((req, res) => {
        seenAuthorizationHeaders.push(req.headers.authorization ?? null);
        const route = routes.get(req.url ?? '');
        if (!route) {
          res.writeHead(500);
          res.end('unconfigured route');
          return;
        }
        res.writeHead(route.status, { 'Content-Type': 'application/json' });
        res.end(route.body);
      });
      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(0, '127.0.0.1', () => {
          server?.off('error', reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Local registry has no TCP address');
      baseUrl = `http://127.0.0.1:${address.port}`;
    },
    async close(): Promise<void> {
      if (!server) return;
      const activeServer = server;
      server = undefined;
      baseUrl = '';
      await new Promise<void>((resolve, reject) => {
        activeServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
    reset(): void {
      routes.clear();
      seenAuthorizationHeaders.length = 0;
    },
  };
}
