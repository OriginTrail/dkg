// SPDX-License-Identifier: Apache-2.0

import {
  computeAuthorCatalogScopeDigestV1,
  computeControlSignatureVariantDigestHex,
  computeSwmAuthorInventoryScopeDigestV1,
  createOperationContext,
  type Digest32V1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import {
  verifyControlEnvelopeIssuerSignatureV1,
  type ContextGraphAuthoritySnapshot,
} from '@origintrail-official/dkg-chain';

import {
  RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
  RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
  encodeRfc64PublicCatalogHeadReplayCompletionV2,
} from '../src/rfc64/public-catalog-transport-v1.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from
  '../src/rfc64/swm-inventory-shadow-runtime-v1.js';
import { ethers } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import type { DKGAgent } from '../src/index.js';
import {
  AUTHOR,
  AUTHOR_WALLET,
  CONTEXT_GRAPH_ID,
  NETWORK_ID,
  catalogScopeDigestV1,
  seedInventoryAssetV1,
  startRepairAgentV1,
} from './support/rfc64-local-catalog-repair-fixture.js';

const HUB = '0x3333333333333333333333333333333333333333';

/**
 * A first on-chain registration keeps `ownershipEra` at zero
 * (`ContextGraphCreated` in the chain authority generation reducer); only a
 * Transfer advances it. The governance tuple still flips from all-`null` to
 * real values, which is what changes the author lane scope digest.
 */
function finalizedAuthoritySnapshotV1(
  ownershipEra = '0',
  accessPolicy: 0 | 1 = 0,
): ContextGraphAuthoritySnapshot {
  return Object.freeze({
    chainId: '20430',
    governanceContract: HUB,
    contextGraphId: '9',
    owner: AUTHOR,
    active: true,
    accessPolicy,
    publishPolicy: 1,
    publishAuthority: null,
    publishAuthorityAccountId: '0',
    participantAgents: accessPolicy === 1 ? [AUTHOR] : [],
    nameHash: ethers.keccak256(ethers.toUtf8Bytes(CONTEXT_GRAPH_ID)).toLowerCase(),
    ownershipEra,
    policyVersion: '1',
    rosterVersion: ownershipEra,
    sourceBlockNumber: '42',
    sourceBlockHash: `0x${'44'.repeat(32)}`,
  }) as ContextGraphAuthoritySnapshot;
}

/** Catalog scope digest of whatever authority generation the author has accepted. */
function acceptedCatalogScopeDigestV1(agent: DKGAgent): Digest32V1 {
  const accepted = agent.readAcceptedRfc64CatalogAccessSnapshotV1(CONTEXT_GRAPH_ID);
  if (accepted === null) throw new Error('no accepted RFC-64 authority');
  return computeAuthorCatalogScopeDigestV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    governanceChainId: accepted.policy.governanceChainId,
    governanceContractAddress: accepted.policy.governanceContractAddress,
    ownershipTransitionDigest: accepted.policy.ownershipTransitionDigest,
    subGraphName: null,
    authorAddress: AUTHOR,
    era: accepted.policy.era,
    bucketCount: '1',
  });
}

function appliedCatalogHeadV1(agent: DKGAgent, catalogScopeDigest: Digest32V1) {
  return (agent as unknown as {
    rfc64PersistenceV1: {
      inventory: {
        readAppliedCatalogHeadV1: (
          digest: Digest32V1,
          author: typeof AUTHOR,
        ) => unknown | null;
      };
    };
  }).rfc64PersistenceV1.inventory.readAppliedCatalogHeadV1(catalogScopeDigest, AUTHOR);
}

async function startRotationAuthorV1(name: string): Promise<DKGAgent> {
  const author = await startRepairAgentV1({
    name,
    autoPublish: {
      peers: [],
      catalogIssuerDelegationExpiresAt: '1893456000000' as TimestampMsV1,
    },
    beforeStart: (agent) => {
      vi.spyOn(agent, 'listLocalAgents').mockReturnValue([
        { agentAddress: AUTHOR } as never,
      ]);
      vi.spyOn(agent, 'getCustodialAgentPrivateKey')
        .mockReturnValue(AUTHOR_WALLET.privateKey);
      vi.spyOn(agent, 'synchronizeRfc64CatalogRolloutFromProvidersV1')
        .mockResolvedValue(null);
    },
  });
  author.acceptOpenContextGraphPolicyV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    ownerAddress: AUTHOR,
  });
  author.subscribeToContextGraph(CONTEXT_GRAPH_ID);
  return author;
}

