// OT-RFC-27 seller connector login: the node-native Codex OAuth flow
// (authorization code + PKCE S256 against auth.openai.com, the node acting as
// the Codex CLI's registered native client). Port of the fork's
// `seller/oauth-flow.ts` with injectable endpoints, port, clock and fetch.
//
//   - The node never sees the human's credentials: they sign in in their own
//     browser; the node receives only the one-time authorization code on the
//     loopback redirect and exchanges it (with the PKCE verifier).
//   - Tokens land in the node's own secret store (default
//     `<dkgDir>/marketplace/.secrets/codex-auth.json`) in exactly the shape the
//     `codex-oauth` connector reads: `{ tokens: { access_token,
//     refresh_token, account_id, id_token }, last_refresh }`. Written
//     atomically (tmp 0600 → rename → chmod 0600) under a 0700 directory.
//   - The callback listener binds 127.0.0.1 only for one flow: single-use
//     state (compared in constant time; a mismatch is refused without ending
//     the flow, so a local prober cannot cancel it), a 10-minute timeout, one
//     flow at a time. Status `detail` strings never carry token material.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CODEX_OAUTH_CLIENT_ID,
  CODEX_TOKEN_URL,
} from '@origintrail-official/dkg-agent/dist/marketplace/gateway-domain.js';

export const CODEX_AUTH_BASE = 'https://auth.openai.com';
/** The Codex client's registered loopback redirect port. */
export const CODEX_REDIRECT_PORT = 1455;
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;
const EXCHANGE_TIMEOUT_MS = 30_000;

export interface CodexOAuthFlowState {
  status: 'idle' | 'pending' | 'done' | 'error';
  authorizeUrl?: string;
  startedAt?: string;
  detail?: string;
}

export interface CodexOAuthFlowOptions {
  /** ABSOLUTE path the token set is written to on success. */
  authFile: string;
  authBase?: string;
  tokenUrl?: string;
  port?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const b64url = (bytes: Buffer): string => bytes.toString('base64url');

/** PKCE S256: `challenge = base64url(sha256(verifier))`. */
export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

function jwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== 'string') return undefined;
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as unknown;
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The ChatGPT account id claim (access token first, then the id token). */
export function codexAccountId(accessToken: unknown, idToken?: unknown): string | undefined {
  for (const token of [accessToken, idToken]) {
    const auth = jwtClaims(token)?.['https://api.openai.com/auth'] as { chatgpt_account_id?: unknown } | undefined;
    if (typeof auth?.chatgpt_account_id === 'string' && auth.chatgpt_account_id.length > 0) return auth.chatgpt_account_id;
  }
  return undefined;
}

/** Atomic 0600 write under a 0700 directory (`writeFile`'s mode applies only on create, hence the chmods). */
export async function writeCodexAuthFile(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, data, { mode: 0o600 });
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    try { await unlink(tmp); } catch { /* best effort */ }
    throw err;
  }
  await chmod(path, 0o600);
}

