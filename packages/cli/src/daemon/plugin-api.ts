// Public surface for route plugins. The only module a plugin imports from; breaking changes are semver-major.

export {
  jsonResponse,
  readBody,
  readBodyBuffer,
  MAX_BODY_BYTES,
  SMALL_BODY_BYTES,
} from './http-utils.js';

import type { RouteRequestContext } from './routes/context.js';

export type PluginRequestContext = Omit<RouteRequestContext, 'requestIdentity'> & {
  // Optional only at the public plugin boundary so existing route-plugin
  // fixtures do not take a semver-major break. Internal route groups use
  // RouteRequestContext from routes/context.ts, where requestIdentity is required.
  requestIdentity?: RouteRequestContext['requestIdentity'];
};

// Preserve the plugin API's historical type name for external plugins.
export type RequestContext = PluginRequestContext;

export interface RoutePlugin {
  name: string;
  handle(ctx: PluginRequestContext): Promise<void> | void;
}
