// SPDX-License-Identifier: Apache-2.0

import type { PublisherWorkspaceOperationSemantics } from '../../src/workspace-operation-equivalence.js';

// @ts-expect-error Publisher semantics cannot admit an identity-less candidate.
const missingPublisher: PublisherWorkspaceOperationSemantics = {
  publicQuadsDigest: `sha256:${'1'.repeat(64)}`,
  publicTripleCount: 2,
  privateTripleCount: 0,
  access: { kind: 'legacy-default', accessPolicy: 'public', allowedPeers: [] },
};

void missingPublisher;
