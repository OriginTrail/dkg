// Sample route-plugin fixture for plugin-loader + e2e tests.
// Pre-built ESM module — no TypeScript compile in test paths.

export const echoPlugin = {
  name: 'sample-fixture-echo',
  async handle(ctx) {
    if (ctx.req.method === 'GET' && ctx.path === '/api/sample-fixture/publisher-context') {
      ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
      ctx.res.end(JSON.stringify({
        publisherRuntimePresent: ctx.publisherRuntime !== null,
        publisherAvailability: ctx.publisherAvailability,
        runtimeAliasMatchesCanonical: ctx.publisherRuntime === ctx.publisherState.runtime,
        availabilityAliasMatchesCanonical:
          ctx.publisherAvailability === ctx.publisherState.availability,
      }));
      return;
    }
    if (ctx.req.method !== 'POST' || ctx.path !== '/api/sample-fixture/echo') return;
    const chunks = [];
    for await (const c of ctx.req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('utf8');
    let parsed;
    try {
      parsed = body.length > 0 ? JSON.parse(body) : {};
    } catch {
      parsed = { raw: body };
    }
    ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
    ctx.res.end(JSON.stringify({ echoed: parsed }));
  },
};

export const throwingPlugin = {
  name: 'sample-fixture-throw',
  handle(ctx) {
    if (ctx.req.method !== 'POST' || ctx.path !== '/api/sample-fixture/throw') return;
    throw new Error('intentional');
  },
};

export default echoPlugin;
