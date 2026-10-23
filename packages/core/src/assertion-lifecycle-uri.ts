// SPDX-License-Identifier: Apache-2.0
export interface AssertionLifecycleUriScope {
  readonly contextGraphId: string;
  readonly name: string;
  readonly subGraphName?: string;
}

function scopePrefix(contextGraphId: string, subGraphName?: string): string {
  return subGraphName ? `urn:dkg:assertion:${contextGraphId}:${subGraphName}:` : `urn:dkg:assertion:${contextGraphId}:`;
}
const nameSuffix = (name: string) => `:${name}`;

/** Lifecycle subjects preserve the caller's lexical owner spelling. */
export function assertionLifecycleUri(contextGraphId: string, agentAddress: string, name: string, subGraphName?: string): string {
  return `${scopePrefix(contextGraphId, subGraphName)}${agentAddress}${nameSuffix(name)}`;
}

/** Scoped lexical inverse; callers must independently establish the RDF scope/owner agreement. */
export function decodeAssertionLifecycleUriOwner(uri: string, scope: AssertionLifecycleUriScope): string | undefined {
  const prefix = scopePrefix(scope.contextGraphId, scope.subGraphName), suffix = nameSuffix(scope.name);
  if (!uri.startsWith(prefix) || !uri.endsWith(suffix)) return undefined;
  const end = uri.length - suffix.length;
  return end > prefix.length ? uri.slice(prefix.length, end) : undefined;
}
