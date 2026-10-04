// SPDX-License-Identifier: Apache-2.0

/** Bounded catalog targets, overflow evidence and operational row projections. */
import { type Digest32V1 } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 } from './catalog-limits-v1.js';
import { rfc64CatalogTargetScopeKeyV1, type Rfc64OperationalAppliedHeadV1 } from './catalog-operational-applied-heads-v1.js';
import type { Rfc64PublicCatalogReceiverCompletionOutcomeV1 } from './public-catalog-reconciliation-outcome-v1.js';
import { type Rfc64PublicCatalogHeadAnnouncementV1 } from './public-catalog-transport-v1.js';

export const RFC64_CATALOG_TARGET_MAX_ENTRIES_V1 = 1_024;

export const RFC64_CATALOG_TARGET_MAX_CONTEXT_OVERFLOWS_V1 = 64;

interface Rfc64CatalogTrackedTargetV1 {
  announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  terminalFailure: boolean;
}

interface Rfc64CatalogTargetOverflowV1 {
  active: number;
  readonly failureWitnesses: Map<string, Rfc64PublicCatalogHeadAnnouncementV1>;
  /** CG-owned saturation can be released only when that authority generation resets. */
  readonly saturatedContextGraphs: Set<string>;
  /** Lost attribution is fail-closed until the whole tracker reaches a reset boundary. */
  unattributedSaturation: boolean;
}

interface Rfc64CatalogTargetContextEpochV1 {
  valid: boolean;
  activeLeases: number;
}

interface Rfc64CatalogTargetLeaseStateV1 {
  active: boolean;
  readonly contextEpoch: Rfc64CatalogTargetContextEpochV1;
  readonly overflow: Rfc64CatalogTargetOverflowV1 | null;
}

export type Rfc64CatalogTargetLeaseV1 = Readonly<{
  announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  disposition: 'tracked' | 'covered' | 'context-capacity' | 'global-capacity';
  /** Opaque exactly-once settlement state owned by the tracker. */
  state: Rfc64CatalogTargetLeaseStateV1;
}>;

/** Process-local, bounded operational targets; semantic truth remains the durable inventory. */
export class Rfc64CatalogTargetTrackerV1 {
  readonly #byContextGraph =
    new Map<string, Map<string, Rfc64CatalogTrackedTargetV1>>();
  readonly #contextGraphOverflows = new Map<string, Rfc64CatalogTargetOverflowV1>();
  readonly #contextEpochs = new Map<string, Rfc64CatalogTargetContextEpochV1>();
  #globalOverflow: Rfc64CatalogTargetOverflowV1 | null = null;
  #size = 0;

  get size(): number {
    return this.#size;
  }

