import { extractBearerToken, getRequestAuthContext, type RequestAuthContext, type RequestAuthPrincipal } from "../auth.js";
import type { IncomingMessage } from "node:http";

export interface RouteIdentityAgent {
  resolveAgentByToken(token: string | undefined): string | undefined | null;
  resolveAgentAddress(token: string | undefined): string;
}

export interface RouteRequestIdentity {
  requestAuth?: RequestAuthContext;
  credentialToken: string | undefined;
  principal: RequestAuthPrincipal;
}

export function resolveRequestPrincipal(
  agent: RouteIdentityAgent,
  token: string | undefined,
): RequestAuthPrincipal {
  return {
    kind: token && agent.resolveAgentByToken(token) ? "agent" : "node-admin",
    agentAddress: agent.resolveAgentAddress(token),
  };
}

export function resolveRouteRequestIdentity(
  req: IncomingMessage,
  agent: RouteIdentityAgent,
  explicitRequestAuth?: RequestAuthContext,
): RouteRequestIdentity {
  const requestAuth = explicitRequestAuth ?? getRequestAuthContext(req);
  const credentialToken = requestAuth?.source === "dashboard-session"
    ? requestAuth.internalCredentialToken
    : requestAuth?.token ?? extractBearerToken(req.headers.authorization);
  const principal = requestAuth?.principal ?? resolveRequestPrincipal(agent, credentialToken);

  return {
    requestAuth,
    credentialToken,
    principal,
  };
}
