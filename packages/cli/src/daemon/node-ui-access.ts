// Which callers the dashboard shell (`/ui`) is served to with the node-operator
// token embedded.
import type { IncomingMessage } from 'node:http';
import { hostIsLocal, isLoopbackClientIp } from './http-utils.js';

/**
 * The first node-operator token in the set, i.e. one that no local agent owns.
 * Agent tokens share the set and can precede it once the token file is
 * reloaded, so the order of the set alone does not identify the operator.
 * Empty entries are skipped: a legacy agent recovered without a token adds one,
 * and no agent claims it.
 */
export function nodeOperatorToken(
  validTokens: Iterable<string>,
  resolveAgentByToken: (token: string) => string | undefined,
): string | undefined {
  for (const token of validTokens) {
    if (token && !resolveAgentByToken(token)) return token;
  }
  return undefined;
}

// Headers a proxy adds when it forwards a request: every `X-Forwarded-*`
// header plus these. A browser talking to the daemon directly never sends
// them, so a request carrying any of them came through a proxy and is not a
// direct local one.
const PROXY_FORWARDING_HEADERS = new Set([
  'forwarded',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'via',
]);

function forwardedByProxy(headers: IncomingMessage['headers']): boolean {
  return Object.keys(headers).some(
    (name) => name.startsWith('x-forwarded-') || PROXY_FORWARDING_HEADERS.has(name),
  );
}

/**
 * The token to embed in the dashboard shell for this request, if any. The
 * shell itself is public so every caller can load it and authenticate; by
 * default it carries no token, and the dashboard asks for one.
 *
 * Only an operator who turns on `auth.dashboardAutoSignIn` gets the
 * node-operator token injected, and then only for a trusted local request: a
 * loopback client socket AND a `Host` that names the loopback interface AND no
 * proxy forwarding headers. It is off by default; leave it off on a node with
 * a reverse proxy in front of the API.
 */
export function nodeUiTokenForRequest(
  req: Pick<IncomingMessage, 'socket' | 'headers'>,
  opts: {
    authEnabled: boolean;
    /** `auth.dashboardAutoSignIn`: embed the token for a trusted local request. */
    autoSignIn: boolean;
    validTokens: Iterable<string>;
    resolveAgentByToken: (token: string) => string | undefined;
  },
): string | undefined {
  if (!opts.authEnabled || !opts.autoSignIn) return undefined;
  if (!isLoopbackClientIp(req.socket?.remoteAddress ?? '')) return undefined;
  if (!hostIsLocal(req.headers.host)) return undefined;
  if (forwardedByProxy(req.headers)) return undefined;
  return nodeOperatorToken(opts.validTokens, opts.resolveAgentByToken);
}
