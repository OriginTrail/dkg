// SPDX-License-Identifier: Apache-2.0
// @ts-check

/** @typedef {import('./domain-contract.js').NormalizedCanaryAuthorizationCheckV1} NormalizedCanaryAuthorizationCheckV1 */
/** @typedef {import('./domain-contract.js').NormalizedCanaryContextGraphV1} NormalizedCanaryContextGraphV1 */
/** @typedef {import('./domain-contract.js').NormalizedRemoteCanaryConfigV1} NormalizedRemoteCanaryConfigV1 */
/** @typedef {import('./domain-contract.js').RemoteCanaryDependenciesV1} RemoteCanaryDependenciesV1 */

import { readFile } from 'node:fs/promises';

import { ARTIFACT_SCHEMA } from './artifact-contract.mjs';
import { verifyAuthorizationV1 } from './authorization.mjs';
import {
  createRemoteCanaryCohortRefV1,
  validateRemoteCanaryConfigV1,
} from './config.mjs';
import { failure, runPhaseV1 } from './errors.mjs';
import { preflightAllNodesV1 } from './preflight.mjs';
import { collectRpcUsageEvidenceV1 } from './rpc-evidence.mjs';
import {
  verifyCatalogSwmV1,
  verifyLiveSwmPropagationV1,
  verifyOfflineCatchupV1,
} from './swm.mjs';
import { createRequesterV1, runBoundedCommandV1 } from './transport.mjs';
import { verifyVmParityEvidenceV1 } from './vm.mjs';

/** A network-free plan. It deliberately does not read auth or evidence files. */
/** @param {unknown} config @param {() => Date} [now] */
export function createRemoteCanaryDryRunArtifactV1(config, now = () => new Date()) {
  const validated = runPhaseV1('config', () => validateRemoteCanaryConfigV1(config));
  const timestamp = now().toISOString();
  return Object.freeze({
    schema: ARTIFACT_SCHEMA,
    status: 'DRY_RUN',
    phase: 'planned',
    startedAt: timestamp,
    finishedAt: timestamp,
    expectedCommit: validated.expectedCommit,
    cohortRef: createRemoteCanaryCohortRefV1(validated),
    topology: redactedTopology(validated),
    plan: createDryRunPlan(validated),
  });
}

/** Execute the ordered certification phases, parallelizing only independent checks. */
/** @param {unknown} config @param {RemoteCanaryDependenciesV1} [dependencies] */
export async function executeRemoteCanaryCertificationV1(config, dependencies = {}) {
  const validated = runPhaseV1('config', () => validateRemoteCanaryConfigV1(config));
  const fetchFn = dependencies.fetchFn ?? globalThis.fetch;
  const readFileFn = dependencies.readFileFn ?? readFile;
  const runCommand = dependencies.runCommand ?? runBoundedCommandV1;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? (() => new Date());
  const secrets = new Map();
  const request = runPhaseV1('config', () => {
    if (typeof fetchFn !== 'function') throw failure('fetch-unavailable', 'configuration');
    return createRequesterV1({ fetchFn, readFileFn, secrets, timing: validated.timing });
  });
  const startedAt = runPhaseV1('config', () => now().toISOString());
  const cohortRef = createRemoteCanaryCohortRefV1(validated);

  try {
    const initialPreflight = await runPhaseV1('preflight', () => preflightAllNodesV1({
      mode: 'initial',
      config: validated,
      request,
    }));

    // Establish catalog-owned evidence before this run can write any marker vocabulary.
    await runPhaseV1('catalog-swm-evidence', () => verifyCatalogSwmV1({
      config: validated,
      request,
    }));

    const liveSwmPropagation = await runPhaseV1(
      'live-swm-propagation',
      () => verifyLiveSwmPropagationV1({
        config: validated,
        request,
        sleep,
      }),
    );

    const offlineCatchup = await runPhaseV1('offline-catchup', () => (
      validated.lifecycle === null
        ? Object.freeze({
            status: 'EVIDENCE_REQUIRED',
            requirement: 'single-receiver-stop-start',
          })
        : verifyOfflineCatchupV1({
            config: validated,
            lifecycle: validated.lifecycle,
            request,
            runCommand,
            sleep,
          })
    ));

    const vmParityEvidence = await runPhaseV1('vm-parity', () => verifyVmParityEvidenceV1({
      config: validated,
      request,
      sleep,
    }));

    const catalogSwm = await runPhaseV1('catalog-swm-evidence', () => verifyCatalogSwmV1({
      config: validated,
      request,
    }));

    const authorization = await runPhaseV1('authorization', () => verifyAuthorizationV1(
      validated.authorizationChecks,
      request,
    ));

    const rpcUsage = await runPhaseV1('rpc-usage', () => collectRpcUsageEvidenceV1(
      validated.rpcUsage,
      {
        readFileFn,
        runCommand,
        startedAt,
        observedAt: now().toISOString(),
        expectedCommit: validated.expectedCommit,
        cohortRef,
      },
    ));

    // A disruptive certification run can overlap a rollout or node restart.
    // Re-establish build, network, sync, and catalog invariants immediately
    // before issuing PASS, and bind the certificate to this fresh snapshot.
    const finalPreflight = await runPhaseV1('final-preflight', () => preflightAllNodesV1({
      mode: 'final',
      config: validated,
      request,
      baseline: {
        networkKey: initialPreflight.networkKey,
        nodeIdentities: initialPreflight.nodeIdentities,
        operationalCertificationByNodeId: vmParityEvidence.certificationByNodeId,
      },
    }));

    const checks = Object.freeze({
      liveSwmPropagation: Object.freeze(liveSwmPropagation),
      offlineCatchup,
      vmParity: Object.freeze(vmParityEvidence.checks),
      catalogSwm: Object.freeze(catalogSwm),
      authorization,
      rpcUsage,
    });
    const incomplete = [
      ...checks.liveSwmPropagation,
      checks.offlineCatchup,
      ...checks.vmParity,
      ...checks.catalogSwm,
      checks.authorization.unauthorized,
      checks.authorization.revoked,
      checks.rpcUsage,
    ].some(({ status }) => status !== 'PASS');
    return Object.freeze({
      schema: ARTIFACT_SCHEMA,
      status: incomplete ? 'INCOMPLETE' : 'PASS',
      phase: incomplete ? 'evidence-required' : 'complete',
      startedAt,
      finishedAt: now().toISOString(),
      expectedCommit: validated.expectedCommit,
      cohortRef,
      topology: redactedTopology(validated),
      preflight: Object.freeze({ status: 'PASS', nodes: finalPreflight.nodes }),
      checks,
    });
  } finally {
    secrets.clear();
  }
}