async function rotateToFinalizedChainV1(
  author: DKGAgent,
  ownershipEra = '0',
  accessPolicy: 0 | 1 = 0,
): Promise<void> {
  const registered = finalizedAuthoritySnapshotV1(ownershipEra, accessPolicy);
  author.recordDiscoveredContextGraph(CONTEXT_GRAPH_ID, {
    name: CONTEXT_GRAPH_ID,
    onChainId: registered.contextGraphId,
    onChainHash: registered.nameHash,
  });
  await expect(author.reconcileRfc64CatalogAccessAuthorityV1(
    CONTEXT_GRAPH_ID,
    undefined,
    {
      kind: 'finalized-evidence',
      evidence: {
        contextGraphAuthorityIndexId: registered.contextGraphId,
        batchTargetIds: [registered.contextGraphId],
        snapshot: registered,
      },
    },
  )).resolves.toMatchObject({ source: 'finalized-chain' });
  // The re-projection HANDS its durable row writes to the SWM inventory shadow
  // runtime rather than awaiting them on the acceptance path (it is reachable
  // from inside that runtime, so awaiting a per-asset turn there can deadlock).
  // Drain the runtime, then the supervisor it feeds.
  await author.awaitInFlightRfc64SwmInventoryObserversV1();
}

/** Collect every warning the agent emits, so a reported failure can be asserted on. */
function captureWarningsV1(agent: DKGAgent): string[] {
  const lines: string[] = [];
  vi.spyOn((agent as unknown as { log: { warn: (ctx: unknown, m: string) => void } }).log, 'warn')
    .mockImplementation((_ctx: unknown, message: string) => { lines.push(String(message)); });
  return lines;
}

/**
 * Every re-projection failure is REPORTED rather than thrown, because an escaping error here
 * would demote the graph's authority progress. That makes the warning the only evidence a
 * row was left behind, so each report path is asserted individually -- an unreported failure
 * would be indistinguishable from success.
 */
