import type { RequestContext } from './context.js';

type NodeAdminAuthContext = Pick<
  RequestContext,
  'agent' | 'config' | 'requestToken' | 'validTokens'
>;

/**
 * Exact daemon node-admin boundary for node-wide diagnostics.
 *
 * Auth-disabled daemons retain their trusted-local behavior. With auth
 * enabled, the caller must present a recognized token that is not bound to an
 * agent identity; missing, unknown, and agent-scoped tokens all fail closed.
 */
export function isNodeAdminCaller(ctx: NodeAdminAuthContext): boolean {
  if (ctx.config.auth?.enabled === false) return true;
  const { requestToken } = ctx;
  return Boolean(
    requestToken
    && ctx.validTokens.has(requestToken)
    && !ctx.agent.resolveAgentByToken(requestToken),
  );
}
