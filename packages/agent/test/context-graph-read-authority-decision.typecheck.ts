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
const draftInput: KnowledgeAssetReadInput = { cg: 'cg', name: 'compact:name', agentAddress: '0xcaller', read: 'quads' };
const draftDecision: Promise<KnowledgeAssetReadResolution> = resolveKnowledgeAssetRead(draftAgent, draftInput, draftOptions);
// @ts-expect-error A KA read must name the requested resource operation.
const missingReadOperation: KnowledgeAssetReadInput = { cg: 'cg', name: 'compact:name' };
// @ts-expect-error The combined resolution cannot discard its resource evidence.
const discardedEvidence: Promise<ContextGraphReadAuthorityDecision> = resolveKnowledgeAssetRead(draftAgent, draftInput, draftOptions);
void [draftDecision, missingReadOperation, discardedEvidence];
