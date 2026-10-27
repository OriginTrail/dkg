/**
 * Codex-over-OAuth constants, split from the connector so the daemon's PKCE
 * login flow (and `gateway-domain.ts`) can import them without loading the
 * connector or the agent runtime.
 */
import { join } from 'node:path';

/** The public OAuth client id of the Codex CLI. */
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** The ChatGPT-account Codex backend (Responses API). */
export const CODEX_DEFAULT_BASE = 'https://chatgpt.com/backend-api/codex';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';

/**
 * Default auth store of a codex-oauth connector:
 * `<dataDir>/marketplace/.secrets/codex-auth.json` (file 0600, dir 0700).
 */
export function defaultCodexAuthFile(dataDir: string): string {
  return join(dataDir, 'marketplace', '.secrets', 'codex-auth.json');
}
