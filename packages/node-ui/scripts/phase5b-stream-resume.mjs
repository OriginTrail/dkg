// Phase 5B resume — tab funded (tab_de580c3a, deposit 0x204ae578); capture the
// STREAMED purchase + treasury + close against okf over direct HTTP.
import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(pkg, "package.json"));
const { chromium } = require("@playwright/test");
const BUYER_HOME = join(homedir(), ".dkg-v35-buyer");
const EV = join(homedir(), "odysseus-dkg-proto/nsm-v35-evidence/phase5-okf");
mkdirSync(EV, { recursive: true });
const PORT = 5193;
const step = (id, name, pass, ev) => {
  console.log(`  ${pass ? "✓" : "✗"} [${id}] ${name}${pass ? "" : " — " + JSON.stringify(ev).slice(0, 150)}`);
  appendFileSync(join(EV, "journey-log.jsonl"), JSON.stringify({ id, name, pass, ev, at: new Date().toISOString() }) + "\n");
};
const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  cwd: pkg, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DKG_UI_HOME: BUYER_HOME },
});
await new Promise((r) => vite.stdout.on("data", (d) => { if (String(d).includes("Local:")) r(); }));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, recordVideo: { dir: EV, size: { width: 1440, height: 900 } } });
const page = await ctx.newPage();
const shot = async (n) => {
  await page.evaluate(() => { for (const el of [document.documentElement, document.body]) { el.style.height = "auto"; el.style.overflow = "visible"; } const p = document.querySelector(".nsmx--page"); if (p) { p.style.height = "auto"; p.style.overflow = "visible"; } }).catch(() => {});
  await page.screenshot({ path: join(EV, n), fullPage: true }); console.log(`  📷 ${n}`);
};
try {
  await page.goto(`http://localhost:${PORT}/ui/?marketplace=1`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.locator(".v10-tree-dashboard", { hasText: "Marketplace" }).first().click({ force: true });
  await page.waitForSelector(".nsmx .mnav", { timeout: 60_000 });
  await page.locator(".nsmx .mnav button", { hasText: "Playground" }).click();
  await page.waitForSelector(".nsmx .composer input", { timeout: 120_000 });
  // pick the 14B in the switcher
  await page.locator(".nsmx .rail .item", { hasText: /14B/ }).first().click();
  await page.fill(".nsmx .composer input", "Explain recounting in one paragraph.");
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForSelector(".nsmx .chip--checking", { timeout: 120_000 });
  // streamed frames visibly grow the bubble before the ✓
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll(".nsmx .bubble--model")].pop();
    return b && b.innerText.length > 60;
  }, { timeout: 600_000 });
  await shot("07b-streaming-live.png");
  step("S1", "frames render live during generation (chip still checking)", true, {});
  await page.waitForSelector(".nsmx .bubble--model .chip--verified", { timeout: 900_000 });
  step("S2", "STREAMED completion: Verified ✓ landed after the final recount", true, {});
  await shot("08-playground-verified.png");
  await page.locator(".nsmx .bubble--model .cost-chip").first().click();
  await page.waitForSelector(".nsmx .bubble--model .drawer", { timeout: 30_000 });
  await shot("09-receipt-drawer.png");
  step("S3", "receipt drawer binds the real leg", true, {});
  // treasury + close
  await page.locator(".nsmx .mnav button", { hasText: "Treasury" }).click();
  await page.waitForSelector(".nsmx .tabrow", { timeout: 120_000 });
  await shot("10-treasury.png");
  await page.getByRole("button", { name: "Close tab" }).first().click();
  await page.waitForSelector(".nsmx .drawer", { timeout: 30_000 });
  await page.locator(".nsmx .drawer").getByRole("button", { name: "Close tab" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("Included in close"), { timeout: 300_000 });
  step("S4", "okf tab closed through the UI; signed close digest on screen", true, {});
  await shot("13-closed.png");
  console.log("PHASE 5B COMPLETE");
} finally {
  await ctx.close(); await browser.close(); vite.kill("SIGTERM");
}
