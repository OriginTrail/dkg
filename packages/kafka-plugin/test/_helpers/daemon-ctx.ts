import type { IncomingMessage, ServerResponse } from 'node:http';
import type { KafkaPluginCtx } from '../../src/handler.js';

/** Overrides a test may set: anything EXCEPT the fields the daemon derives. */
export type DaemonCtxOverrides = Omit<Partial<KafkaPluginCtx>, 'req' | 'res' | 'url' | 'path'>;

/**
 * Build the context the DAEMON would hand a plugin.
 *
 * `url` and `path` are derived from the request exactly as `handleRequest` derives them, and are
 * applied AFTER the overrides so a caller cannot substitute a shape production never produces.
 * Fixtures drifting away from the real context is what kept dead fallback branches alive in this
 * handler, so the invariant is enforced by the type rather than described in a comment.
 */
export function daemonCtx(
  base: Omit<KafkaPluginCtx, 'req' | 'res' | 'url' | 'path'>,
  req: IncomingMessage,
  res: ServerResponse,
  overrides: DaemonCtxOverrides = {},
): KafkaPluginCtx {
  const url = new URL(req.url ?? '/', 'http://x');
  return { ...base, ...overrides, req, res, url, path: url.pathname };
}