describe('RFC-64 catalog re-projection failure reporting', () => {
  const REPROJECTION_WARNING = /re-projection after an authority rotation did not complete/u;

  it('reports, and does not throw, when admission itself fails', async () => {
    const author = await startRotationAuthorV1('authority-rotation-admit-throws');
    vi.spyOn(author.localContextGraphProvenance, 'hasLocalCreate').mockReturnValue(true);
    const warnings = captureWarningsV1(author);
    vi.spyOn(author, 'listLocalAgents').mockImplementation(() => {
      throw new Error('local agent registry unavailable');
    });

    // The rotation itself must still succeed: authority acceptance may not be demoted by a
    // re-projection that could not even decide whether it had work to do.
    await rotateToFinalizedChainV1(author);

    expect(warnings.filter((line) => REPROJECTION_WARNING.test(line)
      && /local agent registry unavailable/u.test(line))).toHaveLength(1);
  }, 60_000);

  it('reports when the authoring lane cannot be resolved', async () => {
    const author = await startRotationAuthorV1('authority-rotation-lane-throws');
    vi.spyOn(author.localContextGraphProvenance, 'hasLocalCreate').mockReturnValue(true);
    await seedInventoryAssetV1(author, 'authority-rotation-lane-throws', 61n);
    await author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    });
    await rotateToFinalizedChainV1(author);

    const warnings = captureWarningsV1(author);
    vi.spyOn(author, 'resolveRfc64CatalogAuthoringLaneV1').mockImplementation(() => {
      throw new Error('authoring lane is unresolvable');
    });
    // Admission is synchronous and returns null here, so there is nothing to await.
    expect(author.beginRfc64CatalogReprojectionForAuthorityRotationV1(CONTEXT_GRAPH_ID))
      .toBeNull();
    expect(warnings.filter((line) => REPROJECTION_WARNING.test(line)
      && /authoring lane is unresolvable/u.test(line))).toHaveLength(1);
  }, 60_000);

  it('reports per author when carrying one author\'s rows fails', async () => {
    const author = await startRotationAuthorV1('authority-rotation-carry-throws');
    // Rotate as a replica so the rows stay stranded: once they have crossed,
    // admission converges and there is nothing left to carry.
    const hasLocalCreate = vi
      .spyOn(author.localContextGraphProvenance, 'hasLocalCreate')
      .mockReturnValue(false);
    await seedInventoryAssetV1(author, 'authority-rotation-carry-throws', 62n);
    await author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    });
    await rotateToFinalizedChainV1(author);
    hasLocalCreate.mockReturnValue(true);

    const warnings = captureWarningsV1(author);
    vi.spyOn(
      author as unknown as { carryRfc64AuthorInventoryIntoAcceptedGenerationV1: () => Promise<void> },
      'carryRfc64AuthorInventoryIntoAcceptedGenerationV1',
    ).mockRejectedValue(new Error('durable carry failed'));

    // One author failing must not abort the others, so the returned promise still resolves.
    await expect(author.beginRfc64CatalogReprojectionForAuthorityRotationV1(CONTEXT_GRAPH_ID))
      .resolves.toBeUndefined();
    expect(warnings.filter((line) => REPROJECTION_WARNING.test(line)
      && line.includes(AUTHOR) && /durable carry failed/u.test(line))).toHaveLength(1);
  }, 60_000);

  it('reports when the projection supervisor refuses the request', async () => {
    const author = await startRotationAuthorV1('authority-rotation-supervisor-refuses');
    // Rotate as a replica so the rows stay stranded: once they have crossed,
    // admission converges and there is nothing left to carry.
    const hasLocalCreate = vi
      .spyOn(author.localContextGraphProvenance, 'hasLocalCreate')
      .mockReturnValue(false);
    await seedInventoryAssetV1(author, 'authority-rotation-supervisor-refuses', 63n);
    await author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    });
    await rotateToFinalizedChainV1(author);
    hasLocalCreate.mockReturnValue(true);

    const warnings = captureWarningsV1(author);
    vi.spyOn(author, 'requestRfc64SwmCatalogProjectionV1').mockReturnValue(false);
    await author.beginRfc64CatalogReprojectionForAuthorityRotationV1(CONTEXT_GRAPH_ID);

    expect(warnings.filter((line) => REPROJECTION_WARNING.test(line)
      && /supervisor refused the request/u.test(line))).toHaveLength(1);
  }, 60_000);

  it('names a row that cannot cross into the accepted generation', async () => {
    const author = await startRotationAuthorV1('authority-rotation-row-dormant');
    vi.spyOn(author.localContextGraphProvenance, 'hasLocalCreate').mockReturnValue(true);
    await seedInventoryAssetV1(author, 'authority-rotation-row-dormant', 64n);
    await author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    });

    // Installed BEFORE the rotation so the carry sees rows it has not already moved.
    const warnings = captureWarningsV1(author);
    vi.spyOn(author, 'recordRfc64SwmAuthorInventoryShadowV1').mockResolvedValue({
      status: 'dormant',
      action: 'upsert',
      attempts: 1,
      headObjectDigest: null,
      error: null,
      dormantReason: 'policy-mismatch',
    });
    await rotateToFinalizedChainV1(author);

    // The row is named, so an operator can tell WHICH asset stayed behind.
    expect(warnings.filter((line) => /could not carry/u.test(line)
      && /policy-mismatch/u.test(line))).toHaveLength(1);
  }, 60_000);

  it('names every origin an already-aborted re-projection never attempted', async () => {
    const author = await startRotationAuthorV1('authority-rotation-abort-origins');
    // Rotate as a replica first, so nothing is carried and the rows stay
    // addressed by the superseded generation.
    const hasLocalCreate = vi
      .spyOn(author.localContextGraphProvenance, 'hasLocalCreate')
      .mockReturnValue(false);
    await seedInventoryAssetV1(author, 'authority-rotation-abort-origins', 66n);
    await author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    });
    await rotateToFinalizedChainV1(author);
    hasLocalCreate.mockReturnValue(true);

    const warnings = captureWarningsV1(author);
    await author.beginRfc64CatalogReprojectionForAuthorityRotationV1(
      CONTEXT_GRAPH_ID,
      createOperationContext('system'),
      AbortSignal.abort(),
    );

    // The in-carry abort was already named; this outer one returned silently,
    // so a signal already aborted on entry skipped EVERY origin with no log
    // line at all -- and the acceptance gate cannot re-fire in this process.
    expect(warnings.filter((line) => REPROJECTION_WARNING.test(line)
      && line.includes(AUTHOR)
      && /aborted before this author was attempted/u.test(line))).toHaveLength(1);
  }, 60_000);

  it('names an author whose carry aborted part-way through its rows', async () => {
    // The OUTER per-origin abort above is a different branch from the in-carry one: this
    // author WAS attempted, and some of its rows crossed. The acceptance gate does not
    // re-fire in this process, so a partially carried graph that reported nothing would be
    // indistinguishable from a complete one.
    const author = await startRotationAuthorV1('authority-rotation-abort-rows');
    const hasLocalCreate = vi
      .spyOn(author.localContextGraphProvenance, 'hasLocalCreate')
      .mockReturnValue(false);
    // Two rows, so the loop reaches a second iteration where the signal can be observed.
    await seedInventoryAssetV1(author, 'authority-rotation-abort-rows-a', 67n);
    await seedInventoryAssetV1(author, 'authority-rotation-abort-rows-b', 68n);
    await author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    });
    await rotateToFinalizedChainV1(author);
    hasLocalCreate.mockReturnValue(true);

    // The carry loop has no await between rows, so the abort has to come from inside it:
    // trip it on the first row's handoff to the shadow runtime, which is the real shape of
    // a shutdown or budget expiry landing mid-carry.
    const controller = new AbortController();
    const runtime = rfc64SwmInventoryShadowRuntimeV1(author);
    const schedule = vi.spyOn(runtime, 'schedule');
    schedule.mockImplementation((assetKey, work) => {
      controller.abort();
      schedule.mockRestore();
      return runtime.schedule(assetKey, work);
    });

    const warnings = captureWarningsV1(author);
    await author.beginRfc64CatalogReprojectionForAuthorityRotationV1(
      CONTEXT_GRAPH_ID,
      createOperationContext('system'),
      controller.signal,
    );
    await author.awaitInFlightRfc64SwmInventoryObserversV1();

    expect(warnings.filter((line) => REPROJECTION_WARNING.test(line)
      && line.includes(AUTHOR)
      && /aborted before every row crossed/u.test(line))).toHaveLength(1);
  }, 60_000);

  it('stays silent for a row a durable VM confirmation already retired', async () => {
    const author = await startRotationAuthorV1('authority-rotation-row-vm-confirmed');
    vi.spyOn(author.localContextGraphProvenance, 'hasLocalCreate').mockReturnValue(true);
    await seedInventoryAssetV1(author, 'authority-rotation-row-vm-confirmed', 65n);
    await author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    });

    const warnings = captureWarningsV1(author);
    vi.spyOn(author, 'recordRfc64SwmAuthorInventoryShadowV1').mockResolvedValue({
      status: 'dormant',
      action: 'upsert',
      attempts: 1,
      headObjectDigest: null,
      error: null,
      dormantReason: 'vm-confirmed',
    });
    await rotateToFinalizedChainV1(author);

    // The finalized lane owns this row deliberately. Warning about it would train operators
    // to ignore the one signal that means a row really was stranded.
    expect(warnings.filter((line) => /could not carry/u.test(line))).toHaveLength(0);
  }, 60_000);
});

