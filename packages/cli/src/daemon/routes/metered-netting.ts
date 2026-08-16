// P2 — netting routes: thin adapter over metering/netting-http-core.
//
// Same split as routes/metered-infer.ts: the CORE carries every fail-closed
// decision and is what the gates exercise; this file only adapts the daemon's
// RequestContext. recordEarnedRelease is deliberately NOT exposed here (or
// anywhere over HTTP) — it is loopback settlement-script bookkeeping, exactly
// like the withdrawal routes.
import type { RequestContext } from "./context.js";
import { jsonResponse, readBody, SMALL_BODY_BYTES } from "../http-utils.js";
import { handleNetting } from "../metering/netting-http-core.js";

const meterHome = () => process.env.DKG_HOME ?? `${process.env.HOME}/.dkg`;
const NETTING_PATHS = new Set([
  "/api/metering/netting/quantities",
  "/api/metering/netting/settle-gate",
  "/api/metering/close/commit",
  "/api/metering/close/rollover",
]);

export async function handleMeteredNettingRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path } = ctx;
  if (!NETTING_PATHS.has(path)) return;
  const rawQuery = (() => { try { return new URL(req.url ?? "", "http://x").search; } catch { return ""; } })();
  await handleNetting(
    { method: req.method ?? "GET", path, home: meterHome(), query: rawQuery },
    {
      json: (status, body) => jsonResponse(res, status, body as Record<string, unknown>),
      readBody: () => readBody(req, SMALL_BODY_BYTES),
    },
  );
}
