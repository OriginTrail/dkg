// P5 M-gate mockup shots — same contract as ../shoot.mjs, scoped to p5/.
import { readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../../../packages/node-ui/package.json"));
const { chromium } = require("@playwright/test");
const stamp = new Date().toISOString().slice(0, 10);
const out = process.argv[2] ?? join(here, "../..", "shots", `${stamp}-p5-mgate`);
mkdirSync(out, { recursive: true });
const pages = readdirSync(here).filter((f) => f.endsWith(".html")).sort();
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const browser = await chromium.launch();
for (const vp of viewports) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  for (const f of pages) {
    await page.goto(pathToFileURL(join(here, f)).href);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, `${f.replace(".html", "")}-${vp.name}.png`), fullPage: true });
    console.log(`  📷 ${f} @ ${vp.name}`);
  }
  await ctx.close();
}
await browser.close();
console.log("shots →", out);
