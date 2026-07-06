// Public surface for route plugins. The only module a plugin imports from; breaking changes are semver-major.

export {
  jsonResponse,
  readBody,
  readBodyBuffer,
  MAX_BODY_BYTES,
  SMALL_BODY_BYTES,
} from './http-utils.js';

import type { RouteRequestContext } from './routes/context.js';

type PublicRouteContextFields =
  | 'req'
  | 'res'
  | 'agent'
  | 'publisherControl'
  | 'publisherRuntime'
  | 'config'
  | 'startedAt'
  | 'dashDb'
  | 'opWallets'
  | 'network'
  | 'tracker'
  | 'memoryManager'
  | 'bridgeAuthToken'
  | 'nodeVersion'
  | 'nodeCommit'
  | 'catchupTracker'
  | 'extractionRegistry'
  | 'fileStore'
  | 'extractionStatus'
  | 'assertionImportLocks'
  | 'vectorStore'
  | 'embeddingProvider'
  | 'validTokens'
  | 'apiHost'
  | 'apiPortRef'
  | 'routePlugins'
  | 'admission'
  | 'url'
  | 'path'
  | 'requestAuth'
  | 'requestToken'
  | 'requestAgentAddress'
  | 'emitMemoryGraphChanged'
  | 'emitNotification';

export type PluginRequestContext = Pick<RouteRequestContext, PublicRouteContextFields> & {
  // Optional only at the public plugin boundary so existing route-plugin fixtures
  // do not take a semver-major break. The explicit field list above prevents
  // future internal-only RouteRequestContext fields from leaking into plugins.
  requestIdentity?: RouteRequestContext['requestIdentity'];
};

export function toPluginRequestContext(ctx: RouteRequestContext): PluginRequestContext {
  const {
    req,
    res,
    agent,
    publisherControl,
    publisherRuntime,
    config,
    startedAt,
    dashDb,
    opWallets,
    network,
    tracker,
    memoryManager,
    bridgeAuthToken,
    nodeVersion,
    nodeCommit,
    catchupTracker,
    extractionRegistry,
    fileStore,
    extractionStatus,
    assertionImportLocks,
    vectorStore,
    embeddingProvider,
    validTokens,
    apiHost,
    apiPortRef,
    routePlugins,
    admission,
    url,
    path,
    requestIdentity,
    requestAuth,
    requestToken,
    requestAgentAddress,
    emitMemoryGraphChanged,
    emitNotification,
  } = ctx;

  return {
    req,
    res,
    agent,
    publisherControl,
    publisherRuntime,
    config,
    startedAt,
    dashDb,
    opWallets,
    network,
    tracker,
    memoryManager,
    bridgeAuthToken,
    nodeVersion,
    nodeCommit,
    catchupTracker,
    extractionRegistry,
    fileStore,
    extractionStatus,
    assertionImportLocks,
    vectorStore,
    embeddingProvider,
    validTokens,
    apiHost,
    apiPortRef,
    routePlugins,
    admission,
    url,
    path,
    requestIdentity,
    ...(requestAuth ? { requestAuth } : {}),
    requestToken,
    requestAgentAddress,
    ...(emitMemoryGraphChanged ? { emitMemoryGraphChanged } : {}),
    ...(emitNotification ? { emitNotification } : {}),
  };
}

// Preserve the plugin API's historical type name for external route plugins.
export type RequestContext = PluginRequestContext;

export interface RoutePlugin {
  name: string;
  handle(ctx: PluginRequestContext): Promise<void> | void;
}
