// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  buildExecutedRuntimeManifestV1,
  buildRuntimeManifestFromEntriesV1,
} from '../../../devnet/rfc64-runtime-provenance.mts';
import {
  assertRfc64PrivateGatePassProvenanceV1,
  decodeRfc64PrivateGatePassArtifactV1,
} from '../devnet/rfc64-private-catalog/gate-artifact.mjs';
import {
  RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1,
  buildRfc64PrivateRuntimeProvenanceV1,
} from '../devnet/rfc64-private-catalog/runtime-provenance.mjs';
import { buildRfc64PrivateReleaseArtifactV1 } from
  '../devnet/rfc64-private-catalog/scenario-artifact.mjs';
import { passingScenarioEvidenceV1 } from
  '../devnet/rfc64-private-catalog/scenario-test-fixtures.mjs';
import { PRIVATE_CATALOG_MEMORY_EXPECTATION } from
  '../devnet/rfc64-private-catalog/fixture.mjs';

const RUNTIME_FILES = Object.freeze([
  'packages/agent/dist/index.js',
  'packages/chain/dist/index.js',
  'packages/core/dist/index.js',
  'packages/storage/dist/index.js',
].map((path, index) => Object.freeze({
  byteLength: index + 1,
  path,
  sha256: `0x${String(index + 1).repeat(64)}`,
})));

function runtimeProvenance(sourceRevision: string) {
  const sourceBuild = buildRuntimeManifestFromEntriesV1(sourceRevision, RUNTIME_FILES);
  const loaded = buildExecutedRuntimeManifestV1(sourceRevision, RUNTIME_FILES);
  return buildRfc64PrivateRuntimeProvenanceV1(
    sourceBuild,
    RFC64_PRIVATE_RUNTIME_PROCESS_IDS_V1.map((id) => ({ id, loaded })),
  );
}

function completeScenarioPass(sourceRevision: string) {
  const provenance = runtimeProvenance(sourceRevision);
  return buildRfc64PrivateReleaseArtifactV1({
    ...passingScenarioEvidenceV1(),
    runtimeProvenance: provenance,
  }, provenance.sourceBuild.manifestDigest);
}

function persistedScenarioPass(sourceRevision = 'b'.repeat(40)) {
  return {
    ...completeScenarioPass(sourceRevision),
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:00:01.000Z',
    sourceRevision,
  };
}

