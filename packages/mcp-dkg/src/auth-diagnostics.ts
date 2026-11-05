/** Missing credentials are distinct from a reachable, unauthenticated status endpoint. */
export const MISSING_TOKEN_HELP = 'MCP server has no auth token; authenticated tools may return 401. Set DKG_HOME or DKG_TOKEN in the MCP client configuration (see dkg mcp setup --print-only).';

export function missingTokenHttpHint(status: number, token: string): string {
  return status === 401 && !token ? ` — ${MISSING_TOKEN_HELP}` : '';
}
