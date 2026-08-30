/** Authenticated HTTP identity established by the daemon authentication boundary. */
export type AuthenticatedRequestPrincipal =
  | { readonly kind: 'agent'; readonly agentAddress: string }
  | { readonly kind: 'nodeOperator' };

/** Request identity routes may consume without re-reading credentials. */
export type RequestPrincipal =
  | AuthenticatedRequestPrincipal
  | { readonly kind: 'anonymous' };
