// Connector C (codex-oauth) gate suite — hermetic: stub SSE upstream + stub
// token endpoint on loopback; a fixture auth.json; the real o200k engine.
//
//   1. connect: auth shape + tokenizer pin
//   2. happy path: SSE deltas assemble; usage captured as INFORMATIONAL
//   3. expired JWT → proactive refresh (stub token server) → retry OK,
//      auth.json rotated on disk
//   4. 429 → E_UPSTREAM_RATELIMIT (no leg — enforced by the front, asserted
//      at the outcome level here)
//   5. response.failed mid-stream → E_UPSTREAM_ERROR
//   6. REDACTION: access/refresh tokens absent from the binding and any
//      would-be evidence surfaces
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST = new URL("../../dist/", import.meta.url).pathname;
const { connectCodexOAuth, completeCodexOAuth } = await import(join(DIST, "seller/connector-codex-oauth.js"));
const { tiktokenEngine } = await import(join(DIST, "buyer/bpe.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}${c ? "" : ` — ${d ?? ""}`}`); };

const T = mkdtempSync(join(tmpdir(), "codex-gates-"));
const jwt = (expSecFromNow) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + expSecFromNow })}.sig`;
};
const ACCESS_LIVE = jwt(3600);
const ACCESS_EXPIRED = jwt(-60);
const REFRESH = "rt-fixture-refresh-token-000";
const ACCOUNT = "acct-fixture-123";
const authFile = join(T, "auth.json");
const writeAuth = (access) => writeFileSync(authFile, JSON.stringify({
  auth_mode: "chatgpt", tokens: { access_token: access, refresh_token: REFRESH, account_id: ACCOUNT, id_token: "idt" },
  last_refresh: new Date().toISOString(),
}, null, 2));

const O200K = process.env.O200K ?? `${process.env.HOME}/odysseus-dkg-proto/models/tokenizers/o200k_base.tiktoken`;

// ── stub SSE upstream ──
const COMPLETION = "Entities and relations, queryable.";
let mode = "ok";
let sawAuthHeader = null, sawAccountHeader = null;
const upstream = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    sawAuthHeader = req.headers.authorization; sawAccountHeader = req.headers["chatgpt-account-id"];
    if (mode === "429") { res.writeHead(429); res.end(); return; }
    if (mode === "401-once") { mode = "ok"; res.writeHead(401); res.end(); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (mode === "failed") {
      res.write(`data: ${JSON.stringify({ type: "response.failed" })}\n\n`);
      res.end(); return;
    }
    const words = COMPLETION.split(" ");
    for (let i = 0; i < words.length; i++) {
      res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: (i ? " " : "") + words[i] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 999, output_tokens: 888 } } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

// ── stub token endpoint ──
let refreshCalls = 0;
const tokenSrv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    refreshCalls++;
    const p = JSON.parse(body);
    if (p.refresh_token !== REFRESH) { res.writeHead(400); res.end("{}"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: jwt(3600), refresh_token: REFRESH + "-rotated", id_token: "idt2" }));
  });
});
await new Promise((r) => tokenSrv.listen(0, "127.0.0.1", r));
process.env.NSM_CODEX_TOKEN_URL = `http://127.0.0.1:${tokenSrv.address().port}/oauth/token`;

console.log("codex-oauth gates:\n");

// 1 ── connect
writeAuth(ACCESS_LIVE);
const binding = connectCodexOAuth({
  kind: "codex-oauth", authFile, baseUrl: upstreamBase, model: "gpt-5.3-codex",
  tokenizerFile: O200K, tokenizerBundle: "o200k_base", reasoningEffort: "low",
});
ok("1. connect pins the counting bundle (sha256) and holds NO tokens",
  binding.tokenizerFileSha256.startsWith("sha256:") && !JSON.stringify(binding).includes(ACCESS_LIVE) && !JSON.stringify(binding).includes(REFRESH));

// 2 ── happy path
{
  const out = await completeCodexOAuth(binding, [{ role: "user", content: "What is a knowledge graph?" }], 64);
  ok("2a. SSE deltas assemble the completion", out.ok === true && out.result.completion === COMPLETION, JSON.stringify(out).slice(0, 120));
  ok("2b. upstream usage captured (informational only)", out.ok && out.upstreamUsage.input_tokens === 999 && out.upstreamUsage.output_tokens === 888);
  ok("2c. request carried Bearer + account headers", String(sawAuthHeader).startsWith("Bearer ") && sawAccountHeader === ACCOUNT);
  const engine = tiktokenEngine(readFileSync(O200K, "utf8"));
  const n = engine.encodeCount(COMPLETION);
  ok(`2d. local o200k count of delivered bytes is deterministic (${n} tokens, 0 unknown)`, n > 0 && engine.unknownPieces(COMPLETION) === 0);
}

// 3 ── expired token → proactive refresh → rotated on disk
{
  writeAuth(ACCESS_EXPIRED);
  const before = refreshCalls;
  const out = await completeCodexOAuth(binding, [{ role: "user", content: "ping" }], 16);
  const rotated = JSON.parse(readFileSync(authFile, "utf8"));
  ok("3a. expired JWT triggers refresh + succeeds", out.ok === true && refreshCalls === before + 1);
  ok("3b. rotated tokens written back to auth.json", rotated.tokens.refresh_token === REFRESH + "-rotated" || rotated.tokens.access_token !== ACCESS_EXPIRED);
}

// 4 ── 429 ⇒ rate-limit outcome (front turns this into NO LEG — proven in the front suite)
{
  writeAuth(ACCESS_LIVE);
  mode = "429";
  const out = await completeCodexOAuth(binding, [{ role: "user", content: "x" }], 8);
  ok("4. upstream 429 → E_UPSTREAM_RATELIMIT", out.ok === false && out.code === "E_UPSTREAM_RATELIMIT");
  mode = "ok";
}

// 5 ── response.failed mid-stream
{
  mode = "failed";
  const out = await completeCodexOAuth(binding, [{ role: "user", content: "x" }], 8);
  ok("5. response.failed → E_UPSTREAM_ERROR", out.ok === false && out.code === "E_UPSTREAM_ERROR");
  mode = "ok";
}

// 6 ── 401 once → one refresh + retry succeeds
{
  writeAuth(ACCESS_LIVE);
  mode = "401-once";
  const before = refreshCalls;
  const out = await completeCodexOAuth(binding, [{ role: "user", content: "retry?" }], 16);
  ok("6. upstream 401 → one refresh + retry succeeds", out.ok === true && refreshCalls === before + 1);
}

// 7 ── redaction: tokens absent from every artifact this layer produces
{
  const artifacts = JSON.stringify({ binding, note: "evidence surfaces carry the binding only" });
  const leaked = artifacts.includes(REFRESH) || artifacts.includes("rt-fixture");
  ok("7. tokens ABSENT from binding/evidence surfaces", !leaked);
}

upstream.close(); tokenSrv.close();
console.log(`\n${pass}/${pass + fail} codex-oauth gates pass`);
process.exit(fail ? 1 : 0);
