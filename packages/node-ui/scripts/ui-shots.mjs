// §Loop step 2 — Playwright captures of the NSM surfaces + the /dev/gallery
// at 1440×900 and 390×844, into docs/ui-spec/shots/<date>/.
//
// Boots its own vite dev server on a scratch port (no node needed for
// fixture-fed pages; live surfaces degrade to their honest error/empty states
// when /api is absent — that's a valid shot).
//
// Usage: pnpm --filter @origintrail-official/dkg-node-ui ui:shots [outDir]
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(pkg, "package.json"));
const { chromium } = require("@playwright/test");

const PORT = 5199;
const stamp = new Date().toISOString().slice(0, 10);
const out = process.argv[2] ?? join(pkg, "../../docs/ui-spec/shots", stamp);
mkdirSync(out, { recursive: true });

// Every NSM page the loop must look at. Surfaces register here as they
// integrate (one per commit); `actions` runs before the capture (e.g. click
// into a marketplace tab).
const SHOTS = [
  { name: "gallery", path: "/ui/dev/gallery" },
  { name: "marketplace", path: "/ui/?marketplace=1", actions: async (page) => {
    await page.locator(".v10-tree-dashboard", { hasText: "Marketplace" }).first().click({ timeout: 15_000, force: true });
    // wait until discovery settles (skeletons gone) — slow graphs are real
    await page.waitForFunction(() => !document.querySelector(".nsmx .skel"), { timeout: 120_000 }).catch(() => {});
    await page.waitForTimeout(500);
  } },
  { name: "operate", path: "/ui/?marketplace=1", actions: async (page) => {
    await page.locator(".v10-tree-dashboard", { hasText: "Operate" }).first().click({ timeout: 15_000, force: true });
    await page.waitForTimeout(4000);
  } },
];

const viewports = [
  { tag: "desktop", width: 1440, height: 900 },
  { tag: "mobile", width: 390, height: 844 },
];

// ── boot vite ──
const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
  cwd: pkg, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, DKG_UI_HOME: process.env.DKG_UI_HOME ?? "" },
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("vite didn't start in 30s")), 30_000);
  vite.stdout.on("data", (d) => { if (String(d).includes("Local:")) { clearTimeout(t); resolve(); } });
  vite.stderr.on("data", (d) => process.stderr.write(d));
  vite.on("exit", (c) => reject(new Error(`vite exited ${c}`)));
});

try {
  const browser = await chromium.launch();
  for (const vp of viewports) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    for (const shot of SHOTS) {
      try {
        await page.goto(`http://localhost:${PORT}${shot.path}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await page.waitForTimeout(1500);
        if (shot.actions) await shot.actions(page);
        await page.waitForTimeout(250);
        // the shell locks body scroll; unlock so fullPage captures everything
        await page.evaluate(() => {
          for (const el of [document.documentElement, document.body]) { el.style.height = "auto"; el.style.overflow = "visible"; }
          const p = document.querySelector(".nsmx--page");
          if (p) { p.style.height = "auto"; p.style.overflow = "visible"; }
        });
        const name = `${shot.name}-${vp.tag}.png`;
        await page.screenshot({ path: join(out, name), fullPage: true });
        console.log(name);
      } catch (e) {
        console.error(`SHOT FAILED ${shot.name}-${vp.tag}: ${e.message}`);
      }
    }
    await ctx.close();
  }
  await browser.close();
} finally {
  vite.kill("SIGTERM");
}
console.log(`→ ${out}`);
