import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Attach a request to a base context, deriving `url` and `path` from it the way the daemon does.
 *
 * Deliberately NOT "a daemon context": it does not derive `requestAgentAddress` from a token, and
 * its `url` host is a placeholder rather than the real Host header. Claiming production fidelity
 * would be false confidence. What it does provide is the one thing worth centralizing — fixtures
 * that omit `url`/`path` drift into shapes the daemon never produces, which is what kept dead
 * fallback branches in this handler alive until they were removed.
 */
export function attachRequest<T extends object>(
  base: T,
  req: IncomingMessage,
  res: ServerResponse,
): T & { req: IncomingMessage; res: ServerResponse; url: URL; path: string } {
  const url = new URL(req.url ?? '/', 'http://x');
  return { ...base, req, res, url, path: url.pathname };
}
