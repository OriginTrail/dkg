// Lint-enforced import boundary (prompt rule): this package may import ONLY
//   · node builtins ("node:*")
//   · its own modules (relative paths)
//   · declared npm deps (ethers)
//   · the host's PUBLIC plugin API: @origintrail-official/dkg/daemon/plugin-api
// Any deep import into the host (../cli/src/…, @origintrail-official/dkg/dist/…)
// is a boundary violation and fails the build.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../src", import.meta.url).pathname;
const ALLOWED_BARE = new Set(["ethers", "@origintrail-official/dkg/daemon/plugin-api"]);

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "__tests__" ? [] : walk(p);
    return p.endsWith(".ts") ? [p] : [];
  });
}

let violations = 0;
for (const file of walk(ROOT)) {
  const src = readFileSync(file, "utf8")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n")   // strip line comments
    .replace(/\/\*[\s\S]*?\*\//g, "");                             // strip block comments
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^;"]*?from\s+"([^"]+)"|import\s*\(\s*"([^"]+)"\s*\)/g)) {
    const spec = m[1] ?? m[2];
    if (!spec) continue;
    if (spec.startsWith("node:")) continue;
    if (spec.startsWith("./") || spec.startsWith("../")) {
      if (spec.includes("/cli/") || spec.includes("packages/")) {
        console.error(`BOUNDARY: ${file} deep-imports the host via relative path: ${spec}`);
        violations++;
      }
      continue;
    }
    if (!ALLOWED_BARE.has(spec)) {
      console.error(`BOUNDARY: ${file} imports "${spec}" — not in the allowed set`);
      violations++;
    }
  }
}
if (violations) { console.error(`${violations} boundary violation(s)`); process.exit(1); }
console.log("import boundary clean: node builtins + ethers + plugin-api only");
