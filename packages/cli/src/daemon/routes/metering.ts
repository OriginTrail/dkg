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
import { ethers } from "ethers";
import { resolveRpcUrls } from "@origintrail-official/dkg-chain";
import { resolveChainConfig } from "../../config.js";

const meterHome = () => process.env.DKG_HOME ?? `${process.env.HOME}/.dkg`;

/** Base mainnet unless the node says otherwise. Never guessed silently. */
function chainIdOf(ctx: RequestContext): number {
  try {
    const c = resolveChainConfig(ctx.config, ctx.network) as { chainId?: number } | undefined;
    return Number(c?.chainId ?? 8453);
  } catch { return 8453; }
}

/**
 * The provider wallet a buyer deposits TRAC to. Read-only; never a key.
 *
 * Deployment-found, 2026-08-06: this previously guessed `opWallets.publisher`
 * / `opWallets.operational`, neither of which exists — the real shape is
 * `{ adminWallet?, wallets[] }`. Both lookups missed and the function returned
 * its zero-address fallback, so the FIRST live quote advertised
 * 0x0000…0000 as the deposit destination. A buyer following that quote burns
 * their TRAC. There is no safe default for "where should you send money", so
 * this returns null and the caller refuses to quote at all.
 */
function providerAddress(ctx: RequestContext): string | null {
  const w = ctx.opWallets as unknown as { wallets?: Array<{ address?: string }> };
  const addr = w?.wallets?.[0]?.address;
  if (!addr || /^0x0+$/i.test(addr)) return null;
  return addr;
}

/**
 * The chain's SAFE head — deliberately not `latest`.
 *
 * D10 fixes confirmations at 12 *from the safe head* because a reorg past a
 * latest-block deposit would credit a tab against a transfer that no longer
 * exists. Ethers exposes this as the `safe` block tag, so this asks the chain
 * for its own notion of safety instead of subtracting a guess from `latest`.
 *
 * Returns null — never a guess, never `latest` as a stand-in — when the chain
 * is unreachable or the network has no safe tag. Downstream, a null head means
 * no deposit can satisfy the confirmation rule, which is the correct failure.
 *
 * Cached briefly: a quote is a read, and hammering the RPC per request would be
 * both slow and rude to the endpoint.
 */
let headCache: { at: number; value: number | null } | null = null;
const HEAD_TTL_MS = 5_000;

async function safeHead(ctx: RequestContext): Promise<number | null> {
  if (headCache && Date.now() - headCache.at < HEAD_TTL_MS) return headCache.value;
  let value: number | null = null;
  try {
    const chainConf = resolveChainConfig(ctx.config, ctx.network) as { rpcUrl?: string; rpcUrls?: string[] } | undefined;
    if (chainConf?.rpcUrl) {
      const urls = resolveRpcUrls(chainConf.rpcUrl, chainConf.rpcUrls);
      const provider = new ethers.JsonRpcProvider(urls[0], undefined, { cacheTimeout: -1 });
      const block = await Promise.race([
        provider.getBlock("safe"),
        new Promise<null>((r) => setTimeout(() => r(null), 3_000)),
      ]);
      value = block?.number ?? null;
      provider.destroy?.();
    }
  } catch { value = null; }
  headCache = { at: Date.now(), value };
  return value;
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
      chainId: chainIdOf(ctx),
    },
    {
      json: (status, body) => jsonResponse(res, status, body as Record<string, unknown>),
      readBody: () => readBody(req, SMALL_BODY_BYTES),
    },
  );
}
