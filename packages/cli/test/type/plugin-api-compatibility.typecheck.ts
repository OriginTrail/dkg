import type { RequestContext, RoutePlugin } from '../../src/daemon/plugin-api.js';

type Assert<T extends true> = T;
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;
type IsNever<T> = [T] extends [never] ? true : false;

type ExpectedRequestContextKeys =
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
  | 'requestIdentity'
  | 'requestAuth'
  | 'requestToken'
  | 'requestAgentAddress'
  | 'emitMemoryGraphChanged'
  | 'emitNotification';

type MissingRequestContextKeys = Exclude<ExpectedRequestContextKeys, keyof RequestContext>;
type UnexpectedRequestContextKeys = Exclude<keyof RequestContext, ExpectedRequestContextKeys>;

type RequestContextWithoutIdentity = Omit<RequestContext, 'requestIdentity'>;
type PluginHandleContext = Parameters<RoutePlugin['handle']>[0];

export type RequestContextKeepsHistoricalPublicKeys = Assert<IsNever<MissingRequestContextKeys>>;
export type RequestContextDoesNotExposeUnexpectedKeys = Assert<IsNever<UnexpectedRequestContextKeys>>;
export type RequestIdentityRemainsOptional = Assert<IsOptional<RequestContext, 'requestIdentity'>>;
export type RequestContextCanOmitIdentity = Assert<RequestContextWithoutIdentity extends RequestContext ? true : false>;
export type RoutePluginAcceptsContextWithoutIdentity = Assert<
  RequestContextWithoutIdentity extends PluginHandleContext ? true : false
>;
