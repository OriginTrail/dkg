// Public surface for route plugins. The only module a plugin imports from; breaking changes are semver-major.

export {
  jsonResponse,
  readBody,
  readBodyBuffer,
  MAX_BODY_BYTES,
  SMALL_BODY_BYTES,
} from './http-utils.js';

import type { RouteRequestContext } from './routes/context.js';

const PUBLIC_ROUTE_CONTEXT_FIELDS = [
  'req',
  'res',
  'agent',
  'publisherControl',
  'publisherRuntime',
  'config',
  'startedAt',
  'dashDb',
  'opWallets',
  'network',
  'tracker',
  'memoryManager',
  'bridgeAuthToken',
  'nodeVersion',
  'nodeCommit',
  'catchupTracker',
  'extractionRegistry',
  'fileStore',
  'extractionStatus',
  'assertionImportLocks',
  'vectorStore',
  'embeddingProvider',
  'validTokens',
  'apiHost',
  'apiPortRef',
  'routePlugins',
  'admission',
  'url',
  'path',
  'requestAuth',
  'requestToken',
  'requestAgentAddress',
  'emitMemoryGraphChanged',
  'emitNotification',
] as const satisfies readonly (keyof RouteRequestContext)[];

type PublicRouteContextFields = (typeof PUBLIC_ROUTE_CONTEXT_FIELDS)[number];

const OPTIONAL_PUBLIC_ROUTE_CONTEXT_FIELDS = new Set<PublicRouteContextFields>([
  'requestAuth',
  'emitMemoryGraphChanged',
  'emitNotification',
]);

export type PluginRequestContext = Pick<RouteRequestContext, PublicRouteContextFields> & {
  // Optional only at the public plugin boundary so existing route-plugin fixtures
  // do not take a semver-major break. The explicit field list above prevents
  // future internal-only RouteRequestContext fields from leaking into plugins.
  requestIdentity?: RouteRequestContext['requestIdentity'];
};

function copyPublicRouteContextField<K extends PublicRouteContextFields>(
  target: Partial<Pick<RouteRequestContext, PublicRouteContextFields>>,
  source: RouteRequestContext,
  field: K,
): void {
  const value = source[field];
  if (value === undefined && OPTIONAL_PUBLIC_ROUTE_CONTEXT_FIELDS.has(field)) return;
  target[field] = value;
}

export function toPluginRequestContext(ctx: RouteRequestContext): PluginRequestContext {
  const pluginContext: Partial<Pick<RouteRequestContext, PublicRouteContextFields>> = {};
  for (const field of PUBLIC_ROUTE_CONTEXT_FIELDS) {
    copyPublicRouteContextField(pluginContext, ctx, field);
  }
  return {
    ...(pluginContext as Pick<RouteRequestContext, PublicRouteContextFields>),
    requestIdentity: ctx.requestIdentity,
  };
}

// Preserve the plugin API's historical type name for external route plugins.
export type RequestContext = PluginRequestContext;

export interface RoutePlugin {
  name: string;
  handle(ctx: PluginRequestContext): Promise<void> | void;
}