const page = (ok: boolean, message: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>DKG node sign-in</title></head>`
  + `<body style="font-family:sans-serif;padding:40px"><h2>${ok ? 'Node authenticated' : 'Authentication failed'}</h2>`
  + `<p>${message}</p><p>You can close this window.</p></body></html>`;

function sameState(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One Codex OAuth login at a time (per process). */
export class CodexOAuthFlow {
  #state: CodexOAuthFlowState = { status: 'idle' };
  #server: Server | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  status(): CodexOAuthFlowState {
    return { ...this.#state };
  }

  /** Stop listening (the state is kept). */
  close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#server?.close();
    this.#server = null;
  }

  /**
   * Start a flow and return the authorize URL for the HUMAN to open. While a
   * flow is pending this is idempotent (returns the pending state).
   */
  async start(opts: CodexOAuthFlowOptions): Promise<CodexOAuthFlowState> {
    if (this.#state.status === 'pending') return this.status();
    this.close();
    const port = opts.port ?? CODEX_REDIRECT_PORT;
    const redirectUri = `http://localhost:${port}/auth/callback`;
    const verifier = b64url(randomBytes(48));
    const state = b64url(randomBytes(24));
    const tokenUrl = opts.tokenUrl ?? CODEX_TOKEN_URL;
    const fetchImpl = opts.fetch ?? fetch;
    const authorizeUrl = `${opts.authBase ?? CODEX_AUTH_BASE}/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: CODEX_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'openid profile email offline_access',
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
    }).toString()}`;
    let consumed = false;

    const fail = (detail: string): void => {
      this.#state = { status: 'error', detail, ...(this.#state.startedAt ? { startedAt: this.#state.startedAt } : {}) };
      this.close();
    };

    const exchange = async (code: string): Promise<{ ok: boolean; message: string }> => {
      let response: Response;
      try {
        response = await fetchImpl(tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CODEX_OAUTH_CLIENT_ID,
            code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
          }).toString(),
          redirect: 'error',
          signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
        });
      } catch {
        fail('E_OAUTH_EXCHANGE_TRANSPORT');
        return { ok: false, message: 'The token exchange could not reach the provider.' };
      }
      if (!response.ok) {
        fail(`E_OAUTH_EXCHANGE_${response.status}`);
        return { ok: false, message: `The token exchange was refused (${response.status}).` };
      }
      let tokens: { access_token?: unknown; refresh_token?: unknown; id_token?: unknown };
      try {
        tokens = (await response.json()) as typeof tokens;
      } catch {
        fail('E_OAUTH_EXCHANGE_BODY');
        return { ok: false, message: 'The token exchange answered an unreadable body.' };
      }
      if (typeof tokens?.access_token !== 'string' || typeof tokens.refresh_token !== 'string'
        || !tokens.access_token || !tokens.refresh_token) {
        fail('E_OAUTH_INCOMPLETE');
        return { ok: false, message: 'The provider returned an incomplete token set.' };
      }
      const accountId = codexAccountId(tokens.access_token, tokens.id_token);
      if (!accountId) {
        fail('E_OAUTH_NO_ACCOUNT');
        return { ok: false, message: 'No ChatGPT account claim (is this a subscription account?).' };
      }
      try {
        await writeCodexAuthFile(opts.authFile, `${JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            id_token: typeof tokens.id_token === 'string' ? tokens.id_token : '',
            account_id: accountId,
          },
          last_refresh: new Date().toISOString(),
        }, null, 2)}\n`);
      } catch {
        fail('E_OAUTH_WRITE');
        return { ok: false, message: 'The tokens could not be stored in the node secret store.' };
      }
      this.#state = { status: 'done', ...(this.#state.startedAt ? { startedAt: this.#state.startedAt } : {}) };
      this.close();
      return { ok: true, message: 'Tokens stored in the node secret store.' };
    };

    const server = createServer((req, res) => {
      void (async () => {
        const reply = (status: number, ok: boolean, message: string): void => {
          res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(page(ok, message));
        };
        const url = new URL(req.url ?? '/', `http://localhost:${port}`);
        if (url.pathname !== '/auth/callback' || req.method !== 'GET') {
          res.writeHead(404).end();
          return;
        }
        if (consumed || !sameState(url.searchParams.get('state'), state)) {
          // Refused, but the pending flow stays open for the real redirect.
          reply(400, false, 'This sign-in link is not the one this node is waiting for.');
          return;
        }
        consumed = true;
        if (url.searchParams.get('error')) {
          fail('E_OAUTH_DENIED');
          reply(400, false, 'The provider reported an error.');
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          fail('E_OAUTH_NO_CODE');
          reply(400, false, 'The redirect carried no authorization code.');
          return;
        }
        const outcome = await exchange(code);
        reply(outcome.ok ? 200 : 400, outcome.ok, outcome.message);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });

    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', rejectListen);
          resolveListen();
        });
      });
    } catch {
      server.close();
      this.#state = { status: 'error', detail: `E_OAUTH_PORT_${port}_BUSY` };
      return this.status();
    }
    server.on('error', () => fail('E_OAUTH_LISTENER'));
    this.#server = server;
    this.#timer = setTimeout(() => {
      if (this.#state.status === 'pending') fail('E_OAUTH_TIMEOUT');
      else this.close();
    }, opts.timeoutMs ?? FLOW_TIMEOUT_MS);
    this.#timer.unref?.();
    this.#state = { status: 'pending', authorizeUrl, startedAt: new Date().toISOString() };
    return this.status();
  }
}

let processFlow: CodexOAuthFlow | undefined;

/** The process-wide Codex login flow (one at a time). */
export function codexOAuthFlow(): CodexOAuthFlow {
  processFlow ??= new CodexOAuthFlow();
  return processFlow;
}
