// Phase 3 drill — the v3 incident ON SCREEN: a lane-transport leg is served
// and billed, no delivery ever lands, and the seller's Operate view shows the
// ◷ countdown ticking to the deadline; the sweep then auto-voids it and the
// ledger reverses — all watched in the real UI, unattended.
//
// Usage: node scripts/phase3-drill.mjs
import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(pkg, "package.json"));
const { chromium } = require("@playwright/test");
const marketRequire = createRequire(join(homedir(), "odysseus-dkg-proto/dkg-v35/packages/marketplace/package.json"));
const { Wallet } = marketRequire("ethers");

const REPO = join(homedir(), "odysseus-dkg-proto/dkg-v35");
const DIST = join(REPO, "packages/marketplace/dist");
const SELLER_HOME = join(REPO, ".devnet/node1");
const BUYER_HOME = join(REPO, ".devnet/node2");
const SELLER_MKT = "http://127.0.0.1:9401/marketplace";
const BUYER_API = "http://127.0.0.1:9402";
const EV = join(homedir(), "odysseus-dkg-proto/nsm-v35-evidence/phase3");
mkdirSync(EV, { recursive: true });
const PORT = 5196;

const { buildAuthStatement } = await import(join(DIST, "seller/auth.js"));
const log = (m) => { console.log(`[drill] ${m}`); appendFileSync(join(EV, "drill-log.jsonl"), JSON.stringify({ m, at: new Date().toISOString() }) + "\n"); };
const t2 = readFileSync(join(BUYER_HOME, "auth.token"), "utf8").trim().split("\n").filter((l) => !l.startsWith("#")).pop();

// ── 1. fund a fresh tab through the SAME node rail the UI uses ──
const post = async (path, body) => {
  const r = await fetch(BUYER_API + path, {
    method: body !== undefined ? "POST" : "GET",
    headers: { authorization: `Bearer ${t2}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  return r.json();
};
const funded = await post("/marketplace/buyer/fund", { amountMicroTrac: 1_000_000 });
if (funded.error) throw new Error("fund failed: " + JSON.stringify(funded));
log(`deposit sent ${funded.txHash}`);
let tabId = null;
for (let i = 0; i < 60; i++) {
  const st = await post("/marketplace/buyer/fund/status");
  if (st.state === "funded") { tabId = st.tabId; break; }
  await new Promise((r) => setTimeout(r, 3000));
}
if (!tabId) throw new Error("tab never opened");
log(`tab open: ${tabId}`);

// ── 2. signed LANE-transport chat straight at the seller front: billed at
// serve, born pending-delivery with a 5-minute deadline, and no lane executor
// will ever deliver it (the drill) ──
const walletEnv = readFileSync(join(BUYER_HOME, ".secrets-buyer-wallet.env"), "utf8");
const key = walletEnv.split("\n").find((l) => l.startsWith("BUYER_WALLET_KEY=")).slice("BUYER_WALLET_KEY=".length).trim();
const wallet = new Wallet(key);
const signedChat = async (extra) => {
  const payload = { model: "Qwen2.5-7B-Instruct-Q4_K_M", messages: [{ role: "user", content: "One sentence on knowledge graphs." }], max_tokens: 24 };
  const body = Buffer.from(JSON.stringify(payload));
  const nonce = randomBytes(12).toString("hex");
  const stmt = buildAuthStatement({ method: "POST", path: "/v1/chat/completions", body, tabId, nonce });
  const sig = await wallet.signMessage(stmt);
  const res = await fetch(SELLER_MKT + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-nsm-tab": tabId, "x-nsm-address": wallet.address, "x-nsm-nonce": nonce, "x-nsm-signature": sig, ...extra },
    body,
    signal: AbortSignal.timeout(300_000),
  });
  return { status: res.status, body: await res.json() };
};
const laneLeg = await signedChat({ "x-nsm-transport": "lane" });
if (laneLeg.status !== 200) throw new Error("lane serve failed: " + JSON.stringify(laneLeg.body).slice(0, 200));
const legId = laneLeg.body.nsm.leg.legId;
const deadline = laneLeg.body.nsm.leg.deliveryDeadline;
log(`lane leg served+billed: ${legId} (${laneLeg.body.nsm.leg.pricing.costMicroTrac}µ), deadline ${deadline}`);

// ── 3. watch it in the SELLER's Operate view ──
const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  cwd: pkg, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, DKG_UI_HOME: SELLER_HOME },
});
await new Promise((res) => vite.stdout.on("data", (d) => { if (String(d).includes("Local:")) res(); }));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, recordVideo: { dir: EV, size: { width: 1440, height: 900 } } });
const page = await ctx.newPage();
const shot = async (name) => {
  await page.evaluate(() => {
    for (const el of [document.documentElement, document.body]) { el.style.height = "auto"; el.style.overflow = "visible"; }
    const p = document.querySelector(".nsmx--page"); if (p) { p.style.height = "auto"; p.style.overflow = "visible"; }
  }).catch(() => {});
  await page.screenshot({ path: join(EV, name), fullPage: true });
  log(`📷 ${name}`);
};

try {
  await page.goto(`http://localhost:${PORT}/ui/?marketplace=1`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator(".v10-tree-dashboard", { hasText: "Operate" }).first().click({ force: true });
  await page.waitForSelector(".nsmx .gauge-radial", { timeout: 30_000 });
  // pending row with live countdown
  await page.waitForSelector(".nsmx .chip--pending", { timeout: 30_000 });
  const cd1 = await page.locator(".nsmx .countdown").first().innerText();
  log(`Operate shows ◷ pending with countdown: ${cd1}`);
  await shot("14-operate-pending-countdown.png");

  // countdown visibly ticks
  await page.waitForTimeout(5000);
  const cd2 = await page.locator(".nsmx .countdown").first().innerText();
  log(`countdown ticked: ${cd1} → ${cd2} (${cd1 !== cd2 ? "LIVE" : "static?!"})`);

  // ── 4. wait out the deadline (real 5-minute lane deadline — no fixture
  // seam on a running node; honesty means waiting) ──
  const msLeft = Date.parse(deadline) - Date.now();
  log(`waiting ${Math.ceil(msLeft / 1000)}s for the delivery deadline…`);
  if (msLeft > 0) await new Promise((r) => setTimeout(r, msLeft + 3000));

  // any serve sweeps expired deliveries — fire a direct chat to trigger it
  const sweep = await signedChat({});
  log(`sweep-trigger chat: ${sweep.status} (leg ${sweep.body?.nsm?.leg?.legId ?? "?"})`);

  // Operate refreshes every 15s — wait for the voided chip
  await page.waitForFunction(() => document.body.innerText.includes("Never delivered"), { timeout: 60_000 });
  log("Operate shows the leg VOIDED (bill canceled automatically) — the incident, handled honestly, on screen");
  await shot("15-operate-voided.png");

  // ── 5. ledger truth: billing reversed on the seller's ledger ──
  const { tabQuantities } = await import(join(DIST, "seller/tabs.js"));
  const q = tabQuantities(join(SELLER_HOME, "marketplace"), wallet.address);
  log(`seller ledger after void: billed=${q.billed} balance=${q.balance} (voided leg's charge reversed)`);
  appendFileSync(join(EV, "drill-log.jsonl"), JSON.stringify({ verdict: "pending→voided on screen", legId, quantities: q }) + "\n");
} finally {
  await ctx.close();
  await browser.close();
  vite.kill("SIGTERM");
}
console.log("drill complete");
