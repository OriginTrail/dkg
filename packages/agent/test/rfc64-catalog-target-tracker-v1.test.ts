import {
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';
import { describe, expect, it } from 'vitest';

import {
  RFC64_CATALOG_TARGET_MAX_CONTEXT_OVERFLOWS_V1,
  RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1,
  RFC64_CATALOG_TARGET_MAX_ENTRIES_V1,
  Rfc64CatalogTargetTrackerV1,
} from '../src/dkg-agent-rfc64-catalog.js';
import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from '../src/rfc64/public-catalog-transport-v1.js';

const NETWORK_ID = 'otp:20430' as NetworkIdV1;

function catalogOperationalTarget(
  contextGraphIndex: number,
  authorIndex: number,
  digestIndex: number,
  catalogVersion = '0',
): Rfc64PublicCatalogHeadAnnouncementV1 {
  const digest = (offset: number) => (
    `0x${(digestIndex + offset).toString(16).padStart(64, '0')}` as Digest32V1
  );
  const contextGraphId = (
    `0x1111111111111111111111111111111111111111/target-${contextGraphIndex}`
  ) as ContextGraphIdV1;
  const authorAddress = (
    `0x${(authorIndex + 1).toString(16).padStart(40, '0')}`
  ) as EvmAddressV1;
  return Object.freeze({
    kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
    networkId: NETWORK_ID,
    contextGraphId,
    subGraphName: null,
    authorAddress,
    catalogEra: '0',
    catalogVersion,
    policyDigest: `0x${'71'.repeat(32)}` as Digest32V1,
    catalogHeadObjectDigest: digest(1),
    signatureVariantDigest: digest(2),
  }) as Rfc64PublicCatalogHeadAnnouncementV1;
}

describe('Rfc64CatalogTargetTrackerV1', () => {
  it('bounds operational targets while preserving in-capacity updates and exact retirement', () => {
    const tracker = new Rfc64CatalogTargetTrackerV1();
    const firstTargets = Array.from(
      { length: RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 },
      (_, authorIndex) => catalogOperationalTarget(0, authorIndex, authorIndex * 3),
    );
    for (const target of firstTargets) {
      expect(tracker.begin(target).disposition).toBe('tracked');
    }
    expect(tracker.size).toBe(RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1);
    expect(tracker.targetsForContextGraph(firstTargets[0]!.contextGraphId)).toHaveLength(
      RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1,
    );
    const contextCapacityLease = tracker.begin(catalogOperationalTarget(
      0,
      RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1,
      RFC64_CATALOG_TARGET_MAX_ENTRIES_V1 * 4,
    ));
    expect(contextCapacityLease.disposition).toBe('context-capacity');
    expect(tracker.capacityExceededForContextGraph(firstTargets[0]!.contextGraphId)).toBe(true);
    tracker.settle(contextCapacityLease, 'applied');
    expect(tracker.capacityExceededForContextGraph(firstTargets[0]!.contextGraphId)).toBe(false);

    const newerFirst = Object.freeze({
      ...firstTargets[0]!,
      catalogVersion: '1',
      catalogHeadObjectDigest: `0x${'81'.repeat(32)}` as Digest32V1,
      signatureVariantDigest: `0x${'82'.repeat(32)}` as Digest32V1,
    });
    expect(tracker.begin(newerFirst).disposition).toBe('tracked');
    expect(tracker.size).toBe(RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1);

    for (
      let index = RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1;
      index < RFC64_CATALOG_TARGET_MAX_ENTRIES_V1;
      index += 1
    ) {
      expect(tracker.begin(catalogOperationalTarget(
        Math.floor(index / RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1),
        index % RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1,
        index * 3,
      )).disposition).toBe('tracked');
    }
    expect(tracker.size).toBe(RFC64_CATALOG_TARGET_MAX_ENTRIES_V1);
    const newestFirst = Object.freeze({
      ...newerFirst,
      catalogVersion: '2',
      catalogHeadObjectDigest: `0x${'83'.repeat(32)}` as Digest32V1,
      signatureVariantDigest: `0x${'84'.repeat(32)}` as Digest32V1,
    });
    expect(tracker.begin(newestFirst).disposition).toBe('tracked');
    expect(tracker.size).toBe(RFC64_CATALOG_TARGET_MAX_ENTRIES_V1);
    const overflow = catalogOperationalTarget(
      Math.ceil(
        RFC64_CATALOG_TARGET_MAX_ENTRIES_V1
          / RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1,
      ),
      0,
      RFC64_CATALOG_TARGET_MAX_ENTRIES_V1 * 5,
    );
    const globalCapacityLease = tracker.begin(overflow);
    expect(globalCapacityLease.disposition).toBe('global-capacity');
    expect(tracker.capacityExceededForContextGraph(overflow.contextGraphId)).toBe(true);
    tracker.settle(globalCapacityLease, 'applied');
    expect(tracker.capacityExceededForContextGraph(overflow.contextGraphId)).toBe(false);

    expect(tracker.retire(newerFirst)).toBe(false);
    expect(tracker.size).toBe(RFC64_CATALOG_TARGET_MAX_ENTRIES_V1);
    expect(tracker.targetsForContextGraph(newestFirst.contextGraphId)).toContainEqual(newestFirst);
    expect(tracker.retire(Object.freeze({
      ...newestFirst,
      policyDigest: `0x${'85'.repeat(32)}` as Digest32V1,
    }))).toBe(false);
    expect(tracker.retire(newestFirst)).toBe(true);
    const failedLease = tracker.begin(overflow);
    expect(failedLease.disposition).toBe('tracked');
    tracker.settle(failedLease, 'failed');
    expect(tracker.hasTerminalFailure(overflow)).toBe(true);
    expect(tracker.size).toBe(RFC64_CATALOG_TARGET_MAX_ENTRIES_V1);
    const retryLease = tracker.begin(overflow);
    expect(retryLease.disposition).toBe('tracked');
    expect(tracker.hasTerminalFailure(overflow)).toBe(false);
    tracker.settle(retryLease, 'applied');
    expect(tracker.clearContextGraph(firstTargets[0]!.contextGraphId)).toBe(
      RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 - 1,
    );
    expect(tracker.targetsForContextGraph(firstTargets[0]!.contextGraphId)).toEqual([]);
    expect(tracker.size).toBe(
      RFC64_CATALOG_TARGET_MAX_ENTRIES_V1
        - RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1,
    );
    expect(tracker.clearContextGraph(firstTargets[0]!.contextGraphId)).toBe(0);
    expect(tracker.capacityExceededForContextGraph('unrelated-context-graph')).toBe(false);
  });

  it('retains every bounded overflow failure and ignores stale authority-epoch leases', () => {
    const tracker = new Rfc64CatalogTargetTrackerV1();
    const retained = Array.from(
      { length: RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 },
      (_, authorIndex) => catalogOperationalTarget(0, authorIndex, 100_000 + authorIndex * 3),
    );
    for (const target of retained) tracker.begin(target);
    const firstOverflow = catalogOperationalTarget(0, 100, 200_000);
    const secondOverflow = catalogOperationalTarget(0, 101, 300_000);
    const firstLease = tracker.begin(firstOverflow);
    const secondLease = tracker.begin(secondOverflow);
    expect(firstLease.disposition).toBe('context-capacity');
    expect(secondLease.disposition).toBe('context-capacity');
    tracker.settle(firstLease, 'failed');
    tracker.settle(secondLease, 'not-found');
    expect(tracker.capacityExceededForContextGraph(firstOverflow.contextGraphId)).toBe(true);

    expect(tracker.retire(retained[0]!)).toBe(true);
    expect(tracker.hasTerminalFailure(firstOverflow)).toBe(true);
    expect(tracker.capacityExceededForContextGraph(firstOverflow.contextGraphId)).toBe(true);
    const firstRetry = tracker.begin(firstOverflow);
    expect(firstRetry.disposition).toBe('tracked');
    expect(tracker.hasTerminalFailure(firstOverflow)).toBe(false);
    tracker.settle(firstRetry, 'applied');
    expect(tracker.hasTerminalFailure(secondOverflow)).toBe(true);
    expect(tracker.capacityExceededForContextGraph(secondOverflow.contextGraphId)).toBe(false);
    const secondRetry = tracker.begin(secondOverflow);
    tracker.settle(secondRetry, 'applied');
    expect(tracker.hasTerminalFailure(secondOverflow)).toBe(false);

    const staleTracker = new Rfc64CatalogTargetTrackerV1();
    for (const target of retained) staleTracker.begin(target);
    const staleLease = staleTracker.begin(firstOverflow);
    staleTracker.clearContextGraph(firstOverflow.contextGraphId);
    for (const target of retained) staleTracker.begin(Object.freeze({
      ...target,
      policyDigest: `0x${'92'.repeat(32)}` as Digest32V1,
    }));
    const currentLease = staleTracker.begin(Object.freeze({
      ...secondOverflow,
      policyDigest: `0x${'92'.repeat(32)}` as Digest32V1,
    }));
    expect(currentLease.disposition).toBe('context-capacity');
    staleTracker.settle(staleLease, 'failed');
    expect(staleTracker.capacityExceededForContextGraph(secondOverflow.contextGraphId)).toBe(true);
    staleTracker.settle(currentLease, 'applied');
    expect(staleTracker.capacityExceededForContextGraph(secondOverflow.contextGraphId)).toBe(false);
  });

  it('clears attributable global saturation with its authority generation', () => {
    const tracker = new Rfc64CatalogTargetTrackerV1();
    for (let index = 0; index < RFC64_CATALOG_TARGET_MAX_ENTRIES_V1; index += 1) {
      expect(tracker.begin(catalogOperationalTarget(
        Math.floor(index / RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1),
        index % RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1,
        400_000 + index * 3,
      )).disposition).toBe('tracked');
    }

    const overflowTargets = Array.from(
      { length: RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 + 1 },
      (_, index) => catalogOperationalTarget(1_000, 1_000 + index, 500_000 + index * 3),
    );
    for (const target of overflowTargets) {
      const lease = tracker.begin(target);
      expect(lease.disposition).toBe('global-capacity');
      tracker.settle(lease, 'failed');
    }

    expect(tracker.capacityExceededForContextGraph('unrelated-context-graph')).toBe(true);
    tracker.clearContextGraph(overflowTargets[0]!.contextGraphId);
    expect(tracker.capacityExceededForContextGraph('unrelated-context-graph')).toBe(false);
  });

  it('bounds per-context overflows and resets only unrepresentable failures', () => {
    const tracker = new Rfc64CatalogTargetTrackerV1();
    const overflowLeases = [];
    for (
      let contextGraphIndex = 0;
      contextGraphIndex < RFC64_CATALOG_TARGET_MAX_CONTEXT_OVERFLOWS_V1;
      contextGraphIndex += 1
    ) {
      const retained = Array.from(
        { length: RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 },
        (_, authorIndex) => catalogOperationalTarget(
          contextGraphIndex,
          authorIndex,
          600_000 + contextGraphIndex * 1_000 + authorIndex * 3,
        ),
      );
      for (const target of retained) {
        expect(tracker.begin(target).disposition).toBe('tracked');
      }
      const overflowLease = tracker.begin(catalogOperationalTarget(
        contextGraphIndex,
        RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1,
        700_000 + contextGraphIndex * 1_000,
      ));
      expect(overflowLease.disposition).toBe('context-capacity');
      overflowLeases.push(overflowLease);
      for (const target of retained) expect(tracker.retire(target)).toBe(true);
    }

    const collapsedTarget = catalogOperationalTarget(
      RFC64_CATALOG_TARGET_MAX_CONTEXT_OVERFLOWS_V1,
      RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1,
      800_000,
    );
    const collapsedRetained = Array.from(
      { length: RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 },
      (_, authorIndex) => catalogOperationalTarget(
        RFC64_CATALOG_TARGET_MAX_CONTEXT_OVERFLOWS_V1,
        authorIndex,
        810_000 + authorIndex * 3,
      ),
    );
    for (const target of collapsedRetained) tracker.begin(target);
    const collapsedLease = tracker.begin(collapsedTarget);
    expect(collapsedLease.disposition).toBe('global-capacity');
    for (const target of collapsedRetained) tracker.retire(target);
    expect(tracker.capacityExceededForContextGraph('unrelated-context-graph')).toBe(true);
    tracker.settle(collapsedLease, 'applied');
    expect(tracker.size).toBe(0);
    expect(tracker.capacityExceededForContextGraph('unrelated-context-graph')).toBe(false);

    const terminalFailureContextGraphIds = [];
    const terminalFailureLeases = [];
    const terminalFailureCount =
      RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1
      + RFC64_CATALOG_TARGET_MAX_CONTEXT_OVERFLOWS_V1
      + 1;
    for (let failureIndex = 0; failureIndex < terminalFailureCount; failureIndex += 1) {
      const contextGraphIndex =
        RFC64_CATALOG_TARGET_MAX_CONTEXT_OVERFLOWS_V1 + 1 + failureIndex;
      const retained = Array.from(
        { length: RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1 },
        (_, authorIndex) => catalogOperationalTarget(
          contextGraphIndex,
          authorIndex,
          900_000 + failureIndex * 1_000 + authorIndex * 3,
        ),
      );
      for (const target of retained) tracker.begin(target);
      const failedTarget = catalogOperationalTarget(
        contextGraphIndex,
        RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1,
        950_000 + failureIndex * 1_000,
      );
      const failedLease = tracker.begin(failedTarget);
      expect(failedLease.disposition).toBe('global-capacity');
      for (const target of retained) tracker.retire(target);
      terminalFailureLeases.push(failedLease);
      terminalFailureContextGraphIds.push(failedTarget.contextGraphId);
    }

    for (let index = 0; index < RFC64_CATALOG_TARGET_MAX_ENTRIES_V1; index += 1) {
      expect(tracker.begin(catalogOperationalTarget(
        10_000 + Math.floor(
          index / RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1,
        ),
        index % RFC64_CATALOG_TARGET_MAX_ENTRIES_PER_CONTEXT_GRAPH_V1,
        2_000_000 + index * 3,
      )).disposition).toBe('tracked');
    }
    for (const failedLease of terminalFailureLeases) {
      tracker.settle(failedLease, 'failed');
    }

    expect(tracker.capacityExceededForContextGraph('unrelated-context-graph')).toBe(true);
    for (const contextGraphId of terminalFailureContextGraphIds) {
      tracker.clearContextGraph(contextGraphId);
    }
    expect(tracker.capacityExceededForContextGraph('unrelated-context-graph')).toBe(true);

    tracker.resetAll();
    expect(tracker.size).toBe(0);
    expect(tracker.capacityExceededForContextGraph('unrelated-context-graph')).toBe(false);
    tracker.settle(overflowLeases[0]!, 'failed');
    expect(tracker.capacityExceededForContextGraph('unrelated-context-graph')).toBe(false);
  });
});
