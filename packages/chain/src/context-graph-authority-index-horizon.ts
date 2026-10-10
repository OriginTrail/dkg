// SPDX-License-Identifier: Apache-2.0

import { normalizeContextGraphAuthorityHash as normalizeHash } from
  './context-graph-authority-generation.js';
import { ContextGraphAuthorityIndexRetryableError } from
  './context-graph-authority-index-errors.js';
import type {
  ContextGraphAuthorityIndexAdmittedRepositoryRecord,
  ContextGraphAuthorityIndexCommittedRepositoryRecord,
} from './context-graph-authority-index-repository.js';

type ContextGraphAuthorityIndexRefreshHorizon = Readonly<{
  number: number;
  hash: string;
}>;

type ContextGraphAuthorityRefreshHorizonConstraint = Readonly<{
  number: number;
  hashes: ReadonlySet<string>;
  rejectAtNumber: boolean;
}>;

type ContextGraphAuthorityRecoveryBoundary = Readonly<{
  repositoryKey: string;
  token: number;
  rejectionRevision: number;
}>;

interface ContextGraphAuthorityHorizonScopeState {
  unsettledLeases: number;
  /** Every rejection invalidates lineage evidence observed before it. */
  rejectionRevision: number;
  /** Last successful durable background scan (or successful fork rebuild). */
  committed?: ContextGraphAuthorityIndexRefreshHorizon;
  /** Physical scans that fence projections until they succeed or fail. */
  active?: Map<object, ContextGraphAuthorityIndexRefreshHorizon>;
  /** Failed checkpoint recovery disproved every projection through this height. */
  rejectedThrough?: number;
  /** Greatest rejected generation per durable repository key. */
  rejectedDurableThroughTokens?: Map<string, number>;
  /** Safe tombstone/re-admitted generation per durable repository key. */
  recoveryBoundaries?: Map<string, ContextGraphAuthorityRecoveryBoundary>;
}

type ContextGraphAuthorityRecoveryEvidence =
  | Readonly<{ kind: 'unproven' }>
  | Readonly<{
      kind: 'proven';
      boundary: ContextGraphAuthorityRecoveryBoundary;
    }>;

/** The one durable lineage owned by a physical refresh lease. */
type ContextGraphAuthorityLeaseLineage =
  | Readonly<{ kind: 'unobserved' }>
  | Readonly<{
      kind: 'rooted-missing';
      repositoryKey: string;
      rejectionRevision: number;
    }>
  | Readonly<{
      kind: 'rooted';
      repositoryKey: string;
      token: number;
      rejectionRevision: number;
      recovery: ContextGraphAuthorityRecoveryEvidence;
    }>
  | Readonly<{
      kind: 'admitted';
      repositoryKey: string;
      token: number;
      recovery: ContextGraphAuthorityRecoveryEvidence;
    }>;

const UNOBSERVED_LEASE_LINEAGE = Object.freeze({ kind: 'unobserved' as const });
const UNPROVEN_RECOVERY = Object.freeze({ kind: 'unproven' as const });

type PublishRecoveryBoundary = (
  repositoryKey: string,
  boundaryToken: number,
) => ContextGraphAuthorityRecoveryBoundary | undefined;

function recoveryEvidence(
  token: number,
  boundary: ContextGraphAuthorityRecoveryBoundary | undefined,
): ContextGraphAuthorityRecoveryEvidence {
  return boundary !== undefined && token >= boundary.token
    ? Object.freeze({ kind: 'proven', boundary })
    : UNPROVEN_RECOVERY;
}

/** A rejection invalidates proof, while another key's old root keeps its revision. */
function rejectLeaseLineage(
  lineage: ContextGraphAuthorityLeaseLineage,
  rejectedRepositoryKey: string,
): ContextGraphAuthorityLeaseLineage {
  switch (lineage.kind) {
    case 'unobserved':
      return lineage;
    case 'rooted-missing':
      return lineage.repositoryKey === rejectedRepositoryKey
        ? UNOBSERVED_LEASE_LINEAGE
        : lineage;
    case 'rooted':
      return lineage.repositoryKey === rejectedRepositoryKey
        ? Object.freeze({
            kind: 'admitted',
            repositoryKey: lineage.repositoryKey,
            token: lineage.token,
            recovery: UNPROVEN_RECOVERY,
          })
        : Object.freeze({ ...lineage, recovery: UNPROVEN_RECOVERY });
    case 'admitted':
      return Object.freeze({ ...lineage, recovery: UNPROVEN_RECOVERY });
  }
}

