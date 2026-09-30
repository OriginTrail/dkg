// SPDX-License-Identifier: Apache-2.0

// Compile-time contract of `WorkspaceSnapshotLifecycle`, checked by
// `tsconfig.test-helpers.json` (`pnpm run test:helper-types`, part of the package build).
// Vitest strips types and no publisher tsconfig includes `workspace-snapshot-retirement.test.ts`,
// so a `@ts-expect-error` inside that test is never evaluated: the negative case has to live
// here, where an unused directive fails the build (TS2578).
//
// The contract: a lifecycle that reports finalized cleanup enabled MUST offer `operationLease`
// (retirement scheduling and ACK-copy cleanup rely on operations holding their files); a
// cleanup-disabled lifecycle MAY offer it. The runtime side (a value that gets past the type
// anyway simply gets no operation-long lease) is pinned in `workspace-snapshot-retirement.test.ts`.
// The source is imported directly, not through the package specifier, so this check follows the
// current `src` and not a stale `dist`.

import type { WorkspaceSnapshotLifecycle } from '../../src/workspace-snapshot-lifecycle.js';

const acquireExisting = async (_ref: string): Promise<(() => void) | undefined> => () => {};
const markPublished = async (_refs: readonly string[]): Promise<void> => {};
const operationLease = async (_ref: string): Promise<() => void> => () => {};
declare const cleanupEnabled: boolean;

// Accepted: cleanup enabled with the lease; cleanup disabled with and without it.
const enabledWithLease: WorkspaceSnapshotLifecycle = { finalizedCleanupEnabled: true, acquireExisting, markPublished, operationLease };
const disabledWithLease: WorkspaceSnapshotLifecycle = { finalizedCleanupEnabled: false, acquireExisting, markPublished, operationLease };
const disabledWithoutLease: WorkspaceSnapshotLifecycle = { finalizedCleanupEnabled: false, acquireExisting, markPublished };
// A flag only known to be a boolean is fine while the lease is offered.
const undecidedWithLease: WorkspaceSnapshotLifecycle = { finalizedCleanupEnabled: cleanupEnabled, acquireExisting, markPublished, operationLease };
void [enabledWithLease, disabledWithLease, disabledWithoutLease, undecidedWithLease];

// Rejected: a cleanup-enabled lifecycle without `operationLease`.
// @ts-expect-error operationLease is required when finalizedCleanupEnabled is true
const enabledWithoutLease: WorkspaceSnapshotLifecycle = { finalizedCleanupEnabled: true, acquireExisting, markPublished };
void enabledWithoutLease;
// The same when the flag is only known to be a boolean: it may be true, so the lease is required.
// @ts-expect-error operationLease is required unless finalizedCleanupEnabled is known to be false
const undecidedWithoutLease: WorkspaceSnapshotLifecycle = { finalizedCleanupEnabled: cleanupEnabled, acquireExisting, markPublished };
void undecidedWithoutLease;

// Readers get the guarantee back: once the flag is checked, the lease is present without a guard.
declare const lifecycle: WorkspaceSnapshotLifecycle;
if (lifecycle.finalizedCleanupEnabled) {
  const lease: (ref: string) => Promise<() => void> = lifecycle.operationLease;
  void lease;
}
