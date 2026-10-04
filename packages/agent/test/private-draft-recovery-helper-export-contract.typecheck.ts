// SPDX-License-Identifier: Apache-2.0

import { applySwmRecovery, type SwmRecoveryStore } from '@origintrail-official/dkg-agent/dist/sync/requester/swm-recovery-apply.js';
import { runSharedMemorySync, type SharedMemorySyncContext } from '@origintrail-official/dkg-agent/dist/sync/requester/shared-memory-sync.js';

void applySwmRecovery;
void runSharedMemorySync;
declare const store: SwmRecoveryStore;
declare const context: SharedMemorySyncContext;
void store;
void context;

// @ts-expect-error internal draft, expiry and recovered-operation helpers remain private
import type * as PrivateHelper0 from '@origintrail-official/dkg-agent/dist/confirmed-draft-version.js';
void (null as unknown as typeof PrivateHelper0);

// @ts-expect-error internal draft, expiry and recovered-operation helpers remain private
import type * as PrivateHelper1 from '@origintrail-official/dkg-agent/dist/draft-artifact-gc.js';
void (null as unknown as typeof PrivateHelper1);

// @ts-expect-error internal draft, expiry and recovered-operation helpers remain private
import type * as PrivateHelper2 from '@origintrail-official/dkg-agent/dist/finalize-draft-version.js';
void (null as unknown as typeof PrivateHelper2);

// @ts-expect-error internal draft, expiry and recovered-operation helpers remain private
import type * as PrivateHelper3 from '@origintrail-official/dkg-agent/dist/swm-expiry-batch.js';
void (null as unknown as typeof PrivateHelper3);

// @ts-expect-error internal draft, expiry and recovered-operation helpers remain private
import type * as PrivateHelper4 from '@origintrail-official/dkg-agent/dist/swm-operation-expiry.js';
void (null as unknown as typeof PrivateHelper4);

// @ts-expect-error internal draft, expiry and recovered-operation helpers remain private
import type * as PrivateHelper5 from '@origintrail-official/dkg-agent/dist/sync/requester/swm-draft-order.js';
void (null as unknown as typeof PrivateHelper5);

// @ts-expect-error internal draft, expiry and recovered-operation helpers remain private
import type * as PrivateHelper6 from '@origintrail-official/dkg-agent/dist/sync/requester/swm-recovered-provenance.js';
void (null as unknown as typeof PrivateHelper6);

// @ts-expect-error internal draft, expiry and recovered-operation helpers remain private
import type * as PrivateHelper7 from '@origintrail-official/dkg-agent/dist/sync/requester/swm-recovery-bulk-metadata.js';
void (null as unknown as typeof PrivateHelper7);

// @ts-expect-error internal draft, expiry and recovered-operation helpers remain private
import type * as PrivateHelper8 from '@origintrail-official/dkg-agent/dist/sync/requester/swm-recovery-commit.js';
void (null as unknown as typeof PrivateHelper8);
