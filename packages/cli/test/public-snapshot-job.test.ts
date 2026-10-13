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
    syncPublicGraphSnapshot: sync,
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
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api/context-graph/snapshot-sync`;
}
const body = JSON.stringify({
  contextGraphId: "test",
  onChainId: "1",
  trustedCorePeerIds: ["configured-core"],
});
describe("public snapshot administrator API", () => {
  it("records an explicit bulk transport and rejects unknown transport values", async () => {
    const sync = vi.fn(async () => ({ current: true }));
    const url = await serve(true, sync);
    const input = { ...JSON.parse(body), transport: 'bulk' };
    expect((await fetch(url, { method: 'POST', body: JSON.stringify(input) })).status).toBe(202);
    await vi.waitFor(async () => expect((await (await fetch(url)).json()).request.transport).toBe('bulk'));
    expect(sync).toHaveBeenCalledWith({...input, mode:'core-cache'});
    expect((await fetch(url, { method: 'POST', body: JSON.stringify({ ...input, transport: 'parallel' }) })).status).toBe(400);
  });
  it("denies an agent principal and never starts recovery", async () => {
    const sync = vi.fn(async () => ({}));
    const url = await serve(false, sync);
    expect((await fetch(url, { method: "POST", body })).status).toBe(403);
    expect((await fetch(url)).status).toBe(403);
    expect(sync).not.toHaveBeenCalled();
  });
  it("accepts prebuffered requests and enforces the same body bound", async () => {
    const sync = vi.fn(async () => ({current:true}));
    const url = await serve(true, sync, true);
    expect((await fetch(url, {method:'POST',body})).status).toBe(202);
    await vi.waitFor(async () => expect((await (await fetch(url)).json()).state).toBe('complete'));
    expect((await fetch(url, {method:'POST',body:' '.repeat(4097)})).status).toBe(413);
    expect(sync).toHaveBeenCalledTimes(1);
  });
  it('shares distinct-peer normalization and rejects malformed domain values before dispatch', async () => {
    const sync = vi.fn(async () => ({})), url = await serve(true, sync);
    const request = JSON.parse(body);
    expect((await fetch(url, { method: 'POST', body: JSON.stringify({ ...request, trustedCorePeerIds: Array(5).fill('core') }) })).status).toBe(202);
    expect(sync).toHaveBeenCalledWith({ ...request, mode: 'core-cache', transport: 'exact', trustedCorePeerIds: ['core'] });
    await vi.waitFor(async () => expect((await (await fetch(url)).json()).state).toBe('complete'));
    sync.mockClear();
    for (const patch of [{ mode: 'unknown' }, { contextGraphId: '../bad' }, { onChainId: '0' },
      { trustedCorePeerIds: [] }, { trustedCorePeerIds: ['a', 'b', 'c', 'd', 'e'] }, { trustedCorePeerIds: [1] }]) {
      expect((await fetch(url, { method: 'POST', body: JSON.stringify({ ...request, ...patch }) })).status).toBe(400);
    }
    expect(sync).not.toHaveBeenCalled();
  });
  it("starts one owned job, refuses duplicates, and preserves terminal failure", async () => {
    let reject!: (error: Error) => void;
    const held = new Promise((_, r) => {
      reject = r;
    });
    const sync = vi.fn(() => held);
    const url = await serve(true, sync);
    expect((await fetch(url, { method: "POST", body })).status).toBe(202);
    expect((await fetch(url, { method: "POST", body })).status).toBe(409);
    expect(sync).toHaveBeenCalledTimes(1);
    reject(new Error("No valid configured source"));
    await vi.waitFor(async () =>
      expect(await (await fetch(url)).json()).toMatchObject({
        state: "failed",
        error: "No valid configured source",
      }),
    );
    expect((await fetch(url, { method: "POST", body: "{" })).status).toBe(400);
  });
});