/** Transition the physical lease through one admitted durable observation. */
function admitLeaseLineage(
  lineage: ContextGraphAuthorityLeaseLineage,
  repositoryKey: string,
  admitted: ContextGraphAuthorityIndexAdmittedRepositoryRecord,
  state: ContextGraphAuthorityHorizonScopeState,
  rejectionRevisionAtStart: number,
  checkpointRejected: boolean,
  publishRecoveryBoundary: PublishRecoveryBoundary,
): ContextGraphAuthorityLeaseLineage {
  if (admitted.kind === 'missing') {
    return Object.freeze({
      kind: 'rooted-missing',
      repositoryKey,
      rejectionRevision: state.rejectionRevision,
    });
  }
  if (admitted.kind === 'tombstone') {
    return Object.freeze({
      kind: 'rooted',
      repositoryKey,
      token: admitted.token,
      rejectionRevision: state.rejectionRevision,
      recovery: recoveryEvidence(
        admitted.token,
        publishRecoveryBoundary(repositoryKey, admitted.token),
      ),
    });
  }

  const rootIsCurrent = (lineage.kind === 'rooted-missing' || lineage.kind === 'rooted')
    && lineage.repositoryKey === repositoryKey
    && lineage.rejectionRevision === state.rejectionRevision;
  const repositoryHasNoRejectedLineage =
    !state.rejectedDurableThroughTokens?.has(repositoryKey);
  const followsCompletedRecovery = rejectionRevisionAtStart === state.rejectionRevision
    && [...(state.recoveryBoundaries?.values() ?? [])]
      .some((boundary) => boundary.rejectionRevision === state.rejectionRevision);
  const independentlyReadmitted = repositoryHasNoRejectedLineage
    && (checkpointRejected || followsCompletedRecovery);
  const boundary = rootIsCurrent || independentlyReadmitted
    ? publishRecoveryBoundary(repositoryKey, admitted.token)
    : state.recoveryBoundaries?.get(repositoryKey);
  return Object.freeze({
    kind: 'admitted',
    repositoryKey,
    token: admitted.token,
    recovery: recoveryEvidence(admitted.token, boundary),
  });
}

/** Transition the physical lease through a checkpoint CAS descended from its admission. */
function commitLeaseLineage(
  lineage: ContextGraphAuthorityLeaseLineage,
  repositoryKey: string,
  committed: ContextGraphAuthorityIndexCommittedRepositoryRecord,
  rejectionRevision: number,
  publishRecoveryBoundary: PublishRecoveryBoundary,
): ContextGraphAuthorityLeaseLineage {
  if ((lineage.kind === 'rooted-missing' || lineage.kind === 'rooted')
    && lineage.repositoryKey === repositoryKey) {
    if (lineage.rejectionRevision !== rejectionRevision) {
      return Object.freeze({
        kind: 'admitted',
        repositoryKey,
        token: committed.token,
        recovery: UNPROVEN_RECOVERY,
      });
    }
    return Object.freeze({
      kind: 'rooted',
      repositoryKey,
      token: committed.token,
      rejectionRevision,
      recovery: recoveryEvidence(
        committed.token,
        publishRecoveryBoundary(repositoryKey, committed.token),
      ),
    });
  }
  const recovery = lineage.kind === 'admitted'
    && lineage.repositoryKey === repositoryKey
    && lineage.recovery.kind === 'proven'
    && committed.token >= lineage.recovery.boundary.token
    ? lineage.recovery
    : UNPROVEN_RECOVERY;
  return Object.freeze({
    kind: 'admitted',
    repositoryKey,
    token: committed.token,
    recovery,
  });
}

/** Return proof still owned by both this lineage and the current scope revision. */
function activeRecoveryBoundary(
  lineage: ContextGraphAuthorityLeaseLineage,
  state: ContextGraphAuthorityHorizonScopeState,
): ContextGraphAuthorityRecoveryBoundary | undefined {
  if ((lineage.kind !== 'rooted' && lineage.kind !== 'admitted')
    || lineage.recovery.kind !== 'proven') return undefined;
  const boundary = lineage.recovery.boundary;
  return boundary.rejectionRevision === state.rejectionRevision
    && state.recoveryBoundaries?.get(lineage.repositoryKey) === boundary
    ? boundary
    : undefined;
}