  targetsForContextGraph(
    contextGraphId: string,
  ): readonly Rfc64PublicCatalogHeadAnnouncementV1[] {
    return Object.freeze(
      [...this.#byContextGraph.get(contextGraphId)?.values() ?? []]
        .map(({ announcement }) => announcement),
    );
  }

  hasTerminalFailure(announcement: Rfc64PublicCatalogHeadAnnouncementV1): boolean {
    const entry = this.#byContextGraph
      .get(announcement.contextGraphId)
      ?.get(rfc64CatalogTargetScopeKeyV1(announcement));
    return entry !== undefined
      && rfc64CatalogTargetExactIdentityV1(entry.announcement, announcement)
      && entry.terminalFailure;
  }

  capacityExceededForContextGraph(contextGraphId: string): boolean {
    return this.#globalOverflow !== null
      || this.#contextGraphOverflows.has(contextGraphId);
  }

  /** Invalidate every outstanding lease and release all process-local target evidence. */
  resetAll(): void {
    for (const contextEpoch of this.#contextEpochs.values()) contextEpoch.valid = false;
    this.#contextEpochs.clear();
    this.#byContextGraph.clear();
    this.#contextGraphOverflows.clear();
    this.#globalOverflow = null;
    this.#size = 0;
  }

  clearContextGraph(contextGraphId: string): number {
    const byScope = this.#byContextGraph.get(contextGraphId);
    const contextEpoch = this.#contextEpochs.get(contextGraphId);
    if (contextEpoch !== undefined) {
      contextEpoch.valid = false;
      this.#contextEpochs.delete(contextGraphId);
    }
    this.#contextGraphOverflows.delete(contextGraphId);
    if (this.#globalOverflow !== null) {
      for (const [identity, witness] of this.#globalOverflow.failureWitnesses) {
        if (witness.contextGraphId === contextGraphId) {
          this.#globalOverflow.failureWitnesses.delete(identity);
        }
      }
      this.#globalOverflow.saturatedContextGraphs.delete(contextGraphId);
      this.#finishOverflowIfResolved(this.#globalOverflow, null);
    }
    if (byScope !== undefined) {
      this.#byContextGraph.delete(contextGraphId);
      this.#size -= byScope.size;
    }
    this.#promoteOverflowWitnesses();
    return byScope?.size ?? 0;
  }

  begin(announcement: Rfc64PublicCatalogHeadAnnouncementV1): Rfc64CatalogTargetLeaseV1 {
    const existingByScope = this.#byContextGraph.get(announcement.contextGraphId);
    const key = rfc64CatalogTargetScopeKeyV1(announcement);
    const previous = existingByScope?.get(key);
    let contextEpoch = this.#contextEpochs.get(announcement.contextGraphId);
    if (contextEpoch === undefined) {
      contextEpoch = { valid: true, activeLeases: 0 };
      this.#contextEpochs.set(announcement.contextGraphId, contextEpoch);
    }
    contextEpoch.activeLeases += 1;
    const lease = (
      disposition: Rfc64CatalogTargetLeaseV1['disposition'],
      overflow: Rfc64CatalogTargetOverflowV1 | null = null,
    ) => Object.freeze({
      announcement,
      disposition,
      state: { active: true, contextEpoch, overflow },
    });
    if (
      previous !== undefined
      && BigInt(announcement.catalogVersion)
        < BigInt(previous.announcement.catalogVersion)
    ) return lease('covered');
    if (
      previous === undefined
      && (existingByScope?.size ?? 0)
        >= RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1
    ) {
      const overflow = this.#beginContextGraphOverflow(announcement.contextGraphId);
      return lease(overflow.disposition, overflow.overflow);
    }
    if (previous === undefined && this.#size >= RFC64_CATALOG_TARGET_MAX_ENTRIES_V1) {
      this.#globalOverflow ??= this.#createOverflow();
      this.#globalOverflow.active += 1;
      return lease('global-capacity', this.#globalOverflow);
    }
    let byScope = existingByScope;
    if (byScope === undefined) {
      byScope = new Map();
      this.#byContextGraph.set(announcement.contextGraphId, byScope);
    }
    byScope.set(key, { announcement, terminalFailure: false });
    if (previous === undefined) this.#size += 1;
    return lease('tracked');
  }

  reject(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): Rfc64CatalogTargetLeaseV1 {
    const lease = this.begin(announcement);
    this.settle(lease, 'dropped');
    return lease;
  }

  settle(
    lease: Rfc64CatalogTargetLeaseV1,
    outcome: Rfc64PublicCatalogReceiverCompletionOutcomeV1,
  ): void {
    if (!lease.state.active) return;
    lease.state.active = false;
    const { contextEpoch } = lease.state;
    contextEpoch.activeLeases = Math.max(0, contextEpoch.activeLeases - 1);
    if (
      contextEpoch.activeLeases === 0
      && this.#contextEpochs.get(lease.announcement.contextGraphId) === contextEpoch
    ) this.#contextEpochs.delete(lease.announcement.contextGraphId);
    const overflow = lease.state.overflow;
    if (!contextEpoch.valid) {
      if (overflow !== null) {
        overflow.active = Math.max(0, overflow.active - 1);
        if (this.#globalOverflow === overflow) {
          this.#finishOverflowIfResolved(overflow, null);
        }
      }
      return;
    }
    const resolved = outcome === 'already-applied'
      || outcome === 'applied'
      || outcome === 'closed'
      || outcome === 'staged-only';
    if (lease.disposition === 'tracked') {
      if (resolved) this.retire(lease.announcement);
      else this.#markTerminalFailure(lease.announcement);
      return;
    }
    if (lease.disposition === 'covered') return;
    if (
      overflow === null
      || (
        lease.disposition === 'context-capacity'
          ? this.#contextGraphOverflows.get(lease.announcement.contextGraphId) !== overflow
          : this.#globalOverflow !== overflow
      )
    ) return;
    overflow.active = Math.max(0, overflow.active - 1);
    const exactIdentity = rfc64CatalogTargetExactIdentityKeyV1(lease.announcement);
    if (resolved) {
      overflow.failureWitnesses.delete(exactIdentity);
    } else if (!overflow.failureWitnesses.has(exactIdentity)) {
      if (
        overflow.failureWitnesses.size
          >= RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1
      ) this.#markOverflowSaturated(overflow, lease.announcement.contextGraphId);
      else overflow.failureWitnesses.set(exactIdentity, lease.announcement);
    }
    this.#finishOverflowIfResolved(
      overflow,
      lease.disposition === 'context-capacity'
        ? lease.announcement.contextGraphId
        : null,
    );
  }

  retire(announcement: Rfc64PublicCatalogHeadAnnouncementV1): boolean {
    const byScope = this.#byContextGraph.get(announcement.contextGraphId);
    const key = rfc64CatalogTargetScopeKeyV1(announcement);
    const current = byScope?.get(key);
    let retired = false;
    if (
      current !== undefined
      && rfc64CatalogTargetExactIdentityV1(current.announcement, announcement)
    ) {
      byScope!.delete(key);
      this.#size -= 1;
      if (byScope!.size === 0) this.#byContextGraph.delete(announcement.contextGraphId);
      retired = true;
    }
    const exactIdentity = rfc64CatalogTargetExactIdentityKeyV1(announcement);
    const contextOverflow = this.#contextGraphOverflows.get(announcement.contextGraphId);
    if (contextOverflow?.failureWitnesses.delete(exactIdentity) === true) {
      this.#finishOverflowIfResolved(contextOverflow, announcement.contextGraphId);
      retired = true;
    }
    if (this.#globalOverflow?.failureWitnesses.delete(exactIdentity) === true) {
      this.#finishOverflowIfResolved(this.#globalOverflow, null);
      retired = true;
    }
    this.#promoteOverflowWitnesses();
    return retired;
  }

  #markTerminalFailure(announcement: Rfc64PublicCatalogHeadAnnouncementV1): void {
    const entry = this.#byContextGraph
      .get(announcement.contextGraphId)
      ?.get(rfc64CatalogTargetScopeKeyV1(announcement));
    if (
      entry !== undefined
      && rfc64CatalogTargetExactIdentityV1(entry.announcement, announcement)
    ) entry.terminalFailure = true;
  }

  #beginContextGraphOverflow(
    contextGraphId: string,
  ): Readonly<{
    disposition: 'context-capacity' | 'global-capacity';
    overflow: Rfc64CatalogTargetOverflowV1;
  }> {
    let overflow = this.#contextGraphOverflows.get(contextGraphId);
    if (overflow === undefined) {
      if (
        this.#contextGraphOverflows.size
          >= RFC64_CATALOG_TARGET_MAX_CONTEXT_OVERFLOWS_V1
      ) {
        this.#globalOverflow ??= this.#createOverflow();
        this.#globalOverflow.active += 1;
        return Object.freeze({
          disposition: 'global-capacity',
          overflow: this.#globalOverflow,
        });
      }
      overflow = this.#createOverflow();
      this.#contextGraphOverflows.set(contextGraphId, overflow);
    }
    overflow.active += 1;
    return Object.freeze({ disposition: 'context-capacity', overflow });
  }

