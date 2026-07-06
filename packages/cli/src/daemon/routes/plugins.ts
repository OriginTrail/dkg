// Per-request dispatcher for route plugins. `headersSent` claims the request (covers streaming);
// throws → 500 PluginError before response start, else destroy the socket so a truncated body isn't seen as 200.

import { jsonResponse } from '../http-utils.js';
import type { InternalRequestContext as RequestContext } from './context.js';

function responseStarted(res: RequestContext['res']): boolean {
  return res.writableEnded || res.headersSent;
}

export async function handlePluginRoutes(ctx: RequestContext): Promise<void> {
  for (const plugin of ctx.routePlugins) {
    if (responseStarted(ctx.res)) return;
    try {
      await plugin.handle(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Daemon-side breadcrumb — the client's 500 only carries the message, not the stack.
      console.error(`[route-plugin:${plugin.name}] handler threw:`, err);
      if (!responseStarted(ctx.res)) {
        jsonResponse(ctx.res, 500, {
          error: 'PluginError',
          plugin: plugin.name,
          message,
        });
      } else if (!ctx.res.writableEnded) {
        // Headers out, plugin threw mid-stream. Calling res.end() would emit a clean HTTP/1.1 terminator and
        // clients / caching proxies could treat the truncated body as a successful 200. Destroy the socket so
        // the client sees ECONNRESET — visibly a failure, never cacheable.
        ctx.res.destroy();
      }
      return;
    }
    // Normal return: do NOT mutate res — `writeHead` without `end` is intentional streaming (SSE etc.).
  }
}
