// @origintrail-official/marketplace — NSM v3 route plugin.
//
// Mounts the seller front and the buyer gateway under /marketplace on the
// node's public API. Loaded via config `routePlugins`; the ONLY module this
// package imports from the host is `plugin-api.js` (lint-enforced boundary).
//
// marketplace.enabled=false (the default, including a missing or malformed
// config file) ⇒ handle() returns without touching the response ⇒ every
// marketplace route is ABSENT from the surface — the daemon 404s them exactly
// like any unknown path. Enabling is a config change + restart, never a code
// change.
import type { RoutePlugin, RequestContext } from "@origintrail-official/dkg/daemon/plugin-api";
import { loadMarketplaceConfig, marketplaceHome, type MarketplaceConfig } from "./config.js";
import { connectLlamaCpp, type LlamaCppBinding } from "./seller/connector-llamacpp.js";
import { connectOpenAi, type OpenAiBinding } from "./seller/connector-openai.js";
import { connectCodexOAuth, type CodexOAuthBinding } from "./seller/connector-codex-oauth.js";
import { handleFront, type FrontDeps, type OfferingBinding } from "./seller/front.js";
import { handleGateway, type GatewayDeps, type GatewayOffering } from "./gateway/router.js";
import { BuyerClient } from "./buyer/client.js";
import { hfEngine, tiktokenEngine } from "./buyer/bpe.js";
import { startLaneExecutor } from "./lane/executor.js";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

// The buyer gateway mounts from `<home>/buyer.json`, which can appear or change
// AFTER the daemon starts (a tab opens, a key is configured). Fold its presence
// + mtime into the remount key so the gateway (re)mounts without a restart.
function buyerCfgStamp(): string {
  const p = join(marketplaceHome(dkgHome()), "buyer.json");
  try { return existsSync(p) ? String(statSync(p).mtimeMs) : "none"; } catch { return "none"; }
}

const BASE = "/marketplace";
const dkgHome = () => process.env.DKG_HOME ?? `${process.env.HOME}/.dkg`;

interface Mounted {
  front: FrontDeps | null;
  gateway: GatewayDeps | null;
  loadedAt: number;
  configDigestish: string;
}
let mounted: Mounted | null = null;
let laneStarted = false;