  #createOverflow(): Rfc64CatalogTargetOverflowV1 {
    return {
      active: 0,
      failureWitnesses: new Map(),
      saturatedContextGraphs: new Set(),
      unattributedSaturation: false,
    };
  }

  #markOverflowSaturated(
    overflow: Rfc64CatalogTargetOverflowV1,
    contextGraphId: string,
  ): void {
    if (overflow.saturatedContextGraphs.has(contextGraphId)) return;
    if (
      overflow.saturatedContextGraphs.size
        >= RFC64_CATALOG_TARGET_MAX_CONTEXT_OVERFLOWS_V1
    ) {
      overflow.unattributedSaturation = true;
      return;
    }
    overflow.saturatedContextGraphs.add(contextGraphId);
  }

  #finishOverflowIfResolved(
    overflow: Rfc64CatalogTargetOverflowV1,
    contextGraphId: string | null,
  ): void {
    if (overflow.active > 0) return;
    if (
      overflow.failureWitnesses.size === 0
      && overflow.saturatedContextGraphs.size === 0
      && !overflow.unattributedSaturation
    ) {
      if (contextGraphId === null) this.#globalOverflow = null;
      else this.#contextGraphOverflows.delete(contextGraphId);
      return;
    }
    this.#promoteOverflowWitness(contextGraphId, overflow);
  }

  #promoteOverflowWitnesses(): void {
    for (const [contextGraphId, overflow] of this.#contextGraphOverflows) {
      this.#promoteOverflowWitness(contextGraphId, overflow);
    }
    if (this.#globalOverflow !== null) this.#promoteOverflowWitness(null, this.#globalOverflow);
  }

  #promoteOverflowWitness(
    contextGraphId: string | null,
    overflow: Rfc64CatalogTargetOverflowV1,
  ): void {
    if (overflow.active > 0) return;
    for (const [identity, witness] of overflow.failureWitnesses) {
      const byScope = this.#byContextGraph.get(witness.contextGraphId);
      const key = rfc64CatalogTargetScopeKeyV1(witness);
      const current = byScope?.get(key);
      if (current !== undefined) {
        if (BigInt(current.announcement.catalogVersion) > BigInt(witness.catalogVersion)) {
          overflow.failureWitnesses.delete(identity);
          continue;
        }
        current.announcement = witness;
        current.terminalFailure = true;
        overflow.failureWitnesses.delete(identity);
        continue;
      }
      if (
        (byScope?.size ?? 0) >= RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1
        || this.#size >= RFC64_CATALOG_TARGET_MAX_ENTRIES_V1
      ) continue;
      const targetByScope = byScope ?? new Map<string, Rfc64CatalogTrackedTargetV1>();
      if (byScope === undefined) this.#byContextGraph.set(witness.contextGraphId, targetByScope);
      targetByScope.set(key, { announcement: witness, terminalFailure: true });
      this.#size += 1;
      overflow.failureWitnesses.delete(identity);
    }
    if (
      overflow.failureWitnesses.size === 0
      && overflow.saturatedContextGraphs.size === 0
      && !overflow.unattributedSaturation
    ) {
      if (contextGraphId === null && this.#globalOverflow === overflow) {
        this.#globalOverflow = null;
      } else if (
        contextGraphId !== null
        && this.#contextGraphOverflows.get(contextGraphId) === overflow
      ) this.#contextGraphOverflows.delete(contextGraphId);
    }
  }
}

