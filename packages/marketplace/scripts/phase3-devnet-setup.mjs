// v3.5 Phase 3 — devnet two-seat setup (seller node1 :9401, buyer node2 :9402).
//
// Prepares BOTH seats so the rehearsal journey can run THROUGH THE UI:
//   · seller: marketplace config (⛓ Qwen2.5-7B via llama.cpp :8080), plugin
//     mounted via routePlugins, offering + canonical Model KA published to the
//     public CG `nsm-devnet35`
//   · buyer: wallet env from the node's own (devnet-funded) wallet, buyer.json
//     WITHOUT a tabId — funding + tab-open happen in the onboarding UI, that's
//     the point of the rehearsal
//   · both nodes subscribed to the market CG so catalog discovery is real
//
// Run: node packages/marketplace/scripts/phase3-devnet-setup.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const REPO = join(homedir(), "odysseus-dkg-proto/dkg-v35");
const DEV = join(REPO, ".devnet");
const DIST = join(REPO, "packages/marketplace/dist");
const CLI = join(REPO, "packages/cli/dist/cli.js");

const SELLER = { dir: join(DEV, "node1"), api: "http://127.0.0.1:9401" };
const BUYER = { dir: join(DEV, "node2"), api: "http://127.0.0.1:9402" };
const RPC = "http://127.0.0.1:8556";
const CHAIN_ID = 31337;
const CG = "nsm-devnet35";
const MODELS = join(homedir(), "odysseus-dkg-proto/models");
const BUNDLE = join(homedir(), "odysseus-dkg-proto/inference-recount-matrix/buyer-bundle");

const log = (m) => console.log(`[p3] ${m}`);
const token = (dir) => readFileSync(join(dir, "auth.token"), "utf8").trim().split("\n").filter((l) => !l.startsWith("#")).pop();

// TRAC token address from the localhost deployment
const dep = JSON.parse(readFileSync(join(REPO, "packages/evm-module/deployments/localhost_contracts.json"), "utf8"));
const TRAC = (dep.contracts ?? dep).Token?.evmAddress ?? (dep.contracts ?? dep).Token;
if (!/^0x[0-9a-fA-F]{40}$/.test(String(TRAC))) throw new Error(`no Token address (${TRAC})`);
log(`devnet TRAC: ${TRAC}`);

