// Which callers the dashboard shell (`/ui`) is served to with the node-operator
// token embedded.
import type { IncomingMessage } from 'node:http';
import { hostIsLocal, isLoopbackClientIp } from './http-utils.js';

/**
 * The first node-operator token in the set, i.e. one that no local agent owns.
 * Agent tokens share the set and can precede it once the token file is
 * reloaded, so the order of the set alone does not identify the operator.
 */
export function nodeOperatorToken(
  validTokens: Iterable<string>,
  resolveAgentByToken: (token: string) => string | undefined,
): string | undefined {
  for (const token of validTokens) {
    if (!resolveAgentByToken(token)) return token;
  }
  return undefined;
}

/**
 * The token to embed in the dashboard shell for this request, if any. The
 * shell itself is public so every caller can load it and authenticate, but the
 * node-operator token is injected only for a trusted local request: a loopback
 * client socket AND a `Host` that names the loopback interface. A non-loopback
 * client, or a loopback client presenting any other `Host`, is untrusted and is
 * served the same shell without a token.
 */
export function nodeUiTokenForRequest(
  req: Pick<IncomingMessage, 'socket' | 'headers'>,
  opts: {
    authEnabled: boolean;
    validTokens: Iterable<string>;
    resolveAgentByToken: (token: string) => string | undefined;
  },
): string | undefined {
  if (!opts.authEnabled) return undefined;
  if (!isLoopbackClientIp(req.socket?.remoteAddress ?? '')) return undefined;
  if (!hostIsLocal(req.headers.host)) return undefined;
  // TODO: a same-host reverse proxy that forwards a loopback Host (e.g. nginx's
  // default `proxy_set_header Host $proxy_host`) reaches this as a local caller.
  // Operators who deliberately front the dashboard that way need an opt-in
  // allowlist of extra Host names, and should keep authentication in front of
  // the proxy until it exists.
  return nodeOperatorToken(opts.validTokens, opts.resolveAgentByToken);
}
