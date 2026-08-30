import {
  createAllowedHttpAuthentication,
  type AllowedHttpAuthentication,
} from '../../src/auth.js';

type FixtureAuthentication =
  | {
      readonly kind: 'agent';
      readonly agentAddress: string;
      readonly mode?: AllowedHttpAuthentication['mode'];
      readonly token?: string;
    }
  | {
      readonly kind: 'nodeOperator';
      readonly mode?: AllowedHttpAuthentication['mode'];
      readonly token?: string;
    }
  | {
      readonly kind: 'anonymous';
      readonly mode?: 'disabled' | 'public';
      readonly presentedToken?: string;
    };

/** Correlated RequestContext authentication fixture built through the production factory. */
export function requestAuthentication(input: FixtureAuthentication): AllowedHttpAuthentication {
  if (input.kind === 'anonymous') {
    return createAllowedHttpAuthentication({
      mode: input.mode ?? 'public',
      presentedToken: input.presentedToken,
    });
  }
  const token = input.token ?? (
    input.kind === 'agent' ? 'fixture-agent-token' : 'fixture-node-operator-token'
  );
  return createAllowedHttpAuthentication({
    mode: input.mode ?? 'authenticated',
    presentedToken: token,
    acceptedToken: token,
    ...(input.kind === 'agent'
      ? { resolveAgentByToken: () => input.agentAddress }
      : {}),
  });
}
