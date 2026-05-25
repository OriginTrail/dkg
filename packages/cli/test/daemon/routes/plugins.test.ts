import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { RequestContext } from '../../../src/daemon/routes/context.js';
import type { RoutePlugin } from '../../../src/daemon/plugin-api.js';
import { handlePluginRoutes } from '../../../src/daemon/routes/plugins.js';

interface FakeRes {
  writableEnded: boolean;
  headersSent: boolean;
  destroyed: boolean;
  statusCode: number;
  headers: Record<string, string | number | string[]>;
  body: string;
  writeHead: (status: number, headers?: Record<string, string | number | string[]>) => FakeRes;
  write: (chunk: string) => boolean;
  end: (chunk?: string) => void;
  destroy: (err?: Error) => void;
  setHeader: (k: string, v: string) => void;
  getHeader: (k: string) => string | undefined;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    writableEnded: false,
    headersSent: false,
    destroyed: false,
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, headers) {
      if (res.headersSent) {
        throw new Error('ERR_HTTP_HEADERS_SENT');
      }
      res.statusCode = status;
      if (headers) Object.assign(res.headers, headers);
      res.headersSent = true;
      return res;
    },
    write(chunk: string) {
      if (!res.headersSent) res.headersSent = true;
      res.body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') res.body += chunk;
      if (!res.headersSent) res.headersSent = true;
      res.writableEnded = true;
    },
    destroy() {
      // Mirrors Node's ServerResponse.destroy(): socket aborted, no clean
      // terminator chunk. `writableEnded` stays false (no graceful end).
      res.destroyed = true;
    },
    setHeader(k, v) { res.headers[k] = v; },
    getHeader(k) { return res.headers[k] as string | undefined; },
  };
  return res;
}

function makeCtx(routePlugins: RoutePlugin[], res = makeRes()): {
  ctx: RequestContext;
  res: FakeRes;
} {
  const ctx = {
    req: {} as never,
    res: res as unknown as ServerResponse,
    routePlugins,
    path: '/api/test',
  } as unknown as RequestContext;
  return { ctx, res };
}

