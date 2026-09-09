import type { DKGAgent, PublishAuthorSelection } from '@origintrail-official/dkg-agent';

declare const agent: DKGAgent;
const selections: PublishAuthorSelection[] = [
  { mode: 'author', agentAddress: 'author' },
  { mode: 'callerHint', callerAgentAddress: 'caller' },
  { mode: 'residentAuthor', selectedAuthorAgentAddress: 'member', callerAgentAddress: 'curator' },
  { mode: 'residentAuthor', selectedAuthorAgentAddress: 'member' },
  { mode: 'default' },
];
for (const authorSelection of selections) {
  void agent.resolveFinalizedAssertionPublishAuthor('cg', 'name', { authorSelection });
  void agent.resolveFinalizedAssertionVmPublishIntent('cg', 'name', { authorSelection });
  void agent.publishFromFinalizedAssertion('cg', 'name', { authorSelection });
}
void agent.publishFromFinalizedAssertion('cg', 'name', { publishEpochs: 2 });
void agent.resolveFinalizedAssertionPublishAuthor('cg', 'name', { agentAddress: undefined, callerAgentAddress: undefined });

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

const legacyBag = { subGraphName: 'research', agentAddress: 'author', callerAgentAddress: 'caller' };
// @ts-expect-error Legacy identity bags cannot bypass the model via widened variables.
void agent.resolveFinalizedAssertionPublishAuthor('cg', 'name', legacyBag);
// @ts-expect-error Legacy identity bags cannot bypass the async boundary.
void agent.resolveFinalizedAssertionVmPublishIntent('cg', 'name', legacyBag);
// @ts-expect-error Legacy identity bags cannot bypass the immediate boundary.
void agent.publishFromFinalizedAssertion('cg', 'name', legacyBag);
void invalidSelection; void invalidResident;
