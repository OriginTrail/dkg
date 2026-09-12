// SPDX-License-Identifier: Apache-2.0

import { computeAuthorCatalogScopeDigestV1 } from '@origintrail-official/dkg-core';

import { boundedErrorChainV1 } from './bounded-error.mjs';
import { classifyExpectedPrivateCatalogDenialV1 } from './denial-evidence.mjs';
import {
  ASSET_NUMBERS,
  CONTEXT_GRAPH_ID,
  DEPLOYMENT,
  NETWORK_ID,
  PRIVATE_CATALOG_MEMORY_EXPECTATION,
  createPrivateCatalogScope,
  createPrivateCatalogSyncScope,
  roleAgentAddress,
} from './fixture.mjs';
import { assertFinalizedRuntimeV1 } from './agent-runtime.ts';
import {
  hasExactPrivateCatalogFinalizedVmBaselineContents,
  hasExactPrivateCatalogMemoryContents,
  readPrivateCatalogWorkspaceMemoryEvidenceV1,
} from './memory-evidence.mjs';
import { readVerifiedAppliedCatalogMemoryEvidenceV1 } from './verified-catalog-swm-proof.mjs';

export async function waitForBootstrapV1(context, command) {
  assertFinalizedRuntimeV1(context);
  const { role } = context;
  const timeoutMs = boundedTimeoutV1(command.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let last;
  let attempts = 0;
  const providerRole = role === 'provider2' ? 'owner' : 'provider2';
  const providerPeerId = context.peerIds[providerRole];
  if (providerPeerId === undefined) {
    throw new Error(`${role} has no configured catalog provider`);
  }
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      last = await context.agent.synchronizeRfc64CatalogRolloutFromProvidersV1({
        remotePeerIds: [providerPeerId],
        scope: createPrivateCatalogSyncScope(),
      });
    } catch (error) {
      last = { error: boundedErrorChainV1(error) };
    }
    const bootstrapApplied = last !== null
      && last.error === undefined
      && ['applied', 'already-applied'].includes(last.completionOutcome)
      && (
        command.expectedHeadDigest === undefined
        || last.currentCatalogHeadDigest === command.expectedHeadDigest
      );
    const exactMemory = command.expectedMemory === 'finalized-vm-v1'
      ? await hasExactLocalFinalizedVmBaselineV1(context)
      : await hasExactLocalMemoryContentsV1(context, {
        catalogVersion: last?.catalogVersion,
        exactExpectedHead: bootstrapApplied,
      });
    if (bootstrapApplied && exactMemory) {
      const synchronizationEvidence =
        context.agent.readRfc64PublicCatalogSynchronizationEvidenceV1(
          last.currentCatalogHeadDigest,
        );
      return composeBootstrapEvidenceV1(
        last,
        attempts,
        providerPeerId,
        synchronizationEvidence?.appliedProviderPeerId ?? null,
      );
    }
    await delay(100);
  }
  const graphCounts = await readPrivateCatalogWorkspaceMemoryEvidenceV1(context.agent.store, {
    assetNumbers: ASSET_NUMBERS,
    contextGraphId: CONTEXT_GRAPH_ID,
    authorAddress: roleAgentAddress('owner'),
    networkId: NETWORK_ID,
  });
  const registeredAuthority = await context.agent.resolveRegisteredContextGraphAuthority(
    CONTEXT_GRAPH_ID,
  ).catch((error) => ({ error: boundedErrorChainV1(error) }));
  const memberRecoveryGate = await context.agent.getMemberRecoveryGate(
    CONTEXT_GRAPH_ID,
  ).catch((error) => ({ error: boundedErrorChainV1(error) }));
  throw new Error(
    `bootstrap did not converge; graphCounts=${JSON.stringify(graphCounts)}; `
    + `memberRecoveryGate=${JSON.stringify(memberRecoveryGate)}; `
    + `registeredAuthority=${JSON.stringify(registeredAuthority, bigintToDecimal)}; `
    + `last=${JSON.stringify(last)}`,
  );
}

/** Preserve the canonical nullable provider identity instead of inferring transfer provenance. */
export function composeBootstrapEvidenceV1(
  result,
  attempts,
  expectedProviderPeerId,
  observedAppliedProviderPeerId = null,
) {
  if (
    result === null
    || typeof result !== 'object'
    || !['applied', 'already-applied'].includes(result.completionOutcome)
    || !Number.isSafeInteger(attempts)
    || attempts < 1
  ) {
    throw new TypeError('bootstrap evidence requires a successful bounded result');
  }
  const providerPeerId = result.appliedProviderPeerId;
  if (
    result.completionOutcome === 'applied'
      ? typeof providerPeerId !== 'string'
        || providerPeerId.length === 0
        || providerPeerId !== expectedProviderPeerId
      : providerPeerId !== null
  ) {
    throw new TypeError('bootstrap evidence has inconsistent provider provenance');
  }
  if (
    observedAppliedProviderPeerId !== null
    && observedAppliedProviderPeerId !== expectedProviderPeerId
  ) {
    throw new TypeError('bootstrap evidence has inconsistent applied-transfer provenance');
  }
  return Object.freeze({
    outcome: result.completionOutcome,
    providerPeerId,
    appliedTransferProviderPeerId: result.completionOutcome === 'applied'
      ? providerPeerId
      : observedAppliedProviderPeerId,
    appliedHeadDigest: result.currentCatalogHeadDigest,
    catalogVersion: result.catalogVersion,
    inventoryRowCount: result.inventoryRowCount,
    attempts,
  });
}

