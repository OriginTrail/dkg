// NSM v3.5 spec-pack sync — docs/ui-spec is the authority (CLAUDE.md rules 2–3);
// this script projects it into the UI build so components can only consume the
// law, never restate it:
//   docs/ui-spec/tokens.css    → src/ui/styles/30-nsm-tokens.css   (verbatim + header)
//   docs/ui-spec/fixtures.json → src/ui/nsm/fixtures.json          (verbatim)
//   docs/ui-spec/UI-COPY.md    → src/ui/nsm/copy.generated.ts      (string table by key)
// Run: pnpm --filter @origintrail-official/dkg-node-ui nsm:sync
// `nsm:sync --check` exits 1 if the committed projections have drifted.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const specDir = join(pkg, "../../docs/ui-spec");
const check = process.argv.includes("--check");
let drift = 0;

function project(outPath, content) {
  if (check) {
    let current = "";
    try { current = readFileSync(outPath, "utf8"); } catch {}
    if (current !== content) { console.error(`DRIFT: ${outPath} — run nsm:sync`); drift = 1; }
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content);
  console.log(`synced ${outPath}`);
}

// ── tokens ──
const tokens = readFileSync(join(specDir, "tokens.css"), "utf8");
project(
  join(pkg, "src/ui/styles/30-nsm-tokens.css"),
  `/* GENERATED from docs/ui-spec/tokens.css — edit THERE, then run nsm:sync. */\n` + tokens,
);

// ── fixtures ──
const fixtures = readFileSync(join(specDir, "fixtures.json"), "utf8");
project(join(pkg, "src/ui/nsm/fixtures.json"), fixtures);

// ── copy table ──
const md = readFileSync(join(specDir, "UI-COPY.md"), "utf8");
const copyTable = {};
const withholdCode = {};
for (const line of md.split("\n")) {
  const m = line.match(/^\|\s*([a-z][a-z0-9.\-]+)\s*\|\s*(.+?)\s*\|(?:\s*(.+?)\s*\|)?\s*$/);
  if (!m) continue;
  const [, key, str, third] = m;
  if (key === "key") continue;
  copyTable[key] = str;
  if (third && /^E_[A-Z_]+$/.test(third)) withholdCode[key] = third;
}
if (!copyTable["state.verified"]) throw new Error("UI-COPY parse failed: state.verified missing");

const ts = `// GENERATED from docs/ui-spec/UI-COPY.md — do not edit; run nsm:sync.
// Rule 3: a string not in the table doesn't ship. Components render via copy(key).
export const COPY: Record<string, string> = ${JSON.stringify(copyTable, null, 2)};

/** withhold.* key → the exact code shown one reveal deeper (drawer only). */
export const WITHHOLD_CODE: Record<string, string> = ${JSON.stringify(withholdCode, null, 2)};

/** code → withhold.* key (for rendering a leg's plain-words reason). */
export const CODE_TO_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(WITHHOLD_CODE).map(([k, c]) => [c, k]),
);

export function copy(key: string, params?: Record<string, string | number>): string {
  let s = COPY[key] ?? \`⟦missing copy: \${key}⟧\`;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(\`{\${k}}\`).join(String(v));
  return s;
}
`;
project(join(pkg, "src/ui/nsm/copy.generated.ts"), ts);

process.exit(drift);
