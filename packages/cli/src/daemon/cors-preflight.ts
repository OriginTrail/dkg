import { AGENT_HTTP_HEADERS } from '../agent-http-auth.js';
import { READ_GRAPH_SETTINGS_ACTOR_HEADER } from '../read-graph-settings-wire.js';

/** The request headers a caller from an allowed origin may send: the agent request-signing headers, and who changes the node's read-graph settings. */
export const CORS_PREFLIGHT_ALLOWED_HEADERS = `${AGENT_HTTP_HEADERS}, ${READ_GRAPH_SETTINGS_ACTOR_HEADER}`;

/** The headers of the daemon's answer to a CORS preflight, for an allowed origin or, with `*` allowed, for any. */
export function corsPreflightHeaders(origin: string | null | undefined): Record<string, string> {
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': CORS_PREFLIGHT_ALLOWED_HEADERS,
  };
}
