// SPDX-License-Identifier: Apache-2.0

import type { PublisherWorkspaceOperationSemantics, NormalizedWorkspaceOperationProvenance } from '../../src/workspace-operation-equivalence.js';

// @ts-expect-error Publisher semantics cannot admit an identity-less candidate.
const missingPublisher: PublisherWorkspaceOperationSemantics = {
  publicQuadsDigest: `sha256:${'1'.repeat(64)}`,
  publicTripleCount: 2,
  privateTripleCount: 0,
  access: { kind: 'legacy-default', accessPolicy: 'public', allowedPeers: [] },
};

void missingPublisher;

// @ts-expect-error Internal provenance cannot omit the authentication decision.
const omittedAuthentication: NormalizedWorkspaceOperationProvenance = { shareOperationId: 'unverified' };
const authenticated: NormalizedWorkspaceOperationProvenance = { shareOperationId: 'signed', publisherChronologyAuthenticated: true };
const unverified: NormalizedWorkspaceOperationProvenance = { shareOperationId: 'provider', publisherChronologyAuthenticated: false };
void [omittedAuthentication, authenticated, unverified];
