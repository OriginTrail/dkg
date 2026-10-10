// SPDX-License-Identifier: Apache-2.0

import type { ContextGraphAuthorityIndexRefreshHorizonLease } from
  '../src/context-graph-authority-index-horizon.js';
import type {
  ContextGraphAuthorityIndexAdmittedRepositoryRecord,
  ContextGraphAuthorityIndexCommittedRepositoryRecord,
  ContextGraphAuthorityIndexRepositoryRecord,
} from '../src/context-graph-authority-index-repository.js';

declare const lease: ContextGraphAuthorityIndexRefreshHorizonLease;
declare const admitted: ContextGraphAuthorityIndexAdmittedRepositoryRecord;
declare const committed: ContextGraphAuthorityIndexCommittedRepositoryRecord;
declare const invalid: Extract<ContextGraphAuthorityIndexRepositoryRecord, { kind: 'invalid' }>;
declare const tombstone: Extract<
  ContextGraphAuthorityIndexAdmittedRepositoryRecord,
  { kind: 'tombstone' }
>;

lease.admitDurableGeneration('scope', admitted);
lease.commitDurableGeneration('scope', committed);

// @ts-expect-error Invalid durable rows must be repaired before lineage admission.
lease.admitDurableGeneration('scope', invalid);

// @ts-expect-error Kind and token cannot be supplied as independently inconsistent arguments.
lease.admitDurableGeneration('scope', 'missing', 17);

// @ts-expect-error A tombstone is admitted, but it is not a committed checkpoint generation.
lease.commitDurableGeneration('scope', tombstone);
