// Node-native OAuth flow gates — hermetic: stub token endpoint, direct
// callback drive (the "browser"), no real auth server.
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST = new URL("../../dist/", import.meta.url).pathname;
const { startCodexAuthFlow, flowStatus } = await import(join(DIST, "seller/oauth-flow.js"));

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}${c ? "" : ` — ${d ?? ""}`}`); };

const T = mkdtempSync(join(tmpdir(), "oauth-gates-"));
const secretPath = join(T, ".secrets", "codex-auth.json");

// stub token endpoint returning a JWT with the account claim
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const ACCESS = `${b64u({ alg: "none" })}.${b64u({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct-gate-1", chatgpt_plan_type: "pro" } })}.s`;
let sawVerifier = null, sawCode = null;
const tokenSrv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const p = new URLSearchParams(body);
    sawVerifier = p.get("code_verifier"); sawCode = p.get("code");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: ACCESS, refresh_token: "rt-gate-1", id_token: "idt-gate" }));
  });
});
await new Promise((r) => tokenSrv.listen(0, "127.0.0.1", r));
const tokenUrl = `http://127.0.0.1:${tokenSrv.address().port}/oauth/token`;

console.log("oauth-flow gates:\n");

// 1 ── start
const st = startCodexAuthFlow(secretPath, { tokenUrl });
const u = new URL(st.authorizeUrl);
ok("1. start → pending with PKCE authorize URL",
  st.status === "pending" && u.searchParams.get("code_challenge_method") === "S256" &&
  (u.searchParams.get("code_challenge") ?? "").length > 20 && (u.searchParams.get("state") ?? "").length > 10);
const goodState = u.searchParams.get("state");

// 2 ── wrong state refused, nothing written
{
  const r = await fetch(`http://127.0.0.1:1455/auth/callback?state=WRONG&code=abc`);
  ok("2. wrong state → 400, flow error, no secret written", r.status === 400 && flowStatus().status === "error" && !existsSync(secretPath));
}

// 3 ── restart, correct callback → exchange → secret written (0600, right shape)
{
  const st2 = startCodexAuthFlow(secretPath, { tokenUrl });
  const s2 = new URL(st2.authorizeUrl).searchParams.get("state");
  const r = await fetch(`http://127.0.0.1:1455/auth/callback?state=${s2}&code=code-gate-77`);
  ok("3a. good callback → 200 success page", r.status === 200);
  ok("3b. token exchange carried the PKCE verifier + code", !!sawVerifier && sawCode === "code-gate-77");
  const store = JSON.parse(readFileSync(secretPath, "utf8"));
  ok("3c. secret store: connector shape + account from JWT claim",
    store.auth_mode === "chatgpt" && store.tokens.account_id === "acct-gate-1" && store.tokens.refresh_token === "rt-gate-1");
  const mode = statSync(secretPath).mode & 0o777;
  ok(`3d. secret file mode 0600 (got ${mode.toString(8)})`, mode === 0o600);
  ok("3e. flow status → done", flowStatus().status === "done");
}

// 4 ── status surface never leaks tokens
{
  const s = JSON.stringify(flowStatus());
  ok("4. status carries NO tokens", !s.includes("rt-gate-1") && !s.includes(ACCESS));
}

tokenSrv.close();
console.log(`\n${pass}/${pass + fail} oauth-flow gates pass`);
process.exit(fail ? 1 : 0);
