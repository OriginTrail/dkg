import type { RequestContext, RoutePlugin } from './plugin-api.js';

type Assert<T extends true> = T;
type IsOptional<T, K extends keyof T> = {} extends Pick<T, K> ? true : false;

type RequestContextWithoutIdentity = Omit<RequestContext, 'requestIdentity'>;
type PluginHandleContext = Parameters<RoutePlugin['handle']>[0];

export type RequestIdentityRemainsOptional = Assert<
  IsOptional<RequestContext, 'requestIdentity'>
>;

export type RequestContextCanOmitIdentity = Assert<
  RequestContextWithoutIdentity extends RequestContext ? true : false
>;

export type RoutePluginAcceptsContextWithoutIdentity = Assert<
  RequestContextWithoutIdentity extends PluginHandleContext ? true : false
>;

export {};
