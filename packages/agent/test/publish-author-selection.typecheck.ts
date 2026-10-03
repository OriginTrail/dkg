import type { DKGAgent, PublishAuthorSelection } from '@origintrail-official/dkg-agent';
import type { FinalizedPublishIdentityPlan } from '../src/internal/finalized-publish-identity.js';

declare const agent: DKGAgent;
const selections: PublishAuthorSelection[] = [
  { mode: 'author', agentAddress: 'author' },
  { mode: 'callerHint', callerAgentAddress: 'caller' },
  { mode: 'residentAuthor', selectedAuthorAgentAddress: 'member', callerAgentAddress: 'curator' },
  { mode: 'residentAuthor', selectedAuthorAgentAddress: 'member' },
];
for (const authorSelection of selections) {
  void agent.resolveFinalizedAssertionPublishAuthor('cg', 'name', { authorSelection });
  void agent.resolveFinalizedAssertionVmPublishIntent('cg', 'name', { authorSelection });
  void agent.publishFromFinalizedAssertion('cg', 'name', { authorSelection });
}
void agent.publishFromFinalizedAssertion('cg', 'name', { publishEpochs: 2 });
void agent.resolveFinalizedAssertionPublishAuthor('cg', 'name', { agentAddress: undefined, callerAgentAddress: undefined });

const compatibleFlatOptions = [
  { agentAddress: 'author' },
  { callerAgentAddress: 'caller' },
  { callerAgentAddress: 'caller', selectedAuthorAgentAddress: 'member' },
] as const;
for (const options of compatibleFlatOptions) {
  void agent.resolveFinalizedAssertionPublishAuthor('cg', 'name', options);
  void agent.resolveFinalizedAssertionVmPublishIntent('cg', 'name', options);
  void agent.publishFromFinalizedAssertion('cg', 'name', options);
}

const contradictory = { mode: 'author' as const, agentAddress: 'author', callerAgentAddress: 'caller' };
// @ts-expect-error A widened variable cannot combine authoritative author and caller hint.
const invalidSelection: PublishAuthorSelection = contradictory;
// @ts-expect-error The public author resolver enforces the same exclusive model.
void agent.resolveFinalizedAssertionPublishAuthor('cg', 'name', { authorSelection: contradictory });
// @ts-expect-error The async intent boundary enforces the same exclusive model.
void agent.resolveFinalizedAssertionVmPublishIntent('cg', 'name', { authorSelection: contradictory });
// @ts-expect-error The immediate publish boundary enforces the same exclusive model.
void agent.publishFromFinalizedAssertion('cg', 'name', { authorSelection: contradictory });
// @ts-expect-error Resident selection must not carry an authoritative author override.
const invalidResident: PublishAuthorSelection = { mode: 'residentAuthor', selectedAuthorAgentAddress: 'member', agentAddress: 'other' };

// Retain source compatibility with callers using the released optional-string bag.
const legacyBags: { agentAddress?: string; callerAgentAddress?: string; selectedAuthorAgentAddress?: string; subGraphName?: string }[] = [
  { agentAddress: 'author' },
  { callerAgentAddress: 'caller' },
  { selectedAuthorAgentAddress: 'member', callerAgentAddress: 'curator' },
  { selectedAuthorAgentAddress: 'member' },
  { subGraphName: 'research' },
];
for (const legacyBag of legacyBags) {
  void agent.resolveFinalizedAssertionPublishAuthor('cg', 'name', legacyBag);
  void agent.resolveFinalizedAssertionVmPublishIntent('cg', 'name', legacyBag);
  void agent.publishFromFinalizedAssertion('cg', 'name', legacyBag);
}
const mixedBag = { authorSelection: selections[0], agentAddress: 'other' };
// @ts-expect-error Nested and flat selection forms cannot be combined.
void agent.resolveFinalizedAssertionPublishAuthor('cg', 'name', mixedBag);
// @ts-expect-error Nested and flat selection forms cannot be combined.
void agent.resolveFinalizedAssertionVmPublishIntent('cg', 'name', mixedBag);
// @ts-expect-error Nested and flat selection forms cannot be combined.
void agent.publishFromFinalizedAssertion('cg', 'name', mixedBag);
void invalidSelection; void invalidResident;

// @ts-expect-error A resident plan cannot omit its parsed selector.
const incompleteResidentPlan: FinalizedPublishIdentityPlan = { kind: 'residentAuthor', enqueueCaller: undefined };
declare const untrustedSelector: unknown;
// @ts-expect-error Unknown selector input must be parsed before resident resolution.
const uncheckedResidentPlan: FinalizedPublishIdentityPlan = { kind: 'residentAuthor', selectedAuthor: untrustedSelector, enqueueCaller: undefined };
// @ts-expect-error A caller plan must carry its resolved hint, including the empty-string case.
const incompleteCallerPlan: FinalizedPublishIdentityPlan = { kind: 'callerHint', enqueueCaller: undefined };
void incompleteResidentPlan; void uncheckedResidentPlan; void incompleteCallerPlan;
