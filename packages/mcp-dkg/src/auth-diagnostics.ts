/** Missing credentials are distinct from a reachable, unauthenticated status endpoint. */
export const MISSING_TOKEN_HELP = 'MCP server has no auth token; authenticated tools may return 401. Set DKG_HOME or DKG_TOKEN in the MCP client configuration (see dkg mcp setup --print-only).';

export function missingTokenHttpHint(status: number, token: string): string {
  return status === 401 && !token ? ` — ${MISSING_TOKEN_HELP}` : '';
}

/** Never attach credentials discovered on disk to a different requested endpoint. */
export function canUseDiscoveredHomeToken(api: string | null, homeApi: string): boolean {
  if (!api) return true;
  try {
    const target = new URL(api);
    const home = new URL(homeApi);
    const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
    return target.protocol === home.protocol && target.port === home.port
      && loopback.has(target.hostname) && loopback.has(home.hostname)
      && !target.username && !target.password && target.pathname === '/';
  } catch { return false; }
}