describe('RFC-64 catalog re-projection on authority rotation', () => {
  it('makes a pre-rotation head reachable under the newly accepted scope', async () => {
    const author = await startRotationAuthorV1('authority-rotation-reprojection');
    // The graph's author of record is the only identity allowed to re-project.
    vi.spyOn(author.localContextGraphProvenance, 'hasLocalCreate').mockReturnValue(true);

    await seedInventoryAssetV1(author, 'authority-rotation', 41n);
    await expect(author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({ status: 'advanced', targetAssetCount: 1 });

    // The head published before the rotation lives under the unregistered
    // origin scope, which is what the replay manifest keeps advertising.
    const originScopeDigest = catalogScopeDigestV1();
    expect(acceptedCatalogScopeDigestV1(author)).toEqual(originScopeDigest);
    expect(appliedCatalogHeadV1(author, originScopeDigest)).not.toBeNull();

    await rotateToFinalizedChainV1(author);

    // The governance tuple now keys a different scope digest, so nothing the
    // author published before the rotation is addressable under it any more.
    const rotatedScopeDigest = acceptedCatalogScopeDigestV1(author);
    expect(rotatedScopeDigest).not.toEqual(originScopeDigest);

    await vi.waitFor(() => {
      expect(appliedCatalogHeadV1(author, rotatedScopeDigest)).toMatchObject({
        catalogScopeDigest: rotatedScopeDigest,
        authorAddress: AUTHOR,
        inventoryRowCount: '1',
      });
    }, { timeout: 20_000, interval: 25 });
  }, 60_000);

  it('re-projects idempotently when the same rotation is observed twice', async () => {
    const author = await startRotationAuthorV1('authority-rotation-idempotent');
    vi.spyOn(author.localContextGraphProvenance, 'hasLocalCreate').mockReturnValue(true);

    await seedInventoryAssetV1(author, 'authority-rotation-twice', 42n);
    await expect(author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({ status: 'advanced' });

    await rotateToFinalizedChainV1(author);
    const rotatedScopeDigest = acceptedCatalogScopeDigestV1(author);
    await vi.waitFor(() => {
      expect(appliedCatalogHeadV1(author, rotatedScopeDigest)).not.toBeNull();
    }, { timeout: 20_000, interval: 25 });
    const afterFirst = appliedCatalogHeadV1(author, rotatedScopeDigest);

    // Admission CONVERGES. Nothing retires the origin-scope rows, so comparing
    // scope digests alone stayed true for the life of a rotated graph and every
    // later acceptance -- every roster add/remove bumps the generation --
    // suspended the acceptance path for a carry already done. The accepted
    // generation now answers that question, and answers it no.
    expect(author.beginRfc64CatalogReprojectionForAuthorityRotationV1(CONTEXT_GRAPH_ID))
      .toBeNull();

    // The carry itself must still be re-entrant: forcing the rows through it a
    // second time may not fork or advance the lineage it already built.
    const lane = author.resolveRfc64CatalogAuthoringLaneV1(CONTEXT_GRAPH_ID, null);
    expect(lane).not.toBeNull();
    const originDigest = computeSwmAuthorInventoryScopeDigestV1({
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
      governanceChainId: null,
      governanceContractAddress: null,
      ownershipTransitionDigest: null,
      subGraphName: null,
      authorAddress: AUTHOR,
      era: '0',
    } as never);
    const originRows = (author as unknown as { rfc64PersistenceV1: any })
      .rfc64PersistenceV1.swmAuthorInventory
      .readSwmAuthorInventorySnapshotV1(originDigest, AUTHOR).rows;
    expect(originRows.length).toBeGreaterThan(0);
    await (author as unknown as {
      carryRfc64AuthorInventoryIntoAcceptedGenerationV1: (
        lane: unknown,
        params: unknown,
      ) => Promise<void>;
    }).carryRfc64AuthorInventoryIntoAcceptedGenerationV1(lane, {
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
      originDigest,
      rows: originRows,
      ctx: createOperationContext('system'),
    });
    await author.awaitInFlightRfc64SwmInventoryObserversV1();
    expect(appliedCatalogHeadV1(author, rotatedScopeDigest)).toEqual(afterFirst);
  }, 60_000);

  it('reports, rather than loops on, an era-advancing ownership transfer', async () => {
    const author = await startRotationAuthorV1('authority-rotation-transfer-era');
    vi.spyOn(author.localContextGraphProvenance, 'hasLocalCreate').mockReturnValue(true);
    const warn = vi.spyOn(author.log, 'warn');

    await seedInventoryAssetV1(author, 'authority-rotation-transfer', 44n);
    await expect(author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({ status: 'advanced' });

    // An ownership Transfer advances the era, and a non-zero era cannot open a
    // catalog lineage with a direct-author genesis delegation.
    await rotateToFinalizedChainV1(author, '1');
    const rotatedScopeDigest = acceptedCatalogScopeDigestV1(author);
    expect(rotatedScopeDigest).not.toEqual(catalogScopeDigestV1());
    expect(appliedCatalogHeadV1(author, rotatedScopeDigest)).toBeNull();
    expect(warn.mock.calls.some(([, message]) => (
      typeof message === 'string'
      && message.includes('transferred catalog bundle')
      && message.includes(CONTEXT_GRAPH_ID)
    ))).toBe(true);
  }, 60_000);

  /**
   * KNOWN GAP, deliberately pinned: re-projection alone leaves the author
   * holding two applied catalog heads for one lane. A first registration keeps
   * `ownershipEra` at zero and the V2 replay manifest's uniqueness key is
   * `(networkId, contextGraphId, subGraphName, authorAddress, catalogEra)` --
   * it carries no governance tuple -- so the pre-rotation and post-rotation
   * generations are indistinguishable on the wire and the manifest is refused.
   * Retiring the old head needs a supersede-in-place operation that drops only
   * the applied-head ref: the existing deactivation primitive also deletes the
   * catalog-owned semantic closure, whose location is derived without the
   * governance tuple or era and is therefore shared with the new generation.
   */
  it('serves only the accepted generation in the replay manifest after re-projection', async () => {
    const author = await startRotationAuthorV1('authority-rotation-manifest-collision');
    vi.spyOn(author.localContextGraphProvenance, 'hasLocalCreate').mockReturnValue(true);

    await seedInventoryAssetV1(author, 'authority-rotation-manifest', 45n);
    await expect(author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({ status: 'advanced' });

    await rotateToFinalizedChainV1(author);
    const rotatedScopeDigest = acceptedCatalogScopeDigestV1(author);
    await vi.waitFor(() => {
      expect(appliedCatalogHeadV1(author, rotatedScopeDigest)).not.toBeNull();
    }, { timeout: 20_000, interval: 25 });

    const persistence = (author as unknown as { rfc64PersistenceV1: any })
      .rfc64PersistenceV1;
    const applied = persistence.inventory.listAppliedCatalogHeadsV1()
      .filter((head: any) => head.authorAddress === AUTHOR);
    // The pre-rotation lineage is RETAINED on disk. Re-projection carries the rows forward; it
    // does not retire the old head, and retiring it with the existing row-removal primitive
    // would be unsafe because that planner is governance-blind and both scopes now resolve to
    // the same triples. Withholding it from the wire is the narrow fix.
    expect(applied).toHaveLength(2);
    expect(new Set(applied.map((head: any) => head.catalogScopeDigest)).size).toBe(2);

    // The replay index is keyed on `(networkId, contextGraphId)`, so it returns BOTH heads.
    // Only the accepted generation may be announced. No peer is reachable here, so the single
    // attempted head counts as one failure -- and the superseded head is not attempted at all.
    // Before the filter this was `failed: 2`.
    const service = (author as unknown as {
      rfc64PublicCatalogServiceV1: {
        announceCatalogHead: (input: any) => Promise<unknown>;
      };
    }).rfc64PublicCatalogServiceV1;
    const announceCatalogHead = vi.spyOn(service, 'announceCatalogHead');
    await expect(author.reannounceRfc64CatalogHeadsToPeerV1('12D3KooWRotationProbe'))
      .resolves.toMatchObject({ announced: 0, failed: 1 });

    const policyDigest = author
      .readAcceptedRfc64CatalogAccessSnapshotV1(CONTEXT_GRAPH_ID)?.policyDigest;
    const accepted = applied
      .filter((head: any) => head.catalogScopeDigest === rotatedScopeDigest);
    expect(accepted).toHaveLength(1);

    // IDENTITY, not count. `{announced: 0, failed: 1}` only proves that ONE of the two
    // stored heads was attempted: inverting the comparison in
    // `rfc64CatalogHeadIsSupersededGenerationV1` so the responder announces the SUPERSEDED
    // generation and withholds the accepted one leaves every count and every other
    // assertion in this test unchanged. Pin which head the responder actually reached for.
    expect(announceCatalogHead.mock.calls).toHaveLength(1);
    expect(announceCatalogHead.mock.calls[0]![0].announcement.catalogHeadObjectDigest)
      .toEqual(accepted[0].currentCatalogHeadDigest);
    announceCatalogHead.mockRestore();
    const announcements = await Promise.all(accepted.map(async (head: any) => {
      const stored = await persistence.controlObjects.getVerifiedObjectByDigest({
        objectDigest: head.currentCatalogHeadDigest,
        verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
      });
      const envelope = stored.envelope;
      return {
        kind: RFC64_PUBLIC_CATALOG_HEAD_ANNOUNCEMENT_KIND_V1,
        networkId: envelope.payload.networkId,
        contextGraphId: envelope.payload.contextGraphId,
        subGraphName: envelope.payload.subGraphName,
        authorAddress: envelope.payload.authorAddress,
        catalogEra: envelope.payload.era,
        catalogVersion: envelope.payload.version,
        policyDigest,
        catalogHeadObjectDigest: envelope.objectDigest,
        signatureVariantDigest: computeControlSignatureVariantDigestHex(
          envelope.objectDigest,
          envelope.signature,
        ),
      };
    }));
    // Both generations are era zero, so serving both would collapse them onto one manifest
    // uniqueness key and the encoder would refuse the WHOLE completion -- the peer would get
    // nothing, not even the current generation. With one entry it encodes.
    expect(() => encodeRfc64PublicCatalogHeadReplayCompletionV2({
      kind: RFC64_PUBLIC_CATALOG_HEAD_REPLAY_COMPLETION_KIND_V2,
      heads: announcements,
    } as never)).not.toThrow();
  }, 60_000);

  /**
   * The authority fence, which is the whole reason a grace window on the
   * previous generation's scope was rejected: registration may flip a public
   * graph to owner-only. Nothing may cross that flip.
   *
   * Two independent guards cover it, outermost first. Here the outer one trips:
   * the public-default authoring fallback goes inactive as soon as the accepted
   * policy reports `accessPolicy: 1`, so no row is even considered. On a CG
   * explicitly selected as private the lane stays active and the inner guard
   * takes over -- the carry runs through the ordinary shadow recorder, whose
   * durable workspace head still records `accessPolicy: 'public'`, and
   * `rfc64CatalogLaneAcceptsWorkspaceHeadV1` refuses each row as
   * `policy-mismatch`. That inner path is exercised by the recorder's own
   * tests, not re-proven here.
   */
  it('refuses to carry public rows across a registration that turns the graph private', async () => {
    const author = await startRotationAuthorV1('authority-rotation-access-flip');
    vi.spyOn(author.localContextGraphProvenance, 'hasLocalCreate').mockReturnValue(true);
    vi.spyOn(author, 'resolveRfc64VerifiedPrivateRosterV1' as never)
      .mockResolvedValue([AUTHOR] as never);
    vi.spyOn(author, 'readRfc64PrivateRosterVersionV1' as never)
      .mockResolvedValue('0' as never);
    const warn = vi.spyOn(author.log, 'warn');

    await seedInventoryAssetV1(author, 'authority-rotation-access-flip', 46n);
    await expect(author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({ status: 'advanced' });

    await rotateToFinalizedChainV1(author, '0', 1);
    expect(author.readAcceptedRfc64CatalogAccessPolicyV1(CONTEXT_GRAPH_ID)).toBe('private');

    // No public row crossed the fence into the now-private generation, and the
    // rows that stayed behind are reported instead of vanishing silently.
    const rotatedScopeDigest = acceptedCatalogScopeDigestV1(author);
    expect(rotatedScopeDigest).not.toEqual(catalogScopeDigestV1());
    expect(appliedCatalogHeadV1(author, rotatedScopeDigest)).toBeNull();
    expect(warn.mock.calls.some(([, message]) => (
      typeof message === 'string'
      && message.includes(CONTEXT_GRAPH_ID)
      && message.includes('the catalog authoring lane is inactive')
      && message.includes('stay unreachable')
    ))).toBe(true);
  }, 60_000);

  it('does not suspend acceptance for a graph that has not rotated', async () => {
    // Admission decided "is anything stranded" from the mere PRESENCE of
    // unregistered-origin rows, and left the generation comparison inside the
    // async carry. Until a graph is registered the accepted generation IS the
    // unregistered origin, so every locally-created, still-unregistered Context
    // Graph with at least one inventory row returned a promise and suspended the
    // acceptance path for a guaranteed no-op — on the FIRST acceptance in every
    // fresh process, which is exactly the ordering hazard the call site's own
    // comment says cannot happen.
    const author = await startRotationAuthorV1('authority-rotation-unrotated');
    vi.spyOn(author.localContextGraphProvenance, 'hasLocalCreate').mockReturnValue(true);

    await seedInventoryAssetV1(author, 'authority-rotation-unrotated', 47n);
    await expect(author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({ status: 'advanced' });

    // Rows exist under the unregistered origin, but no rotation has happened.
    // Admission must yield null so the acceptance path never suspends.
    expect(
      author.beginRfc64CatalogReprojectionForAuthorityRotationV1(CONTEXT_GRAPH_ID),
    ).toBeNull();
  }, 60_000);

  it('stays quiet on a replica, which can never re-project', async () => {
    // Only the AUTHOR re-projects (`hasLocalCreate`). On a replica the withheld-head warning
    // could never clear, so it would be exactly the permanent stream the conditional exists to
    // avoid — the actionable signal belongs on the node that can act on it.
    const replica = await startRotationAuthorV1('authority-rotation-replica-quiet');
    vi.spyOn(replica.localContextGraphProvenance, 'hasLocalCreate').mockReturnValue(false);
    const warn = vi.spyOn(replica.log, 'warn');

    await seedInventoryAssetV1(replica, 'authority-rotation-replica-quiet', 48n);
    await expect(replica.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({ status: 'advanced' });
    await rotateToFinalizedChainV1(replica);
    warn.mockClear();

    const debug = vi.spyOn(replica.log, 'debug');

    // No `.catch()`: an absence-only assertion could not tell "the replica stayed quiet"
    // from "the call threw before the filter ever ran".
    // `withheld` is pinned here because this is the only place a real agent reaches the
    // fully-withheld state the transport keys on: `withheld > 0 && manifest.length === 0`
    // is what answers REPLAY_INCOMPLETE instead of `completed` with nothing. The debug
    // assertion below cannot stand in for it -- that line is computed from
    // `superseded.length`, so the RETURNED counter could be zeroed with it still green.
    const replayResult = await replica
      .reannounceRfc64CatalogHeadsToPeerV1('12D3KooWReplicaProbe');
    expect(replayResult).toMatchObject({ announced: 0, failed: 0, withheld: 1 });
    expect(replayResult.manifest).toEqual([]);

    const withheldWarnings = warn.mock.calls.filter(
      ([, message]) => typeof message === 'string' && message.includes('catalog replay withheld'),
    );
    expect(withheldWarnings).toEqual([]);
    // The withhold DID happen, and was deliberately quiet: one head, reported at debug.
    expect(debug.mock.calls.filter(([, message]) => typeof message === 'string'
      && message.includes('catalog replay withheld 1 superseded head(s)'))).toHaveLength(1);
  }, 60_000);

  it('names the authored graph whose rows never crossed onto the accepted generation', async () => {
    // The counterpart of the replica case, and the one operator-actionable signal the whole
    // conditional exists to produce. Both branches are gated on `hasLocalCreate` and differ
    // only in which filter result is non-empty, so without this an inverted gate would turn
    // the warning off -- silently, with the replica test still green.
    const author = await startRotationAuthorV1('authority-rotation-authored-stranded');
    // Rotate as a replica so admission refuses and nothing is carried; the rows stay
    // addressed by the superseded generation.
    const hasLocalCreate = vi
      .spyOn(author.localContextGraphProvenance, 'hasLocalCreate')
      .mockReturnValue(false);

    await seedInventoryAssetV1(author, 'authority-rotation-authored-stranded', 49n);
    await expect(author.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({ status: 'advanced' });
    await rotateToFinalizedChainV1(author);

    // This node IS the author of record; it simply has not re-projected.
    hasLocalCreate.mockReturnValue(true);
    const warn = vi.spyOn(author.log, 'warn');
    const debug = vi.spyOn(author.log, 'debug');

    await expect(author.reannounceRfc64CatalogHeadsToPeerV1('12D3KooWAuthorProbe'))
      .resolves.toMatchObject({ announced: 0, failed: 0, withheld: 1 });

    expect(warn.mock.calls.filter(([, message]) => typeof message === 'string'
      && /has NOT re-projected the rows onto the accepted generation/u.test(message)))
      .toHaveLength(1);
    // Every withheld head was actionable, so nothing was demoted to the quiet branch.
    expect(debug.mock.calls.filter(([, message]) => typeof message === 'string'
      && message.includes('catalog replay withheld'))).toHaveLength(0);
  }, 60_000);

  it('never fabricates a lineage for a graph this node did not author', async () => {
    const replica = await startRotationAuthorV1('authority-rotation-replica');
    vi.spyOn(replica.localContextGraphProvenance, 'hasLocalCreate').mockReturnValue(false);

    await seedInventoryAssetV1(replica, 'authority-rotation-replica', 43n);
    await expect(replica.reconcileRfc64PublicCatalogFromSwmInventoryV1({
      contextGraphId: CONTEXT_GRAPH_ID,
      authorAddress: AUTHOR,
    })).resolves.toMatchObject({ status: 'advanced' });

    await rotateToFinalizedChainV1(replica);
    const rotatedScopeDigest = acceptedCatalogScopeDigestV1(replica);
    expect(rotatedScopeDigest).not.toEqual(catalogScopeDigestV1());
    expect(appliedCatalogHeadV1(replica, rotatedScopeDigest)).toBeNull();
  }, 60_000);
});