function rfc64CatalogTargetExactIdentityV1(
  left: Rfc64PublicCatalogHeadAnnouncementV1,
  right: Rfc64PublicCatalogHeadAnnouncementV1,
): boolean {
  return rfc64CatalogTargetExactIdentityKeyV1(left)
    === rfc64CatalogTargetExactIdentityKeyV1(right);
}

export function rfc64CatalogTargetExactIdentityKeyV1(
  target: Rfc64PublicCatalogHeadAnnouncementV1,
): string {
  return [
    rfc64CatalogTargetScopeKeyV1(target),
    target.catalogVersion,
    target.policyDigest,
    target.catalogHeadObjectDigest,
    target.signatureVariantDigest,
  ].join('\0');
}

export function aggregateRfc64DigestV1(values: readonly string[]): Digest32V1 | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort();
  if (sorted.length === 1) return sorted[0] as Digest32V1;
  return ethers.keccak256(ethers.toUtf8Bytes(sorted.join('\n'))) as Digest32V1;
}

export function sumDecimalCountsV1(values: readonly string[]): string {
  return values.reduce((sum, value) => sum + BigInt(value), 0n).toString(10);
}

interface Rfc64OperationalRowProjectionV1 {
  readonly expectedRowCount: string | null;
  readonly missingRowCount: string | null;
}

