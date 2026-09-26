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
  metadataBootstrap: 'eligible',
};
