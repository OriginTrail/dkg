// Node-native OAuth for the ☁ upstream (CP3 as a node capability, not a
// foreign CLI): authorization-code + PKCE against auth.openai.com, with the
// node acting as the registered native client.
//
//   · The node NEVER sees credentials: the human signs in in their own
//     browser; the node only receives the one-time authorization code on the
//     loopback redirect and exchanges it (with the PKCE verifier) for tokens.
//   · Tokens land in the NODE'S OWN secret store
//     ($DKG_HOME/marketplace/.secrets/codex-auth.json, mode 600) in the exact
//     shape the codex-oauth connector reads — no dependency on ~/.codex or the
//     Codex app.
//   · The callback listener binds 127.0.0.1:1455 (the client's registered
//     redirect) only for the duration of one flow, single-use state, 10-minute
//     timeout, then closes.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CODEX_OAUTH_CLIENT_ID } from "./connector-codex-oauth.js";

export const AUTH_BASE = "https://auth.openai.com";
const REDIRECT_PORT = 1455;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

export interface FlowState {
  status: "idle" | "pending" | "done" | "error";
  authorizeUrl?: string;
  startedAt?: string;
  detail?: string;
}

let current: { state: FlowState; server: Server | null; timer: NodeJS.Timeout | null } = {
  state: { status: "idle" }, server: null, timer: null,
};

const b64url = (b: Buffer) => b.toString("base64url");

function accountIdFromAccessToken(accessToken: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"] as { chatgpt_account_id?: string } | undefined;
    return auth?.chatgpt_account_id ?? null;
  } catch { return null; }
}

function closeFlow(): void {
  if (current.timer) clearTimeout(current.timer);
  current.server?.close();
  current.server = null;
  current.timer = null;
}

export function flowStatus(): FlowState {
  return { ...current.state };
}

/**
 * Start one OAuth flow. Returns the authorize URL for the HUMAN to open.
 * `secretPath` is where the token set is written on success.
 */
export function startCodexAuthFlow(secretPath: string, opts?: { authBase?: string; tokenUrl?: string }): FlowState {
  if (current.state.status === "pending") return { ...current.state };   // one at a time; idempotent
  closeFlow();

  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(24));
  const authBase = opts?.authBase ?? AUTH_BASE;
  const tokenUrl = opts?.tokenUrl ?? `${AUTH_BASE}/oauth/token`;

  const authorizeUrl = `${authBase}/oauth/authorize?` + new URLSearchParams({
    response_type: "code",
    client_id: CODEX_OAUTH_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  }).toString();

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== "/auth/callback") { res.writeHead(404); res.end(); return; }
      const done = (ok: boolean, msg: string) => {
        res.writeHead(ok ? 200 : 400, { "content-type": "text/html" });
        res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>${ok ? "✓ Node authenticated" : "✗ Authentication failed"}</h2><p>${msg}</p><p>You can close this window.</p></body></html>`);
      };
      try {
        if (url.searchParams.get("state") !== state) { done(false, "state mismatch"); current.state = { status: "error", detail: "E_OAUTH_STATE" }; closeFlow(); return; }
        const code = url.searchParams.get("code");
        if (!code) { done(false, "no code"); current.state = { status: "error", detail: "E_OAUTH_NO_CODE" }; closeFlow(); return; }
        const tr = await fetch(tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: CODEX_OAUTH_CLIENT_ID,
            code, code_verifier: verifier,
            redirect_uri: REDIRECT_URI,
          }).toString(),
          signal: AbortSignal.timeout(30_000),
        });
        if (!tr.ok) { done(false, `token exchange ${tr.status}`); current.state = { status: "error", detail: `E_OAUTH_EXCHANGE_${tr.status}` }; closeFlow(); return; }
        const t = (await tr.json()) as { access_token?: string; refresh_token?: string; id_token?: string };
        if (!t.access_token || !t.refresh_token) { done(false, "incomplete token set"); current.state = { status: "error", detail: "E_OAUTH_INCOMPLETE" }; closeFlow(); return; }
        const accountId = accountIdFromAccessToken(t.access_token);
        if (!accountId) { done(false, "no ChatGPT account claim (is this a subscription account?)"); current.state = { status: "error", detail: "E_OAUTH_NO_ACCOUNT" }; closeFlow(); return; }
        mkdirSync(dirname(secretPath), { recursive: true });
        writeFileSync(secretPath, JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { access_token: t.access_token, refresh_token: t.refresh_token, id_token: t.id_token ?? "", account_id: accountId },
          last_refresh: new Date().toISOString(),
        }, null, 2), { mode: 0o600 });
        done(true, "Tokens stored in the node's secret store.");
        current.state = { status: "done", startedAt: current.state.startedAt };
        closeFlow();
      } catch (e) {
        done(false, "exchange failed");
        current.state = { status: "error", detail: String((e as Error).message).slice(0, 120) };
        closeFlow();
      }
    })();
  });

  try {
    server.listen(REDIRECT_PORT, "127.0.0.1");
  } catch {
    current.state = { status: "error", detail: "E_OAUTH_PORT_1455_BUSY" };
    return { ...current.state };
  }
  server.on("error", () => { current.state = { status: "error", detail: "E_OAUTH_PORT_1455_BUSY" }; });

  const timer = setTimeout(() => {
    if (current.state.status === "pending") current.state = { status: "error", detail: "E_OAUTH_TIMEOUT" };
    closeFlow();
  }, FLOW_TIMEOUT_MS);
  timer.unref?.();

  current = { state: { status: "pending", authorizeUrl, startedAt: new Date().toISOString() }, server, timer };
  return { ...current.state };
}
