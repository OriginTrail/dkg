// SPDX-License-Identifier: Apache-2.0

import { applySwmRecovery, type SwmRecoveryStore } from '@origintrail-official/dkg-agent/dist/sync/requester/swm-recovery-apply.js';
import { runSharedMemorySync, type SharedMemorySyncContext } from '@origintrail-official/dkg-agent/dist/sync/requester/shared-memory-sync.js';

void applySwmRecovery;
void runSharedMemorySync;
declare const store: SwmRecoveryStore;
declare const context: SharedMemorySyncContext;
void store;
void context;

// @ts-expect-error The complete internal namespace is private, including draft validation.
import type * as DraftHelper from '@origintrail-official/dkg-agent/dist/internal/draft/confirmed-draft-version.js';
void (null as unknown as typeof DraftHelper);

// @ts-expect-error The complete internal namespace is private, including expiry ownership.
import type * as ExpiryHelper from '@origintrail-official/dkg-agent/dist/internal/swm-expiry/swm-operation-expiry.js';
void (null as unknown as typeof ExpiryHelper);

// @ts-expect-error The complete internal namespace is private, including recovery commits.
import type * as RecoveryHelper from '@origintrail-official/dkg-agent/dist/internal/swm-recovery/swm-recovery-commit.js';
void (null as unknown as typeof RecoveryHelper);
