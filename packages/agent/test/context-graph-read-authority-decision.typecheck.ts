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

// KA resolution carries its admission and resource together; graph authority stays input-driven.
import type { DKGAgent } from '../src/index.js';
import { resolveKnowledgeAssetRead, type KnowledgeAssetReadInput, type KnowledgeAssetReadOptions, type KnowledgeAssetReadResolution } from '../src/knowledge-asset-read-resolution.js';
declare const draftAgent: DKGAgent;
const draftOptions: KnowledgeAssetReadOptions = { callerAgentAddress: '0xcaller' };
const draftInput: KnowledgeAssetReadInput = { cg: 'cg', name: 'compact:name', agentAddress: '0xcaller', kind: 'identifier', lookup: 'quads' };
const draftDecision: Promise<KnowledgeAssetReadResolution> = resolveKnowledgeAssetRead(draftAgent, draftInput, draftOptions);
// @ts-expect-error A KA read must name the requested resource operation.
const missingReadOperation: KnowledgeAssetReadInput = { cg: 'cg', name: 'compact:name' };
// @ts-expect-error The combined resolution cannot discard its resource evidence.
const discardedEvidence: Promise<ContextGraphReadAuthorityDecision> = resolveKnowledgeAssetRead(draftAgent, draftInput, draftOptions);
void [draftDecision, missingReadOperation, discardedEvidence];

// Admission and resource evidence are correlated; granted node evidence is not caller admission.
declare const kaResolution: KnowledgeAssetReadResolution;
if (kaResolution.outcome === 'admitted') {
  const name: string = kaResolution.target.name;
  const allowedOutcome: 'allowed' = kaResolution.decision.outcome;
  void [name, allowedOutcome];
} else {
  const noTarget: null = kaResolution.target;
  void noTarget;
}
// @ts-expect-error An admitted KA read must carry its resolved resource.
const admittedWithoutTarget: KnowledgeAssetReadResolution = { outcome: 'admitted', decision: allowed, target: null };
// @ts-expect-error An unavailable KA read cannot carry a readable target.
const unavailableWithTarget: KnowledgeAssetReadResolution = { outcome: 'unavailable', decision: unavailableWithDependency, target: { kind: 'name', cg: 'cg', name: 'asset', descriptor: null } };
// @ts-expect-error A literal target's owner explicitly suppresses domain lookup.
const literalWithAliasLookup: KnowledgeAssetReadInput = { cg: 'cg', name: 'asset', kind: 'literal', lookup: 'descriptor' };
void [admittedWithoutTarget, unavailableWithTarget, literalWithAliasLookup];
