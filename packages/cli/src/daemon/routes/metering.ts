// V2 Stage-3 — thin daemon adapter for the metering endpoint.
//
// All decisions live in metering/http-core.ts, which is dependency-light so it
// can be bundled and executed standalone by a counterparty (buyer-found: the
// previous archive was unrunnable because this file's http-utils import drags
// in chain ABIs and websocket transports). This file supplies the daemon's real
// I/O helpers and the live provider address / chain head, and nothing else.
import type { RequestContext } from "./context.js";
import { jsonResponse, readBody, SMALL_BODY_BYTES } from "../http-utils.js";
import { handleMetering } from "../metering/http-core.js";

const meterHome = () => process.env.DKG_HOME ?? `${process.env.HOME}/.dkg`;

/** The provider wallet this node deposits to. Read-only; never a key. */
function providerAddress(ctx: RequestContext): string {
  const w = ctx.opWallets as unknown as Record<string, { address?: string }>;
  return w?.publisher?.address ?? w?.operational?.address ?? "0x0000000000000000000000000000000000000000";
}

/** Observed head. Null when the chain is unreachable — never a guess. */
async function safeHead(ctx: RequestContext): Promise<number | null> {
  try {
    const p = (ctx.agent as unknown as { provider?: { getBlockNumber?: () => Promise<number> } }).provider;
    if (!p?.getBlockNumber) return null;
    return await p.getBlockNumber();
  } catch { return null; }
}

export async function handleMeteringRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path } = ctx;
  if (!path.startsWith("/api/metering/")) return;
  await handleMetering(
    {
      method: req.method ?? "GET",
      path,
      searchParams: ctx.url.searchParams,
      providerAddress: providerAddress(ctx),
      requestAgentAddress: ctx.requestAgentAddress,
      safeHeadBlock: await safeHead(ctx),
      home: meterHome(),
    },
    {
      json: (status, body) => jsonResponse(res, status, body as Record<string, unknown>),
      readBody: () => readBody(req, SMALL_BODY_BYTES),
    },
  );
}
