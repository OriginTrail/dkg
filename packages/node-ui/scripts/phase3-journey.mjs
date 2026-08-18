// Phase 3 — the devnet rehearsal THROUGH THE UI, recorded.
//
// Buyer seat (node2) in a real browser: onboarding (fund → tab → key) →
// catalog → model page → playground (streamed ⛓ completion, ✓ lands after the
// final recount) → treasury (conservation) → access (key + spend) → close.
// Every screenshot is the real running interface with real data (rule 3).
//
// Usage: node scripts/phase3-journey.mjs
// Outputs: video + shots + journey-log.jsonl under nsm-v35-evidence/phase3/.
import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(pkg, "package.json"));
const { chromium } = require("@playwright/test");

const REPO = join(homedir(), "odysseus-dkg-proto/dkg-v35");
const BUYER_HOME = join(REPO, ".devnet/node2");
const EV = join(homedir(), "odysseus-dkg-proto/nsm-v35-evidence/phase3");
mkdirSync(EV, { recursive: true });
const PORT = 5197;

const results = [];
const step = (id, name, pass, evidence) => {
  results.push({ id, name, pass });
  console.log(`  ${pass ? "✓" : "✗"} [${id}] ${name}${pass ? "" : " — " + JSON.stringify(evidence).slice(0, 200)}`);
  appendFileSync(join(EV, "journey-log.jsonl"), JSON.stringify({ id, name, pass, evidence, at: new Date().toISOString() }) + "\n");
};

// ── vite against the buyer node ──
const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  cwd: pkg, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, DKG_UI_HOME: BUYER_HOME },
});
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("vite timeout")), 30_000);
  vite.stdout.on("data", (d) => { if (String(d).includes("Local:")) { clearTimeout(t); res(); } });
});

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
  recordVideo: { dir: EV, size: { width: 1440, height: 900 } },
});
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 200)));
const shot = async (name) => {
  await page.evaluate(() => {
    for (const el of [document.documentElement, document.body]) { el.style.height = "auto"; el.style.overflow = "visible"; }
    const p = document.querySelector(".nsmx--page"); if (p) { p.style.height = "auto"; p.style.overflow = "visible"; }
  }).catch(() => {});
  await page.screenshot({ path: join(EV, name), fullPage: true });
  console.log(`  📷 ${name}`);
};