describe('RFC-64 private release gate persisted PASS decoder', () => {
  it('decodes only the closed all-true PASS contract with substantiated denials', () => {
    const artifact = persistedScenarioPass();
    expect(decodeRfc64PrivateGatePassArtifactV1(artifact)).toBe(artifact);

    const unknownTopLevel = { ...artifact, unexpected: true };
    expect(() => decodeRfc64PrivateGatePassArtifactV1(unknownTopLevel))
      .toThrow(/unknown or missing fields/u);
    const missingTopLevel = structuredClone(artifact) as Record<string, unknown>;
    delete missingTopLevel.catalog;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(missingTopLevel))
      .toThrow(/unknown or missing fields/u);

    const falseCheck = structuredClone(artifact);
    falseCheck.checks.outsiderDeniedBeforeApplication = false;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(falseCheck))
      .toThrow(/check is not true/u);
    const unknownCheck = structuredClone(artifact) as typeof artifact & {
      checks: typeof artifact.checks & { invented?: boolean };
    };
    unknownCheck.checks.invented = true;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(unknownCheck))
      .toThrow(/unknown or missing fields/u);

    const outsiderApplied = structuredClone(artifact);
    outsiderApplied.outsider.appliedHeadDigest = `0x${'1'.repeat(64)}`;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(outsiderApplied))
      .toThrow(/applied a catalog head/u);
    const outsiderMaterialized = structuredClone(artifact);
    outsiderMaterialized.outsider.graphCounts[0].swm = 1;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(outsiderMaterialized))
      .toThrow(/not empty and unique/u);
    const untypedOutsiderDenial = structuredClone(artifact);
    untypedOutsiderDenial.outsider.failureCode = 'transport-timeout';
    expect(() => decodeRfc64PrivateGatePassArtifactV1(untypedOutsiderDenial))
      .toThrow(/not a typed RFC-64 policy denial/u);

    const unobservedRevocation = structuredClone(artifact);
    unobservedRevocation.revokedReceiver.authority.providerObservation
      .curatorMetadataRefreshed = false;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(unobservedRevocation))
      .toThrow(/authority evidence is inconsistent/u);
    const mismatchedRevokedAgent = structuredClone(artifact);
    mismatchedRevokedAgent.revokedReceiver.revokedAgentAddress = `0x${'2'.repeat(40)}`;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(mismatchedRevokedAgent))
      .toThrow(/authority evidence is inconsistent/u);

    const advancedProviderRoster = structuredClone(artifact);
    advancedProviderRoster.revokedReceiver.rosterVersion = '10000000000008';
    advancedProviderRoster.revokedReceiver.authority.providerObservation
      .effectiveRosterVersion = '10000000000008';
    expect(() => decodeRfc64PrivateGatePassArtifactV1(advancedProviderRoster))
      .toThrow(/authority evidence is inconsistent/u);
    const rolledBackProviderRoster = structuredClone(advancedProviderRoster);
    rolledBackProviderRoster.revokedReceiver.authority.ownerMutation.chainRosterVersion = '3';
    expect(() => decodeRfc64PrivateGatePassArtifactV1(rolledBackProviderRoster))
      .toThrow(/authority evidence is inconsistent/u);

    const crossBoundToAnotherChainGeneration = structuredClone(artifact);
    crossBoundToAnotherChainGeneration.revokedReceiver.rosterVersion = '20000000000007';
    crossBoundToAnotherChainGeneration.revokedReceiver.authority.providerObservation
      .chainRosterVersion = '2';
    crossBoundToAnotherChainGeneration.revokedReceiver.authority.providerObservation
      .effectiveRosterVersion = '20000000000007';
    expect(() => decodeRfc64PrivateGatePassArtifactV1(crossBoundToAnotherChainGeneration))
      .toThrow(/authority evidence is inconsistent/u);

    const unprojectedAuthority = structuredClone(artifact) as typeof artifact & {
      revokedReceiver: typeof artifact.revokedReceiver & {
        authority: typeof artifact.revokedReceiver.authority & {
          ownerMutation: typeof artifact.revokedReceiver.authority.ownerMutation & {
            event?: string;
          };
        };
      };
    };
    unprojectedAuthority.revokedReceiver.authority.ownerMutation.event = 'receiver-revoked';
    expect(() => decodeRfc64PrivateGatePassArtifactV1(unprojectedAuthority))
      .toThrow(/unknown or missing fields/u);

    const droppedOutsiderInventory = structuredClone(artifact);
    droppedOutsiderInventory.outsider.graphCounts.pop();
    expect(() => decodeRfc64PrivateGatePassArtifactV1(droppedOutsiderInventory))
      .toThrow(/inventory is not catalog-bound/u);
    const missingCatalog = structuredClone(artifact);
    missingCatalog.catalog = null as never;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(missingCatalog))
      .toThrow(/catalog evidence must be an object/u);
    const missingRevokedInventory = structuredClone(artifact);
    missingRevokedInventory.revokedReceiver.state.graphCounts = [];
    expect(() => decodeRfc64PrivateGatePassArtifactV1(missingRevokedInventory))
      .toThrow(/bounded row count/u);
    const nonAdvancingRoster = structuredClone(artifact);
    nonAdvancingRoster.revokedReceiver.authority.ownerMutation
      .previousChainRosterVersion = '1';
    nonAdvancingRoster.revokedReceiver.authority.providerObservation
      .previousChainRosterVersion = '1';
    expect(() => decodeRfc64PrivateGatePassArtifactV1(nonAdvancingRoster))
      .toThrow(/authority evidence is inconsistent/u);
    const consistentlyReboundReceiver = structuredClone(artifact);
    const unrelatedAddress = `0x${'ab'.repeat(20)}`;
    consistentlyReboundReceiver.topology.authorizedReceiver.agentAddress = unrelatedAddress;
    consistentlyReboundReceiver.revokedReceiver.revokedAgentAddress = unrelatedAddress;
    consistentlyReboundReceiver.revokedReceiver.authority.ownerMutation.revokedAgentAddress =
      unrelatedAddress;
    consistentlyReboundReceiver.revokedReceiver.authority.providerObservation.revokedAgentAddress =
      unrelatedAddress;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(consistentlyReboundReceiver))
      .toThrow(/not fixture-bound/u);
    const missingSourceProof = structuredClone(artifact);
    missingSourceProof.sourceProvider = null as never;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(missingSourceProof))
      .toThrow(/source provider state must be an object/u);
    const crossCatalogState = structuredClone(artifact);
    crossCatalogState.revokedReceiver.state.catalogScopeDigest = `0x${'aa'.repeat(32)}`;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(crossCatalogState))
      .toThrow(/not bound to the catalog/u);
    const extraNestedState = structuredClone(artifact) as typeof artifact & {
      failoverReceiver: typeof artifact.failoverReceiver & { invented?: boolean };
    };
    extraNestedState.failoverReceiver.invented = true;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(extraNestedState))
      .toThrow(/unknown or missing fields/u);
    const reboundBootstrap = structuredClone(artifact);
    reboundBootstrap.provider2.bootstrap.providerPeerId =
      artifact.topology.unauthorizedNode.peerId;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(reboundBootstrap))
      .toThrow(/not bound to the expected provider/u);
    const extraBootstrapField = structuredClone(artifact) as typeof artifact;
    Object.assign(extraBootstrapField.failoverReceiver.bootstrap, { invented: true });
    expect(() => decodeRfc64PrivateGatePassArtifactV1(extraBootstrapField))
      .toThrow(/unknown or missing fields/u);
    const reorderedFailover = structuredClone(artifact);
    reorderedFailover.failoverBarrier.ownerExitedAt =
      reorderedFailover.failoverBarrier.receiverSpawnedAt;
    reorderedFailover.failoverBarrier.receiverSpawnedAt = '2026-08-26T00:00:00.250Z';
    expect(() => decodeRfc64PrivateGatePassArtifactV1(reorderedFailover))
      .toThrow(/failover barrier is inconsistent/u);
    const reboundRpc = structuredClone(artifact);
    reboundRpc.rpcActors.provider2.byMethod.eth_call += 1;
    reboundRpc.rpcActors.provider2.total += 1;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(reboundRpc))
      .toThrow(/RPC evidence is not actor-bound/u);
    const unknownRpcMethod = structuredClone(artifact);
    unknownRpcMethod.rpcActors.owner.byMethod.eth_sendTransaction = 1;
    unknownRpcMethod.rpcActors.owner.total = 1;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(unknownRpcMethod))
      .toThrow(/outside its fixed contract/u);
    const rewrittenMemory = structuredClone(artifact);
    rewrittenMemory.provider2.graphCounts[0].swmDigest = '0'.repeat(64);
    expect(() => decodeRfc64PrivateGatePassArtifactV1(rewrittenMemory))
      .toThrow(/differs from the fixed memory fixture/u);
    const finalizedSourceVm = structuredClone(artifact);
    finalizedSourceVm.sourceProvider.graphCounts[0].vmHead = {
      assertionGraph: finalizedSourceVm.sourceProvider.graphCounts[0].vmGraph,
      assertionVersion: PRIVATE_CATALOG_MEMORY_EXPECTATION.vm.assertionVersion,
    };
    expect(() => decodeRfc64PrivateGatePassArtifactV1(finalizedSourceVm))
      .toThrow(/unexpected finalized VM evidence/u);
    const materializedSourceVm = structuredClone(artifact);
    materializedSourceVm.sourceProvider.graphCounts[0].vm =
      PRIVATE_CATALOG_MEMORY_EXPECTATION.vm.projection.count;
    materializedSourceVm.sourceProvider.graphCounts[0].vmDigest =
      PRIVATE_CATALOG_MEMORY_EXPECTATION.vm.projection.digest;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(materializedSourceVm))
      .toThrow(/differs from the fixed memory fixture/u);
    const reboundBaseline = structuredClone(artifact);
    reboundBaseline.receiverBaseline.appliedHeadDigest = artifact.catalog.headObjectDigest;
    reboundBaseline.receiverBaseline.graphCounts.forEach((row) => {
      row.swmProof.catalogHeadDigest = artifact.catalog.headObjectDigest;
    });
    expect(() => decodeRfc64PrivateGatePassArtifactV1(reboundBaseline))
      .toThrow(/not bound to the catalog/u);
    const changedLimitation = structuredClone(artifact);
    changedLimitation.limitation = 'unbounded external RPC';
    expect(() => decodeRfc64PrivateGatePassArtifactV1(changedLimitation))
      .toThrow(/fixed limitation metadata/u);

    const consistentlyReboundScope = structuredClone(artifact);
    const unrelatedScopeDigest = `0x${'a5'.repeat(32)}`;
    consistentlyReboundScope.catalog.scopeDigest = unrelatedScopeDigest;
    consistentlyReboundScope.sourceProvider.catalogScopeDigest = unrelatedScopeDigest;
    consistentlyReboundScope.provider2.catalogScopeDigest = unrelatedScopeDigest;
    consistentlyReboundScope.receiverBaseline.catalogScopeDigest = unrelatedScopeDigest;
    consistentlyReboundScope.failoverReceiver.catalogScopeDigest = unrelatedScopeDigest;
    consistentlyReboundScope.outsider.catalogScopeDigest = unrelatedScopeDigest;
    consistentlyReboundScope.revokedReceiver.state.catalogScopeDigest = unrelatedScopeDigest;
    consistentlyReboundScope.restartedReceiver.catalogScopeDigest = unrelatedScopeDigest;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(consistentlyReboundScope))
      .toThrow(/not fixture-bound/u);

    const consistentlyReboundPolicy = structuredClone(artifact);
    const unrelatedPolicyDigest = `0x${'a6'.repeat(32)}`;
    consistentlyReboundPolicy.catalog.policyDigest = unrelatedPolicyDigest;
    consistentlyReboundPolicy.revokedReceiver.authority.ownerMutation.policyDigest =
      unrelatedPolicyDigest;
    consistentlyReboundPolicy.revokedReceiver.authority.providerObservation.policyDigest =
      unrelatedPolicyDigest;
    expect(() => decodeRfc64PrivateGatePassArtifactV1(consistentlyReboundPolicy))
      .toThrow(/not fixture-bound/u);
  });

  it('accepts exact SHA-1/SHA-256 revisions and rejects other revision widths or future intervals', () => {
    const sha256Artifact = persistedScenarioPass('c'.repeat(64));
    expect(decodeRfc64PrivateGatePassArtifactV1(sha256Artifact)).toBe(sha256Artifact);
    expect(() => decodeRfc64PrivateGatePassArtifactV1({
      ...persistedScenarioPass(),
      sourceRevision: 'c'.repeat(63),
    })).toThrow(/exact Git source revision/u);
    expect(() => decodeRfc64PrivateGatePassArtifactV1({
      ...persistedScenarioPass(),
      finishedAt: '2099-01-01T00:00:00.000Z',
    })).toThrow(/interval is in the future/u);
  });

  it('rejects PASS provenance with a missing revision or invalid run interval', () => {
    const provenance = runtimeProvenance('c'.repeat(40));
    const base = {
      schema: 'dkg-rfc64-private-release-gate-v1',
      status: 'PASS',
      startedAt: '2026-08-26T00:00:01.000Z',
      finishedAt: '2026-08-26T00:00:02.000Z',
      sourceRevision: 'c'.repeat(40),
      runtimeManifestDigest: provenance.sourceBuild.manifestDigest,
      runtimeProvenance: provenance,
    };
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      sourceRevision: null,
    })).toThrow(/exact source revision/u);
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      finishedAt: '2026-08-25T23:59:59.000Z',
    })).toThrow(/precedes/u);
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      runtimeManifestDigest: null,
    })).toThrow(/runtime manifest digest/u);
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      runtimeProvenance: null,
    })).toThrow(/runtime provenance is incomplete/u);
  });

  it('rejects syntactically valid outer provenance bindings that differ from the runtime proof', () => {
    const sourceRevision = 'c'.repeat(40);
    const provenance = runtimeProvenance(sourceRevision);
    const base = {
      schema: 'dkg-rfc64-private-release-gate-v1',
      status: 'PASS',
      startedAt: '2026-08-26T00:00:01.000Z',
      finishedAt: '2026-08-26T00:00:02.000Z',
      sourceRevision,
      runtimeManifestDigest: provenance.sourceBuild.manifestDigest,
      runtimeProvenance: provenance,
    };

    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      sourceRevision: 'd'.repeat(40),
    })).toThrow(/not source-bound/u);
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      runtimeManifestDigest: `0x${'f'.repeat(64)}`,
    })).toThrow(/not source-bound/u);
  });

  it('rejects non-canonical clean-build and executed-runtime hash claims', () => {
    const sourceRevision = 'd'.repeat(40);
    const provenance = runtimeProvenance(sourceRevision);
    const base = {
      schema: 'dkg-rfc64-private-release-gate-v1',
      status: 'PASS',
      startedAt: '2026-08-26T00:00:01.000Z',
      finishedAt: '2026-08-26T00:00:02.000Z',
      sourceRevision,
      runtimeManifestDigest: provenance.sourceBuild.manifestDigest,
      runtimeProvenance: provenance,
    };
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      runtimeProvenance: {
        ...provenance,
        sourceBuild: {
          ...provenance.sourceBuild,
          runtimeFiles: provenance.sourceBuild.runtimeFiles.map((entry, index) => index === 0
            ? { ...entry, sha256: `0x${'a'.repeat(64)}` }
            : entry),
        },
      },
    })).toThrow(/runtime provenance is incomplete/u);
    expect(() => assertRfc64PrivateGatePassProvenanceV1({
      ...base,
      runtimeProvenance: {
        ...provenance,
        processes: provenance.processes.map((processEvidence, index) => index === 0
          ? {
              ...processEvidence,
              loaded: {
                ...processEvidence.loaded,
                manifestDigest: `0x${'e'.repeat(64)}`,
              },
            }
          : processEvidence),
      },
    })).toThrow(/runtime provenance is incomplete/u);
  });

  it('rejects every mutation of the fixed nine-process topology', () => {
    const sourceRevision = 'e'.repeat(40);
    const provenance = runtimeProvenance(sourceRevision);
    const base = {
      schema: 'dkg-rfc64-private-release-gate-v1',
      status: 'PASS',
      startedAt: '2026-08-26T00:00:01.000Z',
      finishedAt: '2026-08-26T00:00:02.000Z',
      sourceRevision,
      runtimeManifestDigest: provenance.sourceBuild.manifestDigest,
    };
    const swapped = [...provenance.processes];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    const mutations = [
      { ...provenance, processes: provenance.processes.slice(0, -1) },
      { ...provenance, processes: [...provenance.processes, provenance.processes[0]] },
      { ...provenance, processes: swapped },
      {
        ...provenance,
        processes: provenance.processes.map((entry, index) => index === 0
          ? { ...entry, id: 'renamed-process' }
          : entry),
      },
      { ...provenance, schema: 'wrong-runtime-provenance-schema' },
    ];

    for (const runtimeProvenanceMutation of mutations) {
      expect(() => assertRfc64PrivateGatePassProvenanceV1({
        ...base,
        runtimeProvenance: runtimeProvenanceMutation,
      })).toThrow(/runtime provenance is incomplete/u);
    }
  });

});

