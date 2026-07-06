import type { RequestAuthContext, RequestAuthPrincipal } from '../../src/auth.js';
import type { RouteRequestIdentity } from '../../src/daemon/route-request-identity.js';
import type { RouteRequestContext } from '../../src/daemon/routes/context.js';

export interface TestRouteIdentityOptions {
  requestAuth?: RequestAuthContext;
  token?: string;
  agentAddress?: string;
  principalKind?: RequestAuthPrincipal['kind'];
}

export function testRouteIdentityFields(
  options: TestRouteIdentityOptions = {},
): Pick<RouteRequestContext, 'requestIdentity' | 'requestAuth' | 'requestToken' | 'requestAgentAddress'> {
  const credentialToken = options.requestAuth?.source === 'dashboard-session'
    ? options.requestAuth.internalCredentialToken
    : options.requestAuth?.token ?? options.token;
  const principal = options.requestAuth?.principal ?? {
    kind: options.principalKind ?? (options.agentAddress ? 'agent' : 'node-admin'),
    agentAddress: options.agentAddress ?? '',
  };
  const requestIdentity: RouteRequestIdentity = {
    ...(options.requestAuth ? { requestAuth: options.requestAuth } : {}),
    credentialToken,
    principal,
  };

  return {
    requestIdentity,
    ...(requestIdentity.requestAuth ? { requestAuth: requestIdentity.requestAuth } : {}),
    requestToken: requestIdentity.credentialToken,
    requestAgentAddress: requestIdentity.principal.agentAddress,
  };
}