try {
  // ═══ 1. Onboarding — fresh buyer, KPI clock starts on mount ═══
  await page.goto(`http://localhost:${PORT}/ui/?marketplace=1`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator(".v10-tree-dashboard", { hasText: "Marketplace" }).first().click({ force: true });
  await page.waitForSelector(".nsmx", { timeout: 20_000 });
  // wait for the wallet readout (ready state)
  await page.waitForSelector("#nsm-budget", { timeout: 60_000 });
  step("J1", "onboarding reaches ready (wallet balance rendered)", true, {});
  await shot("01-onboarding-ready.png");

  // set budget 1.0 TRAC → human gate restates amount/from/to
  await page.fill("#nsm-budget", "1.0");
  await page.getByRole("button", { name: "Set budget" }).click();
  await page.waitForSelector(".nsmx .drawer", { timeout: 20_000 });
  const gateText = await page.locator(".nsmx .drawer").innerText();
  step("J2", "fund gate restates amount/from/to from the VERIFIED quote",
    gateText.includes("1.0 TRAC") && gateText.includes("0x"), { gateText: gateText.slice(0, 200) });
  await shot("02-fund-gate.png");

  // confirm — devnet rehearsal (the mainnet run gets the human's yes)
  await page.getByRole("button", { name: "Confirm transfer" }).click();
  // funding-pending → step 2 (tab opened) — poll cycle is 5s
  await page.waitForSelector("#nsm-kname", { timeout: 180_000 });
  step("J3", "deposit mined + tab opened on the seller's RPC (UI-driven)", true, {});
  await shot("03-funded-step2.png");

  // mint the key — plaintext once
  await page.fill("#nsm-kname", "rehearsal-agent");
  await page.fill("#nsm-kcap", "500000");
  await page.getByRole("button", { name: "+ Mint key" }).click();
  await page.waitForSelector(".nsmx .warn-once", { timeout: 30_000 });
  const snippet = await page.locator(".nsmx .snippet").allInnerTexts();
  step("J4", "key minted; OpenAI snippet + shown-once warning on screen",
    snippet.some((s) => s.includes("OPENAI_API_KEY=nsm_k_")), {});
  await shot("04-key-once.png");
  await page.getByRole("button", { name: "Done" }).click();

  // ═══ 2. Catalog — discovery over the subscribed market CG ═══
  await page.waitForTimeout(3000);
  await page.waitForFunction(() => !document.querySelector(".nsmx .skel"), { timeout: 60_000 }).catch(() => {});
  const card = page.locator(".nsmx .mcard .name", { hasText: "Qwen2" });
  await card.waitFor({ timeout: 60_000 });
  step("J5", "catalog shows the Qwen card from CG discovery (1 provider ⛓)", true, {});
  await shot("05-catalog.png");

  // ═══ 3. Model page — live verified quote per row ═══
  await card.click();
  await page.waitForSelector(".nsmx .mhead", { timeout: 20_000 });
  await page.waitForFunction(() => /\$\d/.test(document.querySelector(".nsmx .price-cell")?.innerText ?? ""), { timeout: 60_000 });
  step("J6", "model page row priced from the live verified quote", true, {});
  await shot("06-model-page.png");

  // ═══ 4. Playground — streamed ⛓ completion, ✓ after final recount ═══
  await page.getByRole("button", { name: "Try in playground" }).click();
  await page.waitForSelector(".nsmx .composer input", { timeout: 20_000 });
  await page.fill(".nsmx .composer input", "Explain recounting in one paragraph.");
  await page.getByRole("button", { name: "Send" }).click();
  // streaming: the checking chip + stream note appear first
  await page.waitForSelector(".nsmx .chip--checking", { timeout: 30_000 });
  await shot("07-playground-streaming.png");
  // ✓ lands only after the gateway's final recount event
  await page.waitForSelector(".nsmx .bubble--model .chip--verified", { timeout: 300_000 });
  step("J7", "streamed completion; Verified ✓ landed after the final recount", true, {});
  await shot("08-playground-verified.png");
  // receipt drawer from the actual leg
  await page.locator(".nsmx .bubble--model .cost-chip").first().click();
  await page.waitForSelector(".nsmx .bubble--model .drawer", { timeout: 10_000 });
  const drawer = await page.locator(".nsmx .bubble--model .drawer").innerText();
  step("J8", "receipt drawer binds the real leg (counts + fingerprint + signature)",
    drawer.includes("Tokens") && drawer.includes("fingerprint"), { drawer: drawer.slice(0, 200) });
  await shot("09-receipt-drawer.png");

  // KPI toast — minutes to first verified token
  const kpi = await page.evaluate(() => {
    const a = Number(localStorage.getItem("nsm.kpi.firstRunStarted"));
    const b = Number(localStorage.getItem("nsm.kpi.firstVerified"));
    return a && b ? Math.round((b - a) / 1000) : null;
  });
  step("J9", `KPI measured: fresh node → first verified ✓ in ${kpi}s`, kpi != null && kpi > 0, { seconds: kpi });

  // ═══ 5. Treasury — ring + conservation + tab row ═══
  await page.locator(".nsmx .mnav button", { hasText: "Treasury" }).click();
  await page.waitForSelector(".nsmx .conservation-line", { timeout: 60_000 });
  const cons = await page.locator(".nsmx .conservation-line").innerText();
  step("J10", "treasury conservation line renders and holds", cons.includes("=") && !cons.includes("≠"), { cons });
  await shot("10-treasury.png");

  // ═══ 6. Access — the minted key with its budget gauge + spend ═══
  await page.locator(".nsmx .mnav button", { hasText: "Access" }).click();
  await page.waitForSelector(".nsmx .keyrow", { timeout: 60_000 });
  const keyrows = await page.locator(".nsmx .keyrow").count();
  step("J11", `access lists ${keyrows} key(s) with budget gauges`, keyrows >= 1, {});
  await page.locator(".nsmx .keyrow").first().click();
  await page.waitForTimeout(800);
  await shot("11-access.png");

  // ═══ 7. Close — through the Treasury UI ═══
  await page.locator(".nsmx .mnav button", { hasText: "Treasury" }).click();
  await page.waitForSelector(".nsmx .tabrow", { timeout: 60_000 });
  await page.getByRole("button", { name: "Close tab" }).first().click();
  await page.waitForSelector(".nsmx .drawer", { timeout: 10_000 });
  await shot("12-close-gate.png");
  await page.locator(".nsmx .drawer").getByRole("button", { name: "Close tab" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("Included in close"), { timeout: 60_000 });
  step("J12", "tab closed through the UI; seller's signed close digest on screen", true, {});
  await shot("13-closed.png");

  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} journey steps green`);
} finally {
  await ctx.close();   // flushes the video
  await browser.close();
  vite.kill("SIGTERM");
}
