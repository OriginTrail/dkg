// SPDX-License-Identifier: Apache-2.0

import {
  ContextGraphReadAuthorityUnavailableError,
  unavailableContextGraphReadAuthorityDecision,
  type UnavailableContextGraphReadAuthorityDecision,
  type SettledContextGraphReadAuthorityDecision,
} from '../src/context-graph-read-authority.js';

unavailableContextGraphReadAuthorityDecision('legacy-local',
  // @ts-expect-error Unavailable producers cannot rename a reason outside the canonical registry.
  'pending-authoritative-metadata-renamed', 'local-state');
new ContextGraphReadAuthorityUnavailableError('cg', {
  source: 'legacy-local', dependency: 'local-state',
  // @ts-expect-error The thrown producer contract uses the same closed vocabulary.
  reason: 'pending-authoritative-metadata-renamed',
});
export const unknownDecision: UnavailableContextGraphReadAuthorityDecision = {
  outcome: 'unavailable', source: 'legacy-local', dependency: 'local-state', metadataBootstrap: 'eligible',
  // @ts-expect-error Direct unavailable decisions cannot evade the constructor contract.
  reason: 'pending-authoritative-metadata-renamed',
};
export const settledExplanation: SettledContextGraphReadAuthorityDecision = {
  outcome: 'denied', source: 'legacy-local', reason: 'settled-policy-explanation', metadataBootstrap: 'forbidden',
};