export async function inspectPrivateCatalogV1(
  context,
  expectedHeadDigest,
  { includeNonmemberQuery = true } = {},
) {
  assertFinalizedRuntimeV1(context);
  const { role } = context;
  const authorAddress = roleAgentAddress('owner');
  const scope = createPrivateCatalogScope({ authorAddress });
  const scopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  const applied = context.agent.readRfc64AppliedCatalogHeadV1({
    catalogScopeDigest: scopeDigest,
    authorAddress,
  });
  const graphCounts = role === 'owner' || applied === null
    ? await readPrivateCatalogWorkspaceMemoryEvidenceV1(context.agent.store, {
        assetNumbers: ASSET_NUMBERS,
        contextGraphId: CONTEXT_GRAPH_ID,
        authorAddress,
        networkId: NETWORK_ID,
      })
    : await readVerifiedAppliedCatalogMemoryV1(context, applied, scope);
  const outsiderResult = role === 'outsider' || !includeNonmemberQuery
    ? null
    : await context.agent.query(
      'SELECT ?name WHERE { <https://example.org/alice> <https://schema.org/name> ?name }',
      {
        contextGraphId: CONTEXT_GRAPH_ID,
        view: 'verifiable-memory',
        callerAgentAddress: roleAgentAddress('outsider'),
      },
    );
  return {
    appliedHeadDigest: applied?.currentCatalogHeadDigest ?? null,
    catalogScopeDigest: scopeDigest,
    catalogVersion: applied?.catalogVersion ?? null,
    inventoryRowCount: applied?.inventoryRowCount ?? null,
    exactExpectedHead: expectedHeadDigest === undefined
      ? null
      : applied?.currentCatalogHeadDigest === expectedHeadDigest,
    graphCounts,
    outsiderVisibleVmBindings: includeNonmemberQuery
      ? outsiderResult?.bindings?.length ?? 0
      : null,
    receiverStats: context.agent.rfc64PublicCatalogStatsV1()?.receiver ?? null,
    rpcCalls: context.rpc === undefined ? 0 : [
      'eth_getBlockByNumber',
      'eth_call',
    ].reduce((sum, method) => sum + context.rpc.calls(method), 0),
    rpcCallCounts: context.rpc?.snapshot() ?? Object.freeze({}),
  };
}

export async function provePrivateCatalogDeniedV1(context, command) {
  assertFinalizedRuntimeV1(context);
  try {
    const result = await context.agent.synchronizeRfc64CatalogFromProvidersV1({
      remotePeerIds: command.providerPeerIds,
      scope: createPrivateCatalogSyncScope(),
    });
    return {
      denied: false,
      applied: result !== null,
      failureClass: null,
    };
  } catch (error) {
    const denial = classifyExpectedPrivateCatalogDenialV1(error);
    if (denial === null) throw error;
    return {
      denied: true,
      applied: false,
      ...denial,
    };
  }
}

async function hasExactLocalFinalizedVmBaselineV1(context) {
  const graphCounts = await readPrivateCatalogWorkspaceMemoryEvidenceV1(context.agent.store, {
    assetNumbers: ASSET_NUMBERS,
    contextGraphId: CONTEXT_GRAPH_ID,
    authorAddress: roleAgentAddress('owner'),
    networkId: NETWORK_ID,
  });
  return hasExactPrivateCatalogFinalizedVmBaselineContents(
    { graphCounts },
    PRIVATE_CATALOG_MEMORY_EXPECTATION,
    { swmProofKind: 'absent' },
  );
}

async function hasExactLocalMemoryContentsV1(context, catalogEvidence = {}) {
  const authorAddress = roleAgentAddress('owner');
  const scope = createPrivateCatalogScope({ authorAddress });
  const applied = context.agent.readRfc64AppliedCatalogHeadV1({
    catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
    authorAddress,
  });
  const graphCounts = await readVerifiedAppliedCatalogMemoryV1(context, applied, scope);
  return hasExactPrivateCatalogMemoryContents(
    {
      appliedHeadDigest: applied?.currentCatalogHeadDigest,
      graphCounts,
      ...catalogEvidence,
    },
    PRIVATE_CATALOG_MEMORY_EXPECTATION,
  );
}

async function readVerifiedAppliedCatalogMemoryV1(context, applied, scope) {
  const persistence = context.agent.rfc64PersistenceV1;
  if (applied === null || persistence === undefined) {
    throw new Error('catalog-row SWM evidence has no durable applied catalog');
  }
  const proofInputs = context.faultProfile.proof.inputs({
    appliedHead: applied,
    expectedAssetNumbers: ASSET_NUMBERS,
    kaBundles: persistence.kaBundles,
    trustedCatalogScope: scope,
    untrustedCatalogScope: Object.freeze({
      ...scope,
      authorAddress: roleAgentAddress('outsider'),
    }),
  });
  return readVerifiedAppliedCatalogMemoryEvidenceV1({
    ...proofInputs,
    controlObjects: persistence.controlObjects,
    deployment: DEPLOYMENT,
    store: context.agent.store,
  });
}

function boundedTimeoutV1(value) {
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 120_000
    ? value
    : 60_000;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bigintToDecimal(_key, value) {
  return typeof value === 'bigint' ? value.toString(10) : value;
}
