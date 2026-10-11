import type {
  ContextGraphReadAuthorityDecision,
  UnavailableContextGraphReadAuthorityDecision,
} from '../src/index.js';

// An unavailable decision must name the dependency that could not answer (#2834).
// @ts-expect-error dependency is required when the outcome is unavailable
export const unavailableWithoutDependency: ContextGraphReadAuthorityDecision = {
  outcome: 'unavailable',
  source: 'registered-chain',
  reason: 'chain-name-binding-unavailable',
  metadataBootstrap: 'eligible',
};

export const unavailableWithDependency: UnavailableContextGraphReadAuthorityDecision = {
  outcome: 'unavailable',
  source: 'registered-chain',
  reason: 'chain-name-binding-unavailable',
  metadataBootstrap: 'eligible',
  dependency: 'chain',
};

// A settled decision carries no dependency.
export const allowed: ContextGraphReadAuthorityDecision = {
  outcome: 'allowed',
  source: 'system',
  reason: 'system-context-graph',
  grantScope: 'public',
  metadataBootstrap: 'eligible',
};

// @ts-expect-error a settled grant must declare whether it is caller-, public-, or node-scoped
export const allowedWithoutScope: ContextGraphReadAuthorityDecision = {
  outcome: 'allowed', source: 'legacy-local', reason: 'renamed-for-diagnostics', metadataBootstrap: 'eligible',
};

export const allowedWithNoGrant: ContextGraphReadAuthorityDecision = {
  outcome: 'allowed', source: 'system', reason: 'system', metadataBootstrap: 'eligible',
  // @ts-expect-error an allowed decision cannot convey no grant
  grantScope: 'none',
};

export const deniedWithCallerGrant: ContextGraphReadAuthorityDecision = {
  outcome: 'denied', source: 'registered-chain', reason: 'not-a-member', metadataBootstrap: 'forbidden',
  // @ts-expect-error a denied decision cannot convey a caller grant
  grantScope: 'caller',
};

// A draft read names an explicit author lane; it does not change general read authority.
import type { DKGAgent } from '../src/index.js';
import { resolveKnowledgeAssetDraftReadAuthority, type KnowledgeAssetDraftReadAuthorityOptions } from '../src/context-graph-read-authority.js';
declare const draftAgent: DKGAgent;
const draftOptions: KnowledgeAssetDraftReadAuthorityOptions = {
  callerAgentAddress: '0xcaller', draft: { agentAddress: '0xcaller', literalName: 'compact:name' },
};
const draftDecision: Promise<ContextGraphReadAuthorityDecision> = resolveKnowledgeAssetDraftReadAuthority(draftAgent, 'cg', draftOptions);
// @ts-expect-error A draft proof cannot omit its selected author lane.
const missingDraftAuthor: KnowledgeAssetDraftReadAuthorityOptions = { draft: { literalName: 'compact:name' } };
void [draftDecision, missingDraftAuthor];
