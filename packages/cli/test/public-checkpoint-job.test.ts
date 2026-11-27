import { afterEach, describe, it, expect, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { handleContextGraphRoutes } from "../src/daemon/routes/context-graph.js";
import { requestAuthentication } from "./_helpers/request-authentication.js";
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});
async function serve(admin: boolean, sync: () => Promise<unknown>, prebuffer = false) {
  const agent = {
    getPublicSnapshotSourcePolicies: () => ['base-mainnet-registered-cores'],
    preparePublicGraphCheckpoint: sync,
    getDefaultAgentAddress: () => undefined,
    resolveAgentByToken: () => undefined,
  };
  server = createServer(async (req, res) => {
    if (prebuffer && req.method === 'POST') {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      (req as any).__dkgPrebufferedBody = Buffer.concat(chunks);
    }
    const url = new URL(req.url!, "http://127.0.0.1");
    await handleContextGraphRoutes({
      req,
      res,
      agent,
      url,
      path: url.pathname,
      config: { auth: { enabled: true } },
      authentication: admin
        ? requestAuthentication({ kind: "nodeOperator" })
        : requestAuthentication({ kind: "agent", agentAddress: "agent" }),
    } as any);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api/context-graph/snapshot-checkpoint`;
}
const body = JSON.stringify({ contextGraphId: 'test', onChainId: '1', trustedCorePeerIds: ['core'] });
describe('public checkpoint admin API', () => {
  it('denies an agent token before preparing any data', async () => {
    const prepare = vi.fn(); const url = await serve(false, prepare);
    expect((await fetch(url, { method: 'POST', body })).status).toBe(403);
    expect((await fetch(url)).status).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
  });
  it('keeps prepared data distinct from committed coverage and validates runtime selection', async () => {
    const result = { current: false, committed: 0, state: 'verified-unpublished', activeStoreChanged: false };
    const prepare = vi.fn(async () => result); const url = await serve(true, prepare);
    expect((await fetch(url, { method: 'POST', body: JSON.stringify({...JSON.parse(body), native: true}) })).status).toBe(202);
    await vi.waitFor(async () => expect(await (await fetch(url)).json()).toMatchObject({state:'complete', result}));
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ mode: 'core-cache' }), true);
    for (const patch of [{ native: 'yes' }, { java: '/untrusted' }, { signal: {} }, { transport: 'bulk' }])
      expect((await fetch(url, {method:'POST', body:JSON.stringify({...JSON.parse(body),...patch})})).status).toBe(400);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it('retains failed and pending outcomes without duplicate starts', async () => {
    let reject!: (error: Error) => void;
    const prepare = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
    const url = await serve(true, prepare);
    expect((await fetch(url, {method:'POST',body})).status).toBe(202);
    expect((await fetch(url, {method:'POST',body})).status).toBe(409);
    reject(new Error('Inventory changed'));
    await vi.waitFor(async () => expect(await (await fetch(url)).json()).toMatchObject({state:'failed',error:'Inventory changed'}));
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
