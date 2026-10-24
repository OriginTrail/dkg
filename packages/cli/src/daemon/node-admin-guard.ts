// Node-wide operations accept only callers that can administer the node.
import type { ServerResponse } from 'node:http';
import { canAdministerNode, type AllowedHttpAuthentication } from '../auth.js';
import { jsonResponse } from './http-utils.js';

/**
 * Gate a node-wide operation: return true when the caller may administer the
 * node (a node-operator token, or any caller when auth is disabled), otherwise
 * send the standard 403 and return false. `route` and `action` fill the shared
 * message, e.g. "POST /api/shutdown requires a node-level admin token;
 * agent-scoped tokens cannot stop the node."
 */
export function requireNodeAdmin(
  authentication: AllowedHttpAuthentication,
  res: ServerResponse,
  route: string,
  action: string,
): boolean {
  if (canAdministerNode(authentication)) return true;
  jsonResponse(res, 403, {
    error: `${route} requires a node-level admin token; agent-scoped tokens cannot ${action}.`,
  });
  return false;
}