describe('handlePluginRoutes', () => {
  // Throw-path tests would otherwise dump real stack traces from the dispatcher's `console.error` breadcrumb.
  // Stub per test; the "logs the plugin name" test reads `errorSpy.mock.calls` directly.
  let errorSpy: ReturnType<typeof vi.spyOn<typeof console, 'error'>>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns without writing when routePlugins is empty', async () => {
    const { ctx, res } = makeCtx([]);
    await handlePluginRoutes(ctx);
    expect(res.writableEnded).toBe(false);
    expect(res.body).toBe('');
  });

  it('stops at the first plugin that claims the request by writing', async () => {
    const calls: string[] = [];
    const first: RoutePlugin = {
      name: 'first',
      handle(c) {
        calls.push('first');
        c.res.writeHead(200, { 'Content-Type': 'application/json' });
        c.res.end('{"ok":true}');
      },
    };
    const second: RoutePlugin = {
      name: 'second',
      handle() {
        calls.push('second');
      },
    };
    const { ctx, res } = makeCtx([first, second]);
    await handlePluginRoutes(ctx);
    expect(calls).toEqual(['first']);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
  });

  it('returns a 500 PluginError when a plugin throws and stops the chain', async () => {
    const calls: string[] = [];
    const thrower: RoutePlugin = {
      name: 'boom',
      handle() {
        calls.push('boom');
        throw new Error('intentional');
      },
    };
    const next: RoutePlugin = {
      name: 'next',
      handle() {
        calls.push('next');
      },
    };
    const { ctx, res } = makeCtx([thrower, next]);
    await handlePluginRoutes(ctx);
    expect(calls).toEqual(['boom']);
    expect(res.statusCode).toBe(500);
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({
      error: 'PluginError',
      plugin: 'boom',
      message: 'intentional',
    });
  });

  it('does not emit a second response when a plugin throws after starting the response', async () => {
    const calls: string[] = [];
    const partialThenThrow: RoutePlugin = {
      name: 'half-written',
      handle(c) {
        calls.push('half-written');
        // headersSent=true, writableEnded=false, then throws.
        c.res.writeHead(200, { 'Content-Type': 'application/json' });
        c.res.write('{"partial":');
        throw new Error('mid-stream failure');
      },
    };
    const next: RoutePlugin = {
      name: 'next',
      handle() {
        calls.push('next');
      },
    };
    const { ctx, res } = makeCtx([partialThenThrow, next]);
    await expect(handlePluginRoutes(ctx)).resolves.toBeUndefined();
    expect(calls).toEqual(['half-written']);
    // Status stays as the plugin wrote it — no overwrite-attempt 500.
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"partial":');
  });

  it('logs the plugin name and underlying error when a plugin throws', async () => {
    // Operators need a daemon-side breadcrumb (plugin name + error) — the client's 500 only carries the message.
    const thrower: RoutePlugin = {
      name: 'logging-test-plugin',
      handle() {
        throw new Error('boom-message');
      },
    };
    const { ctx } = makeCtx([thrower]);
    await handlePluginRoutes(ctx);

    expect(errorSpy).toHaveBeenCalled();
    const joined = errorSpy.mock.calls
      .map((args) =>
        args
          .map((a) =>
            typeof a === 'string'
              ? a
              : a instanceof Error
              ? a.stack ?? a.message
              : JSON.stringify(a),
          )
          .join(' '),
      )
      .join('\n');
    expect(joined).toContain('logging-test-plugin');
    expect(joined).toContain('boom-message');
  });

  it('aborts the socket (not res.end) when a plugin throws after writeHead', async () => {
    // res.end() would emit a clean HTTP/1.1 terminator and clients/CDNs could cache the truncated body as 200.
    // Destroy the socket instead so the client sees ECONNRESET — visibly a failure.
    const partialThenThrow: RoutePlugin = {
      name: 'half-written-terminator',
      handle(c) {
        c.res.writeHead(200, { 'Content-Type': 'application/json' });
        c.res.write('{"partial":');
        throw new Error('mid-stream failure');
      },
    };
    const { ctx, res } = makeCtx([partialThenThrow]);
    await handlePluginRoutes(ctx);
    expect(res.headersSent).toBe(true);
    expect(res.destroyed).toBe(true);
    expect(res.writableEnded).toBe(false); // no clean terminator
    // Status / body claimed by the plugin — must not be overwritten.
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"partial":');
  });

  it('leaves a streaming response open when a plugin writes headers and returns without calling end', async () => {
    // Dispatcher must NOT call end() after normal return — `headersSent && !writableEnded` is intentional streaming (SSE etc.).
    const calls: string[] = [];
    const streamingPlugin: RoutePlugin = {
      name: 'sse-stream',
      handle(c) {
        calls.push('sse-stream');
        c.res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        c.res.write('event: connected\ndata: {}\n\n');
        // No end() — async writer would keep emitting via setInterval / event subscription.
      },
    };
    const followOn: RoutePlugin = {
      name: 'follow-on',
      handle() {
        calls.push('follow-on');
      },
    };
    const { ctx, res } = makeCtx([streamingPlugin, followOn]);
    await handlePluginRoutes(ctx);
    expect(calls).toEqual(['sse-stream']);
    expect(res.headersSent).toBe(true);
    // Stream stays alive — dispatcher never called end().
    expect(res.writableEnded).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('event: connected\ndata: {}\n\n');
    // Follow-on must not run — top-of-iteration `headersSent` check stops the chain.
    expect(calls).not.toContain('follow-on');
  });

  it('stringifies a non-Error throw value (string, number, object) into the 500 message field', async () => {
    // The dispatcher does `err instanceof Error ? err.message : String(err)`.
    // A regression that called `.message` on a primitive would crash
    // the dispatcher with `TypeError: cannot read property of` and
    // hang the request without a response. Lock the contract that
    // any throw value is renderable.
    const stringThrower: RoutePlugin = {
      name: 'string-thrower',
      handle() { throw 'plain-string-throw' as unknown as Error; },
    };
    const { ctx, res } = makeCtx([stringThrower]);
    await handlePluginRoutes(ctx);
    expect(res.statusCode).toBe(500);
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({
      error: 'PluginError',
      plugin: 'string-thrower',
      message: 'plain-string-throw',
    });
  });

  it('numeric throw renders to a stringified number in the 500 message', async () => {
    const numberThrower: RoutePlugin = {
      name: 'number-thrower',
      handle() { throw 42 as unknown as Error; },
    };
    const { ctx, res } = makeCtx([numberThrower]);
    await handlePluginRoutes(ctx);
    expect(res.statusCode).toBe(500);
    const parsed = JSON.parse(res.body);
    expect(parsed.message).toBe('42');
  });

  it('does NOT destroy or overwrite a fully-completed response when a plugin throws after end()', async () => {
    // writableEnded=true means the plugin already finalised the response
    // (e.g. wrote, ended, then errored on a follow-up async cleanup).
    // Calling res.destroy() at this point would either no-op (response
    // socket already returned) or, in Node ≥18, log a warning. The
    // dispatcher must NOT call destroy when writableEnded is true —
    // the response is already on the wire.
    const completedThenThrow: RoutePlugin = {
      name: 'late-throw',
      handle(c) {
        c.res.writeHead(200, { 'Content-Type': 'application/json' });
        c.res.end('{"ok":true}');
        throw new Error('post-end cleanup error');
      },
    };
    const { ctx, res } = makeCtx([completedThenThrow]);
    await handlePluginRoutes(ctx);
    // The response was completed: status / body / writableEnded all
    // reflect the plugin's first writes. destroyed must remain false.
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}');
    expect(res.writableEnded).toBe(true);
    expect(res.destroyed).toBe(false);
  });

  it('skips remaining plugins when an earlier plugin already finalised the response (top-of-iteration check)', async () => {
    // The `responseStarted` check at the TOP of the loop matters
    // when a plugin completes the response in handle() and a later
    // plugin would otherwise also try to write. Locks the
    // never-double-respond contract for the writableEnded=true axis.
    const calls: string[] = [];
    const finished: RoutePlugin = {
      name: 'finished',
      handle(c) {
        calls.push('finished');
        c.res.writeHead(204);
        c.res.end();
      },
    };
    const wouldOverwrite: RoutePlugin = {
      name: 'would-overwrite',
      handle(c) {
        calls.push('would-overwrite');
        c.res.writeHead(500); // would throw ERR_HTTP_HEADERS_SENT in real Node
      },
    };
    const { ctx, res } = makeCtx([finished, wouldOverwrite]);
    await handlePluginRoutes(ctx);
    expect(calls).toEqual(['finished']);
    expect(res.statusCode).toBe(204);
    expect(res.writableEnded).toBe(true);
  });

  it('falls through to the next plugin when one returns without writing', async () => {
    const calls: string[] = [];
    const skip: RoutePlugin = {
      name: 'skip',
      handle() {
        calls.push('skip');
      },
    };
    const handler: RoutePlugin = {
      name: 'handler',
      handle(c) {
        calls.push('handler');
        c.res.writeHead(201);
        c.res.end('done');
      },
    };
    const { ctx, res } = makeCtx([skip, handler]);
    await handlePluginRoutes(ctx);
    expect(calls).toEqual(['skip', 'handler']);
    expect(res.statusCode).toBe(201);
    expect(res.body).toBe('done');
  });
});