async function mount(cfg: MarketplaceConfig, ctx: RequestContext, log: (l: string) => void): Promise<Mounted> {
  const home = marketplaceHome(dkgHome());
  const offerings = new Map<string, OfferingBinding>();

  for (const off of cfg.offerings) {
    try {
      if (off.connector.kind === "llamacpp") {
        const binding: LlamaCppBinding = await connectLlamaCpp(off.connector);
        const ob: OfferingBinding = { offering: off, binding, tokenizerBundleRef: binding.tokenizerBundleDigest };
        offerings.set(off.id, ob);
        offerings.set(binding.modelId, ob);
        log(`offering ${off.id} ⛓ ${binding.modelId} gguf=${binding.ggufSha256.slice(0, 18)}… tok=${binding.tokenizerBundleDigest.slice(0, 18)}…`);
      } else if (off.connector.kind === "codex-oauth") {
        const binding: CodexOAuthBinding = connectCodexOAuth(off.connector);
        const ob: OfferingBinding = {
          offering: off, binding,
          tokenizerBundleRef: "public:" + binding.tokenizerBundle,
          countEngine: tiktokenEngine(readFileSync(off.connector.tokenizerFile, "utf8")),
        };
        offerings.set(off.id, ob);
        offerings.set(binding.model, ob);
        log(`offering ${off.id} ☁ codex-oauth ${binding.model} bundle=${binding.tokenizerBundle}@${binding.tokenizerFileSha256.slice(0, 18)}… effort=${binding.reasoningEffort}`);
      } else {
        const binding: OpenAiBinding = connectOpenAi(off.connector);
        const ob: OfferingBinding = { offering: off, binding, tokenizerBundleRef: "public:" + binding.tokenizerBundle };
        offerings.set(off.id, ob);
        offerings.set(binding.model, ob);
        log(`offering ${off.id} ☁ ${binding.model} bundle=${binding.tokenizerBundle}`);
      }
    } catch (e) {
      // an offering that cannot connect is NOT served — fail closed per offering
      log(`offering ${off.id} NOT MOUNTED: ${String((e as Error).message).slice(0, 120)}`);
    }
  }

  // seller side (only if a provider address is known)
  let front: FrontDeps | null = null;
  const providerAddress = cfg.providerAddress ?? null;
  if (providerAddress && offerings.size > 0) {
    front = {
      home, cfg, offerings,
      providerAddress,
      chainId: cfg.chainId ?? 8453,
      rpcUrl: cfg.rpcUrl ?? "",
      tracContract: cfg.tracContract,
      // Metered queries execute against THIS node's own query surface over
      // loopback, with the node's own token — the plugin never embeds a
      // secret; it borrows the daemon's in-process token set.
      queryExecutor: async (sparql: string) => {
        const token = [...ctx.validTokens][0];
        const res = await fetch(`http://127.0.0.1:${ctx.apiPortRef.value}/api/query`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ sparql }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`query backend ${res.status}`);
        const out = (await res.json()) as { result?: { bindings?: unknown[] } };
        const bindings = out.result?.bindings ?? [];
        return { body: JSON.stringify(out.result ?? {}), returnedQuads: bindings.length };
      },
      log,
    };
  }

  // buyer side (only if this node holds a tab config)
  let gateway: GatewayDeps | null = null;
  const buyerCfgPath = join(home, "buyer.json");
  if (existsSync(buyerCfgPath)) {
    try {
      const b = JSON.parse(readFileSync(buyerCfgPath, "utf8")) as {
        sellerApiBase: string; walletEnvFile: string; tabId?: string;
        offerings: Array<{
          id: string; modelId: string; provenanceClass: "weights-pinned" | "upstream-claimed";
          tokenizerBundleRef: string; providerPublicPem: string;
          perInputTokenMicroTrac: number; perOutputTokenMicroTrac: number;
          queryFlatMicroTrac: number; perReturnedQuadMicroTrac: number;
          bundlePath: string;   // local copy of the tokenizer bundle (digest-verified at fetch time)
          bundleKind: "hf" | "tiktoken";
        }>;
      };
      const client = new BuyerClient(b.sellerApiBase, b.walletEnvFile, b.tabId ?? null);
      const gos = new Map<string, GatewayOffering>();
      for (const o of b.offerings) {
        const raw = readFileSync(o.bundlePath, "utf8");
        gos.set(o.modelId, {
          id: o.id, modelId: o.modelId, provenanceClass: o.provenanceClass,
          expectation: {
            tokenizerBundleRef: o.tokenizerBundleRef,
            providerPublicPem: o.providerPublicPem,
            perInputTokenMicroTrac: o.perInputTokenMicroTrac,
            perOutputTokenMicroTrac: o.perOutputTokenMicroTrac,
            queryFlatMicroTrac: o.queryFlatMicroTrac,
            perReturnedQuadMicroTrac: o.perReturnedQuadMicroTrac,
          },
          engine: o.bundleKind === "hf" ? hfEngine(raw) : tiktokenEngine(raw),
        });
      }
      gateway = {
        home, client, offerings: gos,
        countQuads: (body: string) => {
          try { return ((JSON.parse(body) as { bindings?: unknown[] }).bindings ?? []).length; }
          catch { return -1; }
        },
        log,
      };
      log(`gateway mounted: ${gos.size} funded offering(s), seller=${b.sellerApiBase}`);
    } catch (e) {
      log(`gateway NOT MOUNTED: ${String((e as Error).message).slice(0, 120)}`);
    }
  }

  return { front, gateway, loadedAt: Date.now(), configDigestish: JSON.stringify([cfg.enabled, cfg.offerings.length, providerAddress, cfg.apiBase ?? null, cfg.rpcUrl ?? null, buyerCfgStamp()]) };
}

