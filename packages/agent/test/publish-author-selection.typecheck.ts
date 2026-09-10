import type { DKGAgent, PublishAuthorSelection } from '@origintrail-official/dkg-agent';

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

const contradictoryFlatBag = { subGraphName: 'research', agentAddress: 'author', callerAgentAddress: 'caller' };
// @ts-expect-error Compatible flat fields remain mutually exclusive via widened variables.
void agent.resolveFinalizedAssertionPublishAuthor('cg', 'name', contradictoryFlatBag);
// @ts-expect-error The async boundary enforces the same flat-field exclusivity.
void agent.resolveFinalizedAssertionVmPublishIntent('cg', 'name', contradictoryFlatBag);
// @ts-expect-error The immediate boundary enforces the same flat-field exclusivity.
void agent.publishFromFinalizedAssertion('cg', 'name', contradictoryFlatBag);
void invalidSelection; void invalidResident;