export interface ContextGraphAuthorityIndexHorizonReader {
  admits(
    scope: string,
    finalized: Readonly<{ number: number; hash: string }>,
  ): boolean;
  assertAtOrAbove(
    scope: string,
    finalized: Readonly<{ number: number; hash: string }>,
  ): void;
}

export interface ContextGraphAuthorityIndexRefreshHorizonLease {
  /** Promote the physical scan to a publication fence. Idempotent for joiners. */
  activate(): void;
  /** Checkpoint recovery began; a successful scan may replace the old floor. */
  markCheckpointRejected(repositoryKey: string, rejectedToken: number): void;
  /** Record one repository observation only after this physical scan admitted it. */
  admitDurableGeneration(
    repositoryKey: string,
    admitted: ContextGraphAuthorityIndexAdmittedRepositoryRecord,
  ): void;
  /** Record a CAS commit descended from the generation admitted above. */
  commitDurableGeneration(
    repositoryKey: string,
    committed: ContextGraphAuthorityIndexCommittedRepositoryRecord,
  ): void;
  /** The scan stabilized its own unpersisted tail above its durable prefix. */
  markTailStabilized(): void;
  /** Settle from the lifecycle-owned physical promise, never a caller wait. */
  commit(): void;
  rollback(): void;
}

interface ContextGraphAuthorityIndexHorizonCallbacks {
  /** A newly active fence may obsolete a projection or detach its refresh owner. */
  readonly onConstraintChanged: (scope: string) => void;
  /** Rejection and successful recovery always invalidate retained projection state. */
  readonly onProjectionInvalidated: (scope: string) => void;
}

/**
 * Owns durable refresh horizons and rejected repository lineage.
 *
 * Projection retention is deliberately outside this coordinator. It exposes
 * only the current admission constraint and two invalidation notifications;
 * durable recovery therefore survives even when no projection is retained.
 */