export const plugin: RoutePlugin = {
  name: "nsm-marketplace-v3",
  async handle(ctx: RequestContext): Promise<void> {
    const cfg = loadMarketplaceConfig(dkgHome());
    if (!cfg.enabled) return;                       // flag off ⇒ routes ABSENT

    const path = ctx.path;
    if (!path.startsWith(BASE + "/")) return;

    const log = (line: string) => console.log(`[marketplace] ${line}`);
    const digestish = JSON.stringify([cfg.enabled, cfg.offerings.length, cfg.providerAddress ?? null, cfg.apiBase ?? null, cfg.rpcUrl ?? null, buyerCfgStamp()]);
    if (!mounted || mounted.configDigestish !== digestish) {
      mounted = await mount(cfg, ctx, log);
    }

    // ── SWM lane executor (DKG-native transport): start once, on the first
    // request, if a seller front is mounted and a lane CG is configured. Uses
    // the node's own loopback + in-process token — no VPN, no secret embedded.
    if (!laneStarted && mounted.front && cfg.laneContextGraphId) {
      laneStarted = true;
      const token = cfg.nodeToken ?? [...ctx.validTokens][0] ?? "";
      startLaneExecutor({
        home: marketplaceHome(dkgHome()),
        nodeBase: `http://127.0.0.1:${ctx.apiPortRef.value}`,
        nodeToken: token,
        contextGraphId: cfg.laneContextGraphId,
        basePath: BASE,
        pollMs: 3000,
        log,
      });
    }

    const req = ctx.req as unknown as Parameters<typeof handleFront>[1];
    const res = ctx.res as unknown as Parameters<typeof handleFront>[2];

    // ── node-native upstream OAuth (CP3 as a node capability). Operator-only:
    // loopback or node token. The node returns the authorize URL for the HUMAN
    // to open in a browser; tokens land in the node's secret store and are
    // NEVER returned over HTTP.
    if (path === BASE + "/operate/upstream-auth/start" || path === BASE + "/operate/upstream-auth/status") {
      const auth = String(ctx.req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const remote = ctx.req.socket.remoteAddress ?? "";
      const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (!local && !ctx.validTokens.has(auth)) {
        ctx.res.writeHead(401, { "content-type": "application/json" });
        ctx.res.end('{"error":"E_TOKEN"}');
        return;
      }
      const { startCodexAuthFlow, flowStatus } = await import("./seller/oauth-flow.js");
      const secretPath = join(marketplaceHome(dkgHome()), ".secrets", "codex-auth.json");
      const state = path.endsWith("/start") && (ctx.req.method ?? "").toUpperCase() === "POST"
        ? startCodexAuthFlow(secretPath)
        : flowStatus();
      const body = JSON.stringify({ ...state, secretPath: path.endsWith("/start") ? secretPath : undefined });
      ctx.res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
      ctx.res.end(body);
      return;
    }

    // ── buyer actions (v3.5: the UI's Fund step runs node-side — the browser
    // never holds keys or talks to an RPC). Operator-only: loopback or token.
    if (path === BASE + "/buyer/wallet" || path === BASE + "/buyer/fund" || path === BASE + "/buyer/fund/status") {
      const auth = String(ctx.req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const remote = ctx.req.socket.remoteAddress ?? "";
      const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (!local && !ctx.validTokens.has(auth)) {
        ctx.res.writeHead(401, { "content-type": "application/json" });
        ctx.res.end('{"error":"E_TOKEN"}');
        return;
      }
      const { walletStatus, fundTab, fundStatus } = await import("./buyer/actions.js");
      const home = marketplaceHome(dkgHome());
      const method = (ctx.req.method ?? "GET").toUpperCase();
      let out: Record<string, unknown>;
      try {
        if (path.endsWith("/buyer/wallet")) out = await walletStatus(home);
        else if (path.endsWith("/fund/status")) out = await fundStatus(home);
        else if (method === "POST") {
          const chunks: Buffer[] = [];
          for await (const c of ctx.req as unknown as AsyncIterable<Buffer>) chunks.push(c);
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { amountMicroTrac?: number };
          out = await fundTab(home, Number(parsed.amountMicroTrac ?? 0));
          log(`buyer-fund ${JSON.stringify(out).slice(0, 140)}`);
        } else out = { error: "E_METHOD" };
      } catch (e) {
        out = { error: "E_BUYER_ACTION", detail: String((e as Error).message).slice(0, 160) };
      }
      const body = JSON.stringify(out);
      ctx.res.writeHead(out.error ? 400 : 200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
      ctx.res.end(body);
      return;
    }

    // ── operator status (drives the node-UI Offerings/Tabs/Access views).
    // Gated on the node's own Bearer token or loopback — never part of the
    // public wire contract.
    if (path === BASE + "/operate/status") {
      const auth = String(ctx.req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const remote = ctx.req.socket.remoteAddress ?? "";
      const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (!local && !ctx.validTokens.has(auth)) {
        ctx.res.writeHead(401, { "content-type": "application/json" });
        ctx.res.end('{"error":"E_TOKEN"}');
        return;
      }
      const body = JSON.stringify(await operateStatus(cfg, mounted));
      ctx.res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
      ctx.res.end(body);
      return;
    }

    if (mounted.gateway && (await handleGateway(mounted.gateway, req, res, path, BASE))) return;
    if (mounted.front && (await handleFront(mounted.front, req, res, path, BASE))) return;
    // no match ⇒ fall through ⇒ daemon 404 (withdraw/settle/credit/release land here)
  },
};

// Threshold economics for the operate meter. Conservative Base-mainnet gas
// estimate; ε from the frozen Iteration-2 cost contract.
const SETTLE_GAS_MICROTRAC = 2941;   // ~gas cost of a settlement, µTRAC-denominated estimate
const EPSILON = 0.001;

async function operateStatus(cfg: MarketplaceConfig, m: Mounted): Promise<Record<string, unknown>> {
  const home = marketplaceHome(dkgHome());
  const { tabsAll, tabQuantities } = await import("./seller/tabs.js");
  const { legStatus, providerMaySettleV3 } = await import("./seller/front.js");
  const { listKeys, keySpent } = await import("./gateway/keys.js");
  const { readFileSync: rf, existsSync: ex } = await import("node:fs");
  const { join: j } = await import("node:path");

  const tabs = tabsAll(home).map((t) => {
    const q = tabQuantities(home, t.principal);
    return { ...t, quantities: q };
  });
  const legs = ex(j(home, "legs.jsonl"))
    ? rf(j(home, "legs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
  const legRows = legs.filter((l) => l.type === "leg").map((l) => ({
    legId: l.legId, legType: l.legType, tabId: l.tabId, offeringId: l.offeringId,
    provenanceClass: l.provenanceClass, cost: (l.pricing as { costMicroTrac?: number })?.costMicroTrac,
    status: legStatus(home, String(l.legId)),
    at: l.at,
  }));
  const unsettledEarned = tabs.reduce((s, t) => s + t.quantities.billed - t.quantities.released, 0);
  const election = providerMaySettleV3({ unsettledEarnedMicroTrac: unsettledEarned, gasMicroTrac: SETTLE_GAS_MICROTRAC, epsilon: EPSILON });

  // Buyer-side summary — ONLY what this node can know locally: its tab id and
  // its gateway-key accounting. The refundable balance lives on the SELLER's
  // ledger and is confirmed at close; the wire contract deliberately has no
  // public tab-status endpoint, so the UI must not pretend to know it.
  // (Hermes, #neurosymbolic-ai event 58c565ac: the provider settlement meter
  // rendered as an empty bar on his buyer-only node — provider-local metric
  // shown without a seller context.)
  let buyer: Record<string, unknown> | null = null;
  {
    const bp = j(home, "buyer.json");
    if (ex(bp)) {
      try {
        const b = JSON.parse(rf(bp, "utf8")) as { tabId?: string; sellerApiBase?: string };
        const ks = listKeys(home);
        // wallet address is derivable locally (never the key itself)
        let address: string | null = null;
        try { address = m.gateway?.client.address() ?? null; } catch { address = null; }
        buyer = {
          tabId: b.tabId ?? null,
          address,
          transport: b.sellerApiBase ?? null,
          keyCount: ks.length,
          totalBudgetMicroTrac: ks.reduce((s2, k) => s2 + Number(k.scopes.budgetMicroTrac ?? 0), 0),
          totalSpentMicroTrac: ks.reduce((s2, k) => s2 + keySpent(home, k.keyId), 0),
        };
      } catch { buyer = null; }
    }
  }

  return {
    enabled: cfg.enabled,
    sellerActive: !!m.front && [...m.front.offerings.values()].length > 0,
    buyer,
    offerings: m.front ? [...m.front.offerings.values()]
      .filter((v, i, a) => a.findIndex((x) => x.offering.id === v.offering.id) === i)
      .map((ob) => ({
        id: ob.offering.id,
        provenanceClass: ob.offering.provenanceClass,
        modelId: ob.binding.kind === "llamacpp" ? ob.binding.modelId : ob.binding.model,
        tokenizerBundleRef: ob.tokenizerBundleRef,
        pricing: {
          perInputTokenMicroTrac: ob.offering.perInputTokenMicroTrac,
          perOutputTokenMicroTrac: ob.offering.perOutputTokenMicroTrac,
          queryFlatMicroTrac: ob.offering.queryFlatMicroTrac,
          perReturnedQuadMicroTrac: ob.offering.perReturnedQuadMicroTrac,
        },
        offeringUal: ob.offeringUal ?? null,
      })) : [],
    tabs, legs: legRows,
    threshold: { unsettledEarnedMicroTrac: unsettledEarned, ...election },
    keys: listKeys(home).map((k) => ({ ...k, spentMicroTrac: keySpent(home, k.keyId) })),
  };
}

export default plugin;