const call = async (base, tok, path, body, method) => {
  const res = await fetch(base + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { "content-type": "application/json", authorization: `Bearer ${tok}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* raw */ }
  return { status: res.status, json, text };
};

// ── 1. seller wallet (providerAddress) ──
const wallets1 = JSON.parse(readFileSync(join(SELLER.dir, "wallets.json"), "utf8"));
const sellerW = (Array.isArray(wallets1) ? wallets1 : wallets1.wallets)[0];
log(`seller providerAddress: ${sellerW.address}`);

// ── 2. seller marketplace config ──
mkdirSync(join(SELLER.dir, "marketplace"), { recursive: true });
writeFileSync(join(SELLER.dir, "marketplace/config.json"), JSON.stringify({
  enabled: true,
  providerAddress: sellerW.address,
  apiBase: `${SELLER.api}/marketplace`,
  chainId: CHAIN_ID,
  rpcUrl: RPC,
  tracContract: TRAC,
  offerings: [
    {
      id: "qwen25-7b-devnet35",
      provenanceClass: "weights-pinned",
      connector: {
        kind: "llamacpp",
        baseUrl: "http://127.0.0.1:8080",
        ggufPath: join(MODELS, "Qwen2.5-7B-Instruct-Q4_K_M.gguf"),
        tokenizerDir: BUNDLE,
        settings: { seed: 42, temperature: 0, ctx: 32768 },
      },
      perInputTokenMicroTrac: 2,
      perOutputTokenMicroTrac: 6,
      queryFlatMicroTrac: 5,
      perReturnedQuadMicroTrac: 1,
    },
  ],
  laneContextGraphId: CG,
}, null, 2));
log("seller marketplace/config.json written");

// ── 3. routePlugins on both nodes ──
for (const seat of [SELLER, BUYER]) {
  const p = join(seat.dir, "config.json");
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  cfg.routePlugins = [join(DIST, "plugin.js")];
  writeFileSync(p, JSON.stringify(cfg, null, 2));
}
log("routePlugins set on node1 + node2");

// ── 4. buyer wallet env (from node2's devnet-funded op wallet; 0600) ──
const wallets2 = JSON.parse(readFileSync(join(BUYER.dir, "wallets.json"), "utf8"));
const buyerW = (Array.isArray(wallets2) ? wallets2 : wallets2.wallets)[0];
const WALLET_ENV = join(BUYER.dir, ".secrets-buyer-wallet.env");
writeFileSync(WALLET_ENV, `BUYER_WALLET_KEY=${buyerW.privateKey}\n`, { mode: 0o600 });
log(`buyer wallet: ${buyerW.address}`);

// ── 5. restart both nodes so the plugin mounts ──
for (const [name, seat] of [["node1", SELLER], ["node2", BUYER]]) {
  log(`restarting ${name}…`);
  const env = { ...process.env, DKG_HOME: seat.dir, DKG_NO_BLUE_GREEN: "1", DKG_WALLETS_NO_MIGRATE: "1" };
  try { execFileSync("node", [CLI, "stop"], { env, stdio: "pipe", timeout: 60_000 }); } catch { /* not running */ }
  // cli `start` exits non-zero when boot exceeds its 15s readiness window even
  // though the daemon comes up fine — we poll the API ourselves below
  try { execFileSync("node", [CLI, "start"], { env, stdio: "pipe", timeout: 180_000 }); }
  catch { log(`${name} start exceeded the cli readiness window — polling API instead`); }
}
log("both nodes restarted");

// wait for APIs
for (const [name, seat] of [["node1", SELLER], ["node2", BUYER]]) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(seat.api + "/api/status", { headers: { authorization: `Bearer ${token(seat.dir)}` }, signal: AbortSignal.timeout(3000) });
      if (r.ok) break;
    } catch { /* booting */ }
    await new Promise((r) => setTimeout(r, 2000));
    if (i === 59) throw new Error(`${name} API never came up`);
  }
  log(`${name} API up`);
}
const t1 = token(SELLER.dir);
const t2 = token(BUYER.dir);

// ── 6. market CG on the seller + seed knowledge for metered queries ──
const created = await call(SELLER.api, t1, "/api/context-graph/create", { contextGraphId: CG, name: CG });
log(`CG create: ${created.status} ${JSON.stringify(created.json)?.slice(0, 120)}`);
await call(SELLER.api, t1, `/api/knowledge-assets/nsm-seed/wm/write`, {
  contextGraphId: CG,
  quads: [
    { subject: "urn:nsm:demo:alpha", predicate: "http://schema.org/name", object: JSON.stringify("Alpha") },
    { subject: "urn:nsm:demo:beta", predicate: "http://schema.org/name", object: JSON.stringify("Beta") },
    { subject: "urn:nsm:demo:gamma", predicate: "http://schema.org/name", object: JSON.stringify("Gamma") },
  ],
});
await call(SELLER.api, t1, `/api/knowledge-assets/nsm-seed/wm/finalize`, { contextGraphId: CG });
log("seed knowledge finalized");

// buyer subscribes (catalog discovery is real node-to-node)
const sub = await call(BUYER.api, t2, "/api/context-graph/subscribe", { contextGraphId: CG });
log(`buyer subscribe: ${sub.status} ${JSON.stringify(sub.json)?.slice(0, 120)}`);

// ── 7. publish offering + Model KA (the wizard's path, headless) ──
const pub = await call(SELLER.api, t1, "/marketplace/operate/publish", { offeringId: "qwen25-7b-devnet35", contextGraphId: CG });
log(`offering publish: ${pub.status} ${JSON.stringify(pub.json)?.slice(0, 200)}`);

// ── 8. buyer.json from the seller's LIVE VERIFIED terms (no tabId — the UI funds) ──
const termsRes = await fetch(`${SELLER.api}/marketplace/terms`, { signal: AbortSignal.timeout(15_000) });
const terms = await termsRes.json();
if (termsRes.status !== 402 || !terms.quote) throw new Error(`terms bootstrap failed: ${termsRes.status}`);
const off = terms.quote.offerings[0];
mkdirSync(join(BUYER.dir, "marketplace"), { recursive: true });
writeFileSync(join(BUYER.dir, "marketplace/buyer.json"), JSON.stringify({
  sellerApiBase: `${SELLER.api}/marketplace`,
  walletEnvFile: WALLET_ENV,
  rpcUrl: RPC,
  tracContract: TRAC,
  chainId: CHAIN_ID,
  offerings: [
    {
      id: off.id, modelId: off.modelId, provenanceClass: off.provenanceClass,
      tokenizerBundleRef: off.tokenizerBundleRef,
      providerPublicPem: terms.providerPublicPem,
      perInputTokenMicroTrac: off.perInputTokenMicroTrac,
      perOutputTokenMicroTrac: off.perOutputTokenMicroTrac,
      queryFlatMicroTrac: off.queryFlatMicroTrac,
      perReturnedQuadMicroTrac: off.perReturnedQuadMicroTrac,
      bundlePath: join(BUNDLE, "tokenizer.json"),
      bundleKind: "hf",
    },
  ],
}, null, 2));
log("buyer.json written (no tabId — the onboarding UI funds the tab)");

// ── 9. balances sanity ──
const bal = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{
    to: TRAC, data: "0x70a08231" + buyerW.address.slice(2).toLowerCase().padStart(64, "0"),
  }, "latest"] }) }).then((r) => r.json());
const tracWei = BigInt(bal.result ?? "0x0");
log(`buyer TRAC balance: ${tracWei / 10n ** 18n} TRAC`);
log("── setup complete ──");
log(`UI:  DKG_UI_HOME=${BUYER.dir} pnpm --filter @origintrail-official/dkg-node-ui ui:gallery`);
log(`seller UI: DKG_UI_HOME=${SELLER.dir}`);
