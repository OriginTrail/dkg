import {
  contextGraphDormancyAfterAuthority,
  type ContextGraphReadAuthorityNotAllowed,
} from '../src/context-graph-subscription-dormancy.js';
import type { ContextGraphReadAuthorityDecision } from '../src/context-graph-read-authority.js';
import type { RollingSubscriptionCheckPass } from '../src/context-graph-subscription-rolling-checks.js';

declare const decision: ContextGraphReadAuthorityDecision;
declare const pass: RollingSubscriptionCheckPass;

// A decision is classified only after its `allowed` outcome is ruled out.
if (decision.outcome !== 'allowed') {
  const notAllowed: ContextGraphReadAuthorityNotAllowed = {
    outcome: decision.outcome,
    source: decision.source,
    reason: decision.reason,
  };
  void contextGraphDormancyAfterAuthority(notAllowed);
  void pass.leftDormant('graph', notAllowed);
}
void contextGraphDormancyAfterAuthority({ outcome: 'denied', reason: 'agent-not-in-chain-roster' });
void contextGraphDormancyAfterAuthority({ outcome: 'unavailable', reason: 'chain-access-policy-unknown' });

// @ts-expect-error An allowed decision has no dormancy.
void contextGraphDormancyAfterAuthority({ outcome: 'allowed', reason: 'open-context-graph' });
// @ts-expect-error An outcome the authority model does not have is not a retryable one.
void contextGraphDormancyAfterAuthority({ outcome: 'waiting', reason: 'test' });
// @ts-expect-error A decision whose outcome may still be `allowed` is not classified.
void contextGraphDormancyAfterAuthority(decision);
// @ts-expect-error The same holds for the row a rolling-activation check leaves dormant.
void pass.leftDormant('graph', decision);
// @ts-expect-error A source the authority model does not have is rejected too.
void pass.leftDormant('graph', { outcome: 'denied', source: 'guess', reason: 'test' });
