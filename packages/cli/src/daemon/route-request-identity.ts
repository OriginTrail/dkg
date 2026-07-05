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

export function resolveRouteRequestIdentity(
  req: IncomingMessage,
  agent: RouteIdentityAgent,
): RouteRequestIdentity {
  const requestAuth = getRequestAuthContext(req);
  const credentialToken = requestAuth?.source === "dashboard-session"
    ? requestAuth.internalCredentialToken
    : requestAuth?.token ?? extractBearerToken(req.headers.authorization);
  const principal = requestAuth?.principal ?? {
    kind: credentialToken && agent.resolveAgentByToken(credentialToken) ? "agent" as const : "node-admin" as const,
    agentAddress: agent.resolveAgentAddress(credentialToken),
  };

  return {
    requestAuth,
    credentialToken,
    principal,
  };
}
