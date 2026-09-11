// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';

import { ARTIFACT_SCHEMA, RemoteCanaryError, failure, opaqueRef } from './common.mjs';
import { verifyAuthorizationV1 } from './authorization.mjs';
import {
  createRemoteCanaryCohortRefV1,
  validateRemoteCanaryConfigV1,
} from './config.mjs';
import { preflightAllNodesV1 } from './preflight.mjs';
import { collectRpcUsageEvidenceV1 } from './rpc-evidence.mjs';
import {
  verifyCatalogSwmV1,
  verifyLiveSwmPropagationV1,
  verifyOfflineCatchupV1,
} from './swm.mjs';
import { createRequesterV1, runBoundedCommandV1 } from './transport.mjs';
import { verifyVmParityV1 } from './vm.mjs';

/** A network-free plan. It deliberately does not read auth or evidence files. */
export function createRemoteCanaryDryRunArtifactV1(config, now = () => new Date()) {
  const validated = validateRemoteCanaryConfigV1(config);
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
    plan: Object.freeze({
      preflight: 'exact-build-network-sync-and-catalog-mode',
      liveSwmPropagationChecks: validated.contextGraphs.length,
      offlineCatchup: validated.lifecycle === null ? 'EVIDENCE_REQUIRED' : 'PLANNED',
      vmParityChecks: validated.contextGraphs.length,
      catalogSwmEvidence: validated.contextGraphs.every((entry) => (
        entry.catalogSwmAskSparql !== undefined
      )) ? 'PLANNED' : 'EVIDENCE_REQUIRED',
      authorization: authorizationPlan(validated.authorizationChecks),
      rpcUsage: validated.rpcUsage.kind === 'required' ? 'EVIDENCE_REQUIRED' : 'PLANNED',
    }),
  });
}

/** Execute the ordered certification phases, parallelizing only independent checks. */
export async function executeRemoteCanaryCertificationV1(config, dependencies = {}) {
  const validated = validateRemoteCanaryConfigV1(config);
  const fetchFn = dependencies.fetchFn ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') throw failure('fetch-unavailable', 'config');
  const readFileFn = dependencies.readFileFn ?? readFile;
  const runCommand = dependencies.runCommand ?? runBoundedCommandV1;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? (() => new Date());
  const secrets = new Map();
  const nodeById = new Map(validated.nodes.map((node) => [node.id, node]));
  const nodeRefs = createNodeRefs(validated.nodes);
  const request = createRequesterV1({ fetchFn, readFileFn, secrets, timing: validated.timing });
  const startedAt = now().toISOString();
  const cohortRef = createRemoteCanaryCohortRefV1(validated);
  let phase = 'preflight';

  try {
    const preflightStatuses = await preflightAllNodesV1({
      config: validated,
      request,
      nodeRefs,
    });

    phase = 'live-swm-propagation';
    const liveSwmPropagation = await verifyLiveSwmPropagationV1({
      config: validated,
      nodeById,
      request,
      sleep,
    });

    phase = 'offline-catchup';
    const offlineCatchup = validated.lifecycle === null
      ? Object.freeze({ status: 'EVIDENCE_REQUIRED', requirement: 'single-receiver-stop-start' })
      : await verifyOfflineCatchupV1({
          config: validated,
          lifecycle: validated.lifecycle,
          nodeById,
          request,
          runCommand,
          sleep,
        });

    phase = 'vm-parity';
    const vmParity = await verifyVmParityV1({
      config: validated,
      nodeById,
      request,
      sleep,
    });

    phase = 'catalog-swm-evidence';
    const catalogSwm = await verifyCatalogSwmV1({
      config: validated,
      nodeById,
      request,
    });

    phase = 'authorization';
    const authorization = await verifyAuthorizationV1(
      validated.authorizationChecks,
      nodeById,
      request,
    );

    phase = 'rpc-usage';
    const rpcUsage = await collectRpcUsageEvidenceV1(validated.rpcUsage, {
      readFileFn,
      runCommand,
      startedAt,
      observedAt: now().toISOString(),
      expectedCommit: validated.expectedCommit,
      cohortRef,
    });

    const incomplete = offlineCatchup.status !== 'PASS'
      || vmParity.some((entry) => entry.status !== 'PASS')
      || catalogSwm.some((entry) => entry.status !== 'PASS')
      || authorization.unauthorized.status !== 'PASS'
      || authorization.revoked.status !== 'PASS'
      || rpcUsage.status !== 'PASS';
    return Object.freeze({
      schema: ARTIFACT_SCHEMA,
      status: incomplete ? 'INCOMPLETE' : 'PASS',
      phase: incomplete ? 'evidence-required' : 'complete',
      startedAt,
      finishedAt: now().toISOString(),
      expectedCommit: validated.expectedCommit,
      cohortRef,
      topology: redactedTopology(validated),
      preflight: Object.freeze({ status: 'PASS', nodes: preflightStatuses }),
      checks: Object.freeze({
        liveSwmPropagation: Object.freeze(liveSwmPropagation),
        offlineCatchup,
        vmParity: Object.freeze(vmParity),
        catalogSwm: Object.freeze(catalogSwm),
        authorization,
        rpcUsage,
      }),
    });
  } catch (error) {
    if (error instanceof RemoteCanaryError) throw error;
    throw failure('unexpected-execution-failure', phase, error);
  } finally {
    secrets.clear();
  }
}

function redactedTopology(config) {
  const refs = createNodeRefs(config.nodes);
  return Object.freeze({
    nodeCount: config.nodes.length,
    nodes: Object.freeze(config.nodes.map((node) => Object.freeze({
      nodeRef: refs.get(node.id),
      role: node.role,
      authentication: node.auth.kind,
    }))),
    contextGraphs: Object.freeze(config.contextGraphs.map((entry) => Object.freeze({
      contextGraphRef: opaqueRef('cg', entry.id),
      sourceNodeRef: refs.get(entry.sourceNodeId),
      receiverNodeRef: refs.get(entry.receiverNodeId),
      expectedMode: entry.expectedMode,
    }))),
  });
}

function authorizationPlan(checks) {
  return Object.freeze({
    unauthorized: checks.unauthorized.kind === 'http' ? 'PLANNED' : 'EVIDENCE_REQUIRED',
    revoked: checks.revoked.kind === 'http' ? 'PLANNED' : 'EVIDENCE_REQUIRED',
  });
}

function createNodeRefs(nodes) {
  return new Map(nodes.map((node) => [node.id, opaqueRef('node', node.id)]));
}
