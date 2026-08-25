// Rider-2 probe: every scoped user-facing element inside product frame
// content must carry data-copy. Chrome (.dkg-*) and index.html (dev
// tooling) are out of scope; data-copy="_data" marks content-derived text.
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const SCOPED = /<(h1|h2|button|summary)(\s[^>]*)?>|<a\s+class="(?:[^"]*\b(?:btn|chip)\b[^"]*)"[^>]*>|<span\s+class="(?:[^"]*\bchip\b[^"]*)"[^>]*>/g;
let fail = 0;
for (const f of readdirSync(here).filter((x) => x.endsWith(".html") && x !== "index.html")) {
  const html = readFileSync(join(here, f), "utf8");
  const start = html.indexOf('<div class="frame');
  const end = html.indexOf('<div class="dkg-dock">');
  const frame = html.slice(start, end === -1 ? undefined : end);
  for (const m of frame.matchAll(SCOPED)) {
    if (!/data-copy="/.test(m[0])) { console.log(`  ✗ ${f}: ${m[0].slice(0, 80)}`); fail++; }
  }
}
console.log(fail ? `${fail} unkeyed strings` : "copy-probe clean — zero unkeyed strings");
process.exit(fail ? 1 : 0);