export function projectRfc64OperationalRowCountsV1(
  heads: readonly Readonly<Rfc64OperationalAppliedHeadV1>[],
  targets: readonly Rfc64PublicCatalogHeadAnnouncementV1[],
  promisedRowCounts: ReadonlyMap<string, string | null>,
): Readonly<Rfc64OperationalRowProjectionV1> {
  if (heads.length === 0 && targets.length === 0) {
    return Object.freeze({ expectedRowCount: null, missingRowCount: null });
  }
  const appliedByScope = new Map(heads.map((head) => [head.scopeKey, head]));
  const expectedByScope = new Map(heads.map(({ scopeKey, snapshot }) => [scopeKey, {
    catalogVersion: snapshot.catalogVersion,
    catalogHeadObjectDigest: snapshot.currentCatalogHeadDigest,
    rowCount: snapshot.inventoryRowCount as string | null,
    target: null as Rfc64PublicCatalogHeadAnnouncementV1 | null,
  }]));
  // A fork is a property of the newest version in a scope, not of the order
  // the targets arrive in: `authoritativeTargets` preserves insertion order and
  // the promised half arrives in peer-completion order, so deciding as the loop
  // walks would let the same state report an ambiguous pair or a definite one
  // depending on which peer answered first. The scope's maximum version is
  // resolved first, and only a digest disagreement AT that maximum is ambiguous
  // -- a strictly newer head settles the branch the older fork was on.
  const ambiguousScopes = new Set<string>();
  for (const target of targets) {
    const scopeKey = rfc64CatalogTargetScopeKeyV1(target);
    const current = expectedByScope.get(scopeKey);
    const targetVersion = BigInt(target.catalogVersion);
    if (current === undefined || targetVersion > BigInt(current.catalogVersion)) {
      expectedByScope.set(scopeKey, {
        catalogVersion: target.catalogVersion,
        catalogHeadObjectDigest: target.catalogHeadObjectDigest,
        rowCount: null,
        target,
      });
      ambiguousScopes.delete(scopeKey);
    } else if (
      targetVersion === BigInt(current.catalogVersion)
      && target.catalogHeadObjectDigest !== current.catalogHeadObjectDigest
    ) {
      ambiguousScopes.add(scopeKey);
    }
  }
  if (ambiguousScopes.size > 0) {
    return Object.freeze({ expectedRowCount: null, missingRowCount: null });
  }

  let expected = 0n;
  let missing = 0n;
  for (const [scopeKey, projected] of expectedByScope) {
    const targetRowCount = projected.target === null
      ? projected.rowCount
      : promisedRowCounts.get(
          rfc64CatalogTargetExactIdentityKeyV1(projected.target),
        ) ?? null;
    if (targetRowCount === null) {
      return Object.freeze({ expectedRowCount: null, missingRowCount: null });
    }
    const expectedForScope = BigInt(targetRowCount);
    const appliedForScope = BigInt(
      appliedByScope.get(scopeKey)?.snapshot.inventoryRowCount ?? '0',
    );
    expected += expectedForScope;
    if (expectedForScope > appliedForScope) missing += expectedForScope - appliedForScope;
  }
  return Object.freeze({
    expectedRowCount: expected.toString(10),
    missingRowCount: missing.toString(10),
  });
}