export class ContextGraphAuthorityIndexHorizonCoordinator
implements ContextGraphAuthorityIndexHorizonReader {
  readonly #scopes = new Map<string, ContextGraphAuthorityHorizonScopeState>();
  readonly #callbacks: ContextGraphAuthorityIndexHorizonCallbacks;
  /** Lifecycle epoch prevents a pre-clear physical lease from restoring state. */
  #epoch = 0;

  constructor(callbacks: ContextGraphAuthorityIndexHorizonCallbacks) {
    this.#callbacks = callbacks;
  }

  begin(
    scope: string,
    finalized: Readonly<{ number: number; hash: string }>,
  ): ContextGraphAuthorityIndexRefreshHorizonLease {
    const finalizedHash = normalizeHash(finalized.hash);
    if (!Number.isSafeInteger(finalized.number)
      || finalized.number < 0
      || finalizedHash === undefined) {
      throw new Error('Context Graph authority refresh horizon is invalid');
    }
    const state = this.#scopeState(scope);
    state.unsettledLeases += 1;
    const horizon = Object.freeze({ number: finalized.number, hash: finalizedHash });
    const activationToken = Object.freeze({});
    const epoch = this.#epoch;
    const rejectionRevisionAtStart = state.rejectionRevision;
    let activated = false;
    let checkpointRejected = false;
    let tailStabilized = false;
    let lineage: ContextGraphAuthorityLeaseLineage = UNOBSERVED_LEASE_LINEAGE;
    let settled = false;

    const leaseIsCurrent = (): boolean => (
      epoch === this.#epoch && this.#scopes.get(scope) === state
    );
    const releaseLease = (): void => {
      if (this.#scopes.get(scope) !== state) return;
      state.unsettledLeases -= 1;
      this.#deleteScopeIfIdle(scope, state);
    };
    const assertRepositoryKey = (repositoryKey: string): void => {
      if (repositoryKey.trim().length === 0) {
        throw new Error('Context Graph authority durable repository key is empty');
      }
    };
    const publishRecoveryBoundary = (
      repositoryKey: string,
      boundaryToken: number,
    ): ContextGraphAuthorityRecoveryBoundary | undefined => {
      if (!leaseIsCurrent() || state.rejectedThrough === undefined) return undefined;
      const rejectedThrough = state.rejectedDurableThroughTokens?.get(repositoryKey) ?? -1;
      if (boundaryToken <= rejectedThrough) return undefined;
      const boundaries = state.recoveryBoundaries ?? new Map();
      const existing = boundaries.get(repositoryKey);
      if (existing !== undefined) return existing;
      const boundary = Object.freeze({
        repositoryKey,
        token: boundaryToken,
        rejectionRevision: state.rejectionRevision,
      });
      boundaries.set(repositoryKey, boundary);
      state.recoveryBoundaries = boundaries;
      return boundary;
    };
    const activate = (): void => {
      if (activated || settled || !leaseIsCurrent()) return;
      const before = this.#constraint(state);
      const active = state.active ?? new Map();
      active.set(activationToken, horizon);
      state.active = active;
      activated = true;
      const after = this.#constraint(state);
      if (!this.#sameConstraint(before, after)) this.#callbacks.onConstraintChanged(scope);
    };

    return Object.freeze({
      activate,
      markCheckpointRejected: (repositoryKey: string, rejectedToken: number): void => {
        if (settled) return;
        assertRepositoryKey(repositoryKey);
        if (!Number.isSafeInteger(rejectedToken) || rejectedToken < 1) {
          throw new Error('Context Graph authority rejected durable token is invalid');
        }
        checkpointRejected = true;
        if (!leaseIsCurrent()) return;
        state.rejectionRevision += 1;
        // A proof observed before this rejection—on this durable key or an
        // alternate bootstrap/fallback key—cannot discharge the newer fence.
        delete state.recoveryBoundaries;
        const rejectedDurableThroughTokens = state.rejectedDurableThroughTokens ?? new Map();
        rejectedDurableThroughTokens.set(repositoryKey, Math.max(
          rejectedDurableThroughTokens.get(repositoryKey) ?? -1,
          rejectedToken,
        ));
        state.rejectedDurableThroughTokens = rejectedDurableThroughTokens;
        lineage = rejectLeaseLineage(lineage, repositoryKey);
        state.rejectedThrough = Math.max(
          state.rejectedThrough ?? -1,
          state.committed?.number ?? -1,
          horizon.number,
        );
        activate();
        // The old durable lineage was disproved now, not only if the rebuild
        // later succeeds. Refuse it throughout recovery and after any failure.
        this.#callbacks.onProjectionInvalidated(scope);
      },
      admitDurableGeneration: (
        repositoryKey: string,
        admitted: ContextGraphAuthorityIndexAdmittedRepositoryRecord,
      ): void => {
        if (settled || !leaseIsCurrent()) return;
        assertRepositoryKey(repositoryKey);
        lineage = admitLeaseLineage(
          lineage,
          repositoryKey,
          admitted,
          state,
          rejectionRevisionAtStart,
          checkpointRejected,
          publishRecoveryBoundary,
        );
      },
      commitDurableGeneration: (
        repositoryKey: string,
        committed: ContextGraphAuthorityIndexCommittedRepositoryRecord,
      ): void => {
        if (settled || !leaseIsCurrent()) return;
        assertRepositoryKey(repositoryKey);
        lineage = commitLeaseLineage(
          lineage,
          repositoryKey,
          committed,
          state.rejectionRevision,
          publishRecoveryBoundary,
        );
      },
      markTailStabilized: (): void => {
        if (settled) return;
        tailStabilized = true;
      },
      commit: (): void => {
        if (settled) return;
        settled = true;
        if (!leaseIsCurrent()) {
          releaseLease();
          return;
        }
        if (activated) state.active?.delete(activationToken);
        const recoversRejectedGeneration = state.rejectedThrough !== undefined
          && activeRecoveryBoundary(lineage, state) !== undefined;
        if (recoversRejectedGeneration) {
          // A successful rebuild proved the prior durable lineage wrong, so a
          // lower or same-height replacement is intentional rather than lag.
          this.#callbacks.onProjectionInvalidated(scope);
          state.committed = horizon;
          delete state.rejectedThrough;
          delete state.rejectedDurableThroughTokens;
          delete state.recoveryBoundaries;
        } else if (activated && !checkpointRejected) {
          const committed = state.committed;
          if (committed === undefined
            || horizon.number > committed.number
            || (horizon.number === committed.number && horizon.hash !== committed.hash)) {
            state.committed = horizon;
          }
        } else if (tailStabilized && !checkpointRejected && state.rejectedThrough === undefined) {
          // A reorg confined to the unpersisted tail leaves the durable
          // checkpoint valid, so no rejection can discharge the old hash. A
          // view that stabilized its replacement tail at that same height may
          // replace it; a lower view is still lag and never moves the floor.
          const committed = state.committed;
          if (committed !== undefined
            && horizon.number === committed.number
            && horizon.hash !== committed.hash) {
            state.committed = horizon;
          }
        }
        if (state.active?.size === 0) delete state.active;
        releaseLease();
      },
      rollback: (): void => {
        if (settled) return;
        settled = true;
        if (!leaseIsCurrent()) {
          releaseLease();
          return;
        }
        if (activated) state.active?.delete(activationToken);
        if (state.active?.size === 0) delete state.active;
        releaseLease();
      },
    });
  }

  admits(
    scope: string,
    finalized: Readonly<{ number: number; hash: string }>,
  ): boolean {
    return this.#finalizedAtOrAbove(finalized, this.#constraint(this.#scopes.get(scope)));
  }

  assertAtOrAbove(
    scope: string,
    finalized: Readonly<{ number: number; hash: string }>,
  ): void {
    const constraint = this.#constraint(this.#scopes.get(scope));
    if (constraint === undefined || this.#finalizedAtOrAbove(finalized, constraint)) return;
    throw new ContextGraphAuthorityIndexRetryableError(
      `Context Graph authority projection anchor ${finalized.number}:${finalized.hash} `
      + `is behind durable refresh horizon ${constraint.number}:`
      + `${constraint.rejectAtNumber
        ? '<checkpoint-rejected>'
        : [...constraint.hashes].join(',')}`,
      'refresh-horizon-ahead',
    );
  }

  /** Hub/contract rotation or adapter teardown invalidates every open lease. */
  clear(): void {
    this.#epoch += 1;
    this.#scopes.clear();
  }

  #scopeState(scope: string): ContextGraphAuthorityHorizonScopeState {
    let state = this.#scopes.get(scope);
    if (state === undefined) {
      state = { unsettledLeases: 0, rejectionRevision: 0 };
      this.#scopes.set(scope, state);
    }
    return state;
  }

  #constraint(
    state: ContextGraphAuthorityHorizonScopeState | undefined,
  ): ContextGraphAuthorityRefreshHorizonConstraint | undefined {
    if (state === undefined) return undefined;
    let number = -1;
    const hashes = new Set<string>();
    const include = (horizon: ContextGraphAuthorityIndexRefreshHorizon | undefined): void => {
      if (horizon === undefined || horizon.number < number) return;
      if (horizon.number > number) {
        number = horizon.number;
        hashes.clear();
      }
      hashes.add(horizon.hash);
    };
    include(state.committed);
    for (const horizon of state.active?.values() ?? []) include(horizon);
    const rejectedThrough = state.rejectedThrough ?? -1;
    const rejectAtNumber = rejectedThrough >= number;
    if (rejectedThrough > number) {
      number = rejectedThrough;
      hashes.clear();
    }
    return number < 0 ? undefined : Object.freeze({ number, hashes, rejectAtNumber });
  }

  #sameConstraint(
    left: ContextGraphAuthorityRefreshHorizonConstraint | undefined,
    right: ContextGraphAuthorityRefreshHorizonConstraint | undefined,
  ): boolean {
    if (left === undefined || right === undefined) return left === right;
    if (left.number !== right.number
      || left.rejectAtNumber !== right.rejectAtNumber
      || left.hashes.size !== right.hashes.size) return false;
    for (const hash of left.hashes) if (!right.hashes.has(hash)) return false;
    return true;
  }

  #finalizedAtOrAbove(
    finalized: Readonly<{ number: number; hash: string }>,
    constraint: ContextGraphAuthorityRefreshHorizonConstraint | undefined,
  ): boolean {
    if (constraint === undefined) return true;
    const finalizedHash = normalizeHash(finalized.hash);
    if (!Number.isSafeInteger(finalized.number)
      || finalized.number < 0
      || finalizedHash === undefined) return false;
    if (finalized.number > constraint.number) return true;
    return finalized.number === constraint.number
      && !constraint.rejectAtNumber
      && constraint.hashes.size === 1
      && constraint.hashes.has(finalizedHash);
  }

  #deleteScopeIfIdle(
    scope: string,
    state: ContextGraphAuthorityHorizonScopeState,
  ): void {
    if (state.unsettledLeases === 0
      && state.committed === undefined
      && state.active === undefined
      && state.rejectedThrough === undefined
      && state.rejectedDurableThroughTokens === undefined
      && state.recoveryBoundaries === undefined
      && this.#scopes.get(scope) === state) {
      this.#scopes.delete(scope);
    }
  }
}
