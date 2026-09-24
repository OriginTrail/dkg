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

// Headers a proxy adds when it forwards a request. A browser talking to the
// daemon directly never sends them, so a request carrying any of them came
// through a proxy and is not a direct local one.
const PROXY_FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'via',
] as const;

/**
 * The token to embed in the dashboard shell for this request, if any. The
 * shell itself is public so every caller can load it and authenticate, but the
 * node-operator token is injected only for a trusted local request: a loopback
 * client socket AND a `Host` that names the loopback interface AND no proxy
 * forwarding headers. A non-loopback client, a loopback client presenting any
 * other `Host`, or a request forwarded by a proxy is untrusted and is served
 * the same shell without a token.
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
  if (PROXY_FORWARDING_HEADERS.some((name) => req.headers[name] !== undefined)) return undefined;
  // TODO: a same-host reverse proxy that forwards a loopback Host and adds none
  // of those headers (e.g. nginx's default `proxy_set_header Host $proxy_host`
  // without X-Forwarded-For) cannot be told apart from a direct local caller.
  // Operators who front the dashboard that way need authentication in front of
  // the proxy, or an opt-in trusted-proxy setting, which does not exist yet.
  return nodeOperatorToken(opts.validTokens, opts.resolveAgentByToken);
}
