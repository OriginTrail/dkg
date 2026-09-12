// SPDX-License-Identifier: Apache-2.0
// @ts-check

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

/** @typedef {import('./agent-runtime.ts').Rfc64PrivateRuntimeV1} Rfc64PrivateRuntimeV1 */
/** @typedef {import('./agent-runtime.ts').FinalizedRuntimeV1} FinalizedRuntimeV1 */
/** @typedef {import('../../src/dkg-agent-rfc64-catalog-sync.ts').SynchronizeRfc64CatalogRolloutFromProvidersResultV1} Rfc64CatalogRolloutResultV1 */
/** @typedef {{ error: string }} Rfc64PrivateBootstrapErrorV1 */
/** @typedef {Rfc64CatalogRolloutResultV1 | Rfc64PrivateBootstrapErrorV1 | null} Rfc64PrivateBootstrapCandidateV1 */
/** @typedef {{ accepted: true, attempts: number, last: Rfc64CatalogRolloutResultV1 } | { accepted: false, attempts: number, last: Rfc64PrivateBootstrapCandidateV1 | undefined }} Rfc64PrivateBootstrapObservationV1 */

/**
 * @param {Rfc64PrivateRuntimeV1} context
 * @param {{ timeoutMs?: number, expectedHeadDigest?: import('@origintrail-official/dkg-core').Digest32V1, expectedMemory?: 'finalized-vm-v1' }} command
 */
export async function waitForBootstrapV1(context, command) {
  assertFinalizedRuntimeV1(context);
  const { role } = context;
  const timeoutMs = boundedTimeoutV1(command.timeoutMs);
  const providerRole = role === 'provider2' ? 'owner' : 'provider2';
  const providerPeerId = context.peerIds[providerRole];
  if (providerPeerId === undefined) {
    throw new Error(`${role} has no configured catalog provider`);
  }
  const observation = await runRfc64PrivateBootstrapRetryLoopV1({
    timeoutMs,
    synchronize: () => context.agent.synchronizeRfc64CatalogRolloutFromProvidersV1({
      remotePeerIds: [providerPeerId],
      scope: createPrivateCatalogSyncScope(),
    }),
    isSynchronized: (last) => last !== null
        && !('error' in last)
        && ['applied', 'already-applied'].includes(last.completionOutcome)
        && (
          command.expectedHeadDigest === undefined
          || last.currentCatalogHeadDigest === command.expectedHeadDigest
        ),
    verify: async (last) => {
      return command.expectedMemory === 'finalized-vm-v1'
        ? hasExactLocalFinalizedVmBaselineV1(context)
        : hasExactLocalMemoryContentsV1(context, {
            catalogVersion: last.catalogVersion,
            exactExpectedHead: true,
          });
    },
  });
  if (observation.accepted) {
    const { last, attempts } = observation;
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
  const { last } = observation;
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

/** Retry transport failures without running applied-memory proofs prematurely. */
/**
 * @param {{
 *   timeoutMs: number,
 *   synchronize: () => Promise<Rfc64CatalogRolloutResultV1 | null>,
 *   isSynchronized: (last: Rfc64PrivateBootstrapCandidateV1) => boolean,
 *   verify: (last: Rfc64CatalogRolloutResultV1) => Promise<boolean>,
 *   wait?: () => Promise<void>
 * }} input
 * @returns {Promise<Rfc64PrivateBootstrapObservationV1>}
 */
export async function runRfc64PrivateBootstrapRetryLoopV1({
  timeoutMs,
  synchronize,
  isSynchronized,
  verify,
  wait = () => delay(100),
}) {
  const deadline = Date.now() + timeoutMs;
  /** @type {Rfc64PrivateBootstrapCandidateV1 | undefined} */
  let last;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      last = await synchronize();
    } catch (error) {
      last = { error: boundedErrorChainV1(error) };
    }
    // `verify` owns the strict applied-memory proof. It is deliberately not
    // invoked for transport failures or null/incomplete synchronization.
    if (
      isSynchronized(last)
      && await verify(/** @type {Rfc64CatalogRolloutResultV1} */ (last))
    ) {
      return Object.freeze({
        accepted: true,
        attempts,
        last: /** @type {Rfc64CatalogRolloutResultV1} */ (last),
      });
    }
    await wait();
  }
  return Object.freeze({ accepted: false, attempts, last });
}

/** Preserve the canonical nullable provider identity instead of inferring transfer provenance. */
/**
 * @param {Rfc64CatalogRolloutResultV1} result
 * @param {number} attempts
 * @param {string} expectedProviderPeerId
 * @param {string | null} [observedAppliedProviderPeerId]
 */
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

/**
 * @param {Rfc64PrivateRuntimeV1} context
 * @param {import('@origintrail-official/dkg-core').Digest32V1 | undefined} expectedHeadDigest
 * @param {{ includeNonmemberQuery?: boolean }} [options]
 */
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

/**
 * @param {Rfc64PrivateRuntimeV1} context
 * @param {{ providerPeerIds: readonly string[] }} command
 */
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

/** @param {FinalizedRuntimeV1} context */
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

/**
 * @param {FinalizedRuntimeV1} context
 * @param {{ catalogVersion?: string, exactExpectedHead?: boolean }} [catalogEvidence]
 */
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

/**
 * @param {FinalizedRuntimeV1} context
 * @param {import('../../src/rfc64/inventory-v1/index.ts').AppliedCatalogHeadSnapshotV1 | null} applied
 * @param {import('@origintrail-official/dkg-core').AuthorCatalogScopeV1} scope
 */
async function readVerifiedAppliedCatalogMemoryV1(context, applied, scope) {
  const persistence = /** @type {{ rfc64PersistenceV1?: import('../../src/rfc64/persistence-v1.ts').Rfc64PersistenceV1 }} */ (
    /** @type {unknown} */ (context.agent)
  ).rfc64PersistenceV1;
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

/** @param {unknown} value */
function boundedTimeoutV1(value) {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1_000
    && value <= 120_000
    ? value
    : 60_000;
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} _key
 * @param {unknown} value
 */
function bigintToDecimal(_key, value) {
  return typeof value === 'bigint' ? value.toString(10) : value;
}