/** @param {NormalizedRemoteCanaryConfigV1} config */
function createDryRunPlan(config) {
  return Object.freeze({
    preflight: 'exact-build-network-sync-and-catalog-mode',
    liveSwmPropagationChecks: config.contextGraphs.length,
    offlineCatchup: config.lifecycle === null ? 'EVIDENCE_REQUIRED' : 'PLANNED',
    vmParityChecks: config.contextGraphs.length,
    vmParityEvidence: summarizeAskEvidence(config.contextGraphs, 'vmAskSparql'),
    catalogSwmEvidence: summarizeAskEvidence(config.contextGraphs, 'catalogSwmAskSparql'),
    authorization: Object.freeze({
      unauthorized: authorizationEvidenceState(config.authorizationChecks.unauthorized),
      revoked: authorizationEvidenceState(config.authorizationChecks.revoked),
    }),
    rpcUsage: config.rpcUsage.kind === 'required' ? 'EVIDENCE_REQUIRED' : 'PLANNED',
  });
}

/**
 * @param {readonly NormalizedCanaryContextGraphV1[]} checks
 * @param {'vmAskSparql' | 'catalogSwmAskSparql'} field
 */
function summarizeAskEvidence(checks, field) {
  return checks.every((check) => check[field] !== undefined)
    ? 'PLANNED'
    : 'EVIDENCE_REQUIRED';
}

/** @param {NormalizedCanaryAuthorizationCheckV1} check */
function authorizationEvidenceState(check) {
  return check.kind === 'not-exposed' ? 'EVIDENCE_REQUIRED' : 'PLANNED';
}

/** @param {NormalizedRemoteCanaryConfigV1} config */
function redactedTopology(config) {
  return Object.freeze({
    nodeCount: config.nodes.length,
    nodes: Object.freeze(config.nodes.map((node) => Object.freeze({
      nodeRef: node.nodeRef,
      role: node.role,
      authentication: node.auth.kind,
    }))),
    contextGraphs: Object.freeze(config.contextGraphs.map((entry) => Object.freeze({
      contextGraphRef: entry.contextGraphRef,
      sourceNodeRef: entry.source.nodeRef,
      receiverNodeRef: entry.receiver.nodeRef,
      expectedMode: entry.expectedMode,
    }))),
  });
}
