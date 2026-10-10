import { afterEach, describe, it, expect, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { handleContextGraphRoutes } from "../src/daemon/routes/context-graph.js";
import { requestAuthentication } from "./_helpers/request-authentication.js";
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});
async function serve(admin: boolean, sync: () => Promise<unknown>) {
  const agent = {
    syncPublicGraphSnapshot: sync,
    getDefaultAgentAddress: () => undefined,
    resolveAgentByToken: () => undefined,
  };
  server = createServer(async (req, res) => {
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
  it("denies an agent principal and never starts recovery", async () => {
    const sync = vi.fn(async () => ({}));
    const url = await serve(false, sync);
    expect((await fetch(url, { method: "POST", body })).status).toBe(403);
    expect((await fetch(url)).status).toBe(403);
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
