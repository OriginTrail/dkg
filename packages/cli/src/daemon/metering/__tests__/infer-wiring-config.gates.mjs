// The wiring-config parser — PURE, so this suite runs with nothing but node,
// including inside the audit bundle's clean-room verifier.
//
// Every negative here is one of Bo's I0 findings (event fe9485f0) or a member
// of the class he named. The parser's contract: an invalid value PRESENT in the
// config is a rejection that keeps the route unwired at 503 — never a default,
// never "configured but degraded".
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../../../../dist/daemon");
const P = await import(join(dist, "routes/infer-wiring-config.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); } };

const GOOD = {
  baseUrl: "http://127.0.0.1:9312",
  modelId: "Qwen/Qwen2.5-1.5B-Instruct",
  specialTokenIdRanges: [[151643, 151665]],
  expectedTokenizerBundleDigest: "sha256:" + "ab".repeat(32),
};
const parse = (over) => P.parseInferenceBackendConfig({ ...GOOD, ...over });

console.log("\nWiring-config parser — Bo's I0 findings as gates (fe9485f0)\n");

console.log("a valid config parses, with defaults only for ABSENT keys:");
{
  const r = P.parseInferenceBackendConfig(GOOD);
  ok("valid config accepted", r.ok, JSON.stringify(r).slice(0, 120));
  ok("timeoutMs defaults when absent", r.ok && r.cfg.timeoutMs === P.WIRING_LIMITS.timeoutMsDefault);
  ok("maxConcurrent defaults when absent", r.ok && r.cfg.maxConcurrent === P.WIRING_LIMITS.maxConcurrentDefault);
  ok("special ranges expand to the full id set", r.ok && r.cfg.specialTokenIds.length === 23 && r.cfg.specialTokenIds[0] === 151643);
  ok("baseUrl is normalized to scheme + literal host + port only", r.ok && r.cfg.baseUrl === "http://127.0.0.1:9312");
}

console.log("\nfinding 1 — the NaN fail-open (a garbage cap must never disable the cap):");
for (const v of ["bogus", NaN, Infinity, -Infinity, null, [], {}, true]) {
  const r = parse({ maxConcurrent: v });
  ok(`maxConcurrent ${JSON.stringify(v) ?? String(v)} → REJECTED`, r.ok === false, JSON.stringify(r));
}
{
  const r = parse({ maxConcurrent: 2.5 });
  ok("fractional maxConcurrent → REJECTED", r.ok === false);
  ok("maxConcurrent 0 → REJECTED (below minimum)", parse({ maxConcurrent: 0 }).ok === false);
  ok("maxConcurrent 17 → REJECTED (above maximum)", parse({ maxConcurrent: 17 }).ok === false);
  ok("a STRING '2' is rejected, not coerced — the operator did not type a number", parse({ maxConcurrent: "2" }).ok === false);
}

console.log("\nfinding 2 — timeoutMs bounds:");
for (const [name, v] of [["'bogus'", "bogus"], ["NaN", NaN], ["Infinity", Infinity], ["0", 0], ["-5000", -5000], ["1500.5 (fractional)", 1500.5], ["999 (below floor)", 999], ["600001 (above ceiling)", 600001]]) {
  ok(`timeoutMs ${name} → REJECTED`, parse({ timeoutMs: v }).ok === false);
}
ok("timeoutMs 30000 (in bounds) → accepted", parse({ timeoutMs: 30000 }).ok === true);

console.log("\nfinding 3 — the unanchored loopback (a name is a resolver's opinion):");
for (const [name, v] of [
  ["http://localhost.evil:9312 (Bo's example)", "http://localhost.evil:9312"],
  ["http://localhost:9312 (names are not addresses)", "http://localhost:9312"],
  ["http://127.0.0.1.evil.com:9312", "http://127.0.0.1.evil.com:9312"],
  ["https://127.0.0.1:9312 (wrong scheme)", "https://127.0.0.1:9312"],
  ["http://user:pw@127.0.0.1:9312 (credentials)", "http://user:pw@127.0.0.1:9312"],
  ["http://127.0.0.1:9312/?q=1 (query)", "http://127.0.0.1:9312/?q=1"],
  ["http://127.0.0.1:9312/#frag (fragment)", "http://127.0.0.1:9312/#frag"],
  ["http://127.0.0.1:9312/path (path)", "http://127.0.0.1:9312/path"],
  ["http://[::1]:9312 (v6 loopback is not the pinned literal)", "http://[::1]:9312"],
  ["not a url at all", "9312"],
]) {
  ok(`${name} → REJECTED`, parse({ baseUrl: v }).ok === false);
}
ok("http://127.0.0.1:9312/ (bare trailing slash) → accepted", parse({ baseUrl: "http://127.0.0.1:9312/" }).ok === true);
{
  // Octal spelling: WHATWG URL parsing NORMALIZES 0177.0.0.1 to 127.0.0.1
  // before our hostname check, so it is accepted — but only BECAUSE it
  // genuinely is the loopback literal after normalization, and the normalized
  // form is what gets used. The gate asserts the normalization, not a guess.
  const r = parse({ baseUrl: "http://0177.0.0.1:9312" });
  ok("octal 0177.0.0.1 is URL-normalized to the literal and used AS 127.0.0.1",
    r.ok === true && r.cfg.baseUrl === "http://127.0.0.1:9312", JSON.stringify(r).slice(0, 100));
}

console.log("\nfinding 4 — the digest must be a real content address:");
for (const [name, v] of [
  ["sha256:x (Bo's example)", "sha256:x"],
  ["sha256: + 63 hex", "sha256:" + "a".repeat(63)],
  ["sha256: + 65 hex", "sha256:" + "a".repeat(65)],
  ["uppercase hex", "sha256:" + "A".repeat(64)],
  ["md5 prefix", "md5:" + "a".repeat(64)],
  ["bare 64 hex, no prefix", "a".repeat(64)],
  ["absent", undefined],
]) {
  ok(`${name} → REJECTED`, parse({ expectedTokenizerBundleDigest: v }).ok === false);
}

console.log("\nthe rest of the fail-closed contract:");
ok("unknown key → REJECTED (a typo'd key is not intent)", parse({ maxConncurrent: 2 }).ok === false);
ok("non-object config → REJECTED", P.parseInferenceBackendConfig("http://127.0.0.1").ok === false);
ok("array config → REJECTED", P.parseInferenceBackendConfig([GOOD]).ok === false);
ok("null config → REJECTED", P.parseInferenceBackendConfig(null).ok === false);
ok("empty modelId → REJECTED", parse({ modelId: "" }).ok === false);
ok("empty special ranges → REJECTED", parse({ specialTokenIdRanges: [] }).ok === false);
ok("non-integer range member → REJECTED", parse({ specialTokenIdRanges: [[1.5, 2]] }).ok === false);
ok("inverted range → REJECTED", parse({ specialTokenIdRanges: [[10, 1]] }).ok === false);
ok("range wider than the span bound → REJECTED", parse({ specialTokenIdRanges: [[0, 20000]] }).ok === false);
ok("every rejection carries a stated reason", ["x", null, 0].every((v) => { const r = parse({ maxConcurrent: v }); return r.ok === false && typeof r.reason === "string" && r.reason.length > 0; }));

console.log(`\n${pass}/${pass + fail} wiring-config gates pass\n`);
process.exit(fail === 0 ? 0 : 1);
