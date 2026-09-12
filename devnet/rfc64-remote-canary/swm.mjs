// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';

import {
  CANARY_PREDICATE,
  CANARY_SUBJECT_PREFIX,
} from './canary-vocabulary.mjs';
import { RemoteCanaryError, failure } from './errors.mjs';
import {
  isRetryableNodeRequestErrorV1,
  mapCanaryPhaseDrainedV1,
  mapCanaryPhaseV1,
  pollUntilV1,
} from './phase-helpers.mjs';
import { validateNodePreflightV1 } from './preflight.mjs';
import { askConfiguredQueryV1 } from './query.mjs';
import { opaqueRef } from './references.mjs';

/** @typedef {import('./domain-contract.js').CanaryCommandResultV1} CanaryCommandResultV1 */
/** @typedef {import('./domain-contract.js').CanaryRequesterV1} CanaryRequesterV1 */
/** @typedef {import('./domain-contract.js').NormalizedCanaryLifecycleV1} NormalizedCanaryLifecycleV1 */
/** @typedef {import('./domain-contract.js').NormalizedCanaryNodeV1} NormalizedCanaryNodeV1 */
/** @typedef {import('./domain-contract.js').NormalizedRemoteCanaryConfigV1} NormalizedRemoteCanaryConfigV1 */
/** @typedef {Readonly<{ assetName: string, subject: string, predicate: string, value: string }>} CanaryMarkerV1 */
/** @typedef {(command: import('./domain-contract.js').CanaryCommandV1, timeoutMs?: number) => Promise<CanaryCommandResultV1>} RunCommandV1 */
/** @typedef {(milliseconds: number) => Promise<void>} SleepV1 */
/** @typedef {Readonly<{ config: NormalizedRemoteCanaryConfigV1, request: CanaryRequesterV1, sleep: SleepV1 }>} SwmInputV1 */
/** @typedef {Readonly<{ config: NormalizedRemoteCanaryConfigV1, lifecycle: NormalizedCanaryLifecycleV1, request: CanaryRequesterV1, runCommand: RunCommandV1, sleep: SleepV1 }>} OfflineInputV1 */

const REQUIRED_OFFLINE_PROBES = 3;

/** @returns {CanaryMarkerV1} */
function createMarker() {
  const nonce = randomUUID();
  return Object.freeze({
    assetName: `rfc64-canary-${nonce}`,
    subject: `${CANARY_SUBJECT_PREFIX}${nonce}`,
    predicate: CANARY_PREDICATE,
    value: nonce,
  });
}

/** @param {SwmInputV1} input */
export function verifyLiveSwmPropagationV1({ config, request, sleep }) {
  return mapCanaryPhaseV1(config.contextGraphs, async (contextGraph) => {
    const marker = createMarker();
    await shareMarkerV1(
      contextGraph.source,
      contextGraph.id,
      marker,
      request,
    );
    await pollUntilV1(
      async () => askMarkerV1(
        contextGraph.receiver,
        contextGraph.id,
        marker,
        'shared-working-memory',
        request,
      ),
      config.timing.propagationTimeoutMs,
      config.timing.pollIntervalMs,
      sleep,
      () => failure('swm-propagation-timeout', 'swm'),
      { retryError: isRetryableNodeRequestErrorV1 },
    );
    return Object.freeze({
      contextGraphRef: contextGraph.contextGraphRef,
      markerRef: opaqueRef('marker', marker.subject),
      status: 'PASS',
    });
  });
}

/** @param {OfflineInputV1} input */
export async function verifyOfflineCatchupV1({
  config,
  lifecycle,
  request,
  runCommand,
  sleep,
}) {
  const markers = await withReceiverOfflineV1({
    config,
    lifecycle,
    request,
    runCommand,
    sleep,
  }, () => mapCanaryPhaseDrainedV1(config.contextGraphs, async (contextGraph) => {
    await assertReceiverOfflineV1(lifecycle.receiver, request);
    const marker = createMarker();
    await shareMarkerV1(
      contextGraph.source,
      contextGraph.id,
      marker,
      request,
    );
    await assertReceiverOfflineV1(lifecycle.receiver, request);
    return /** @type {const} */ ([contextGraph, marker]);
  }));

  const evidence = await mapCanaryPhaseV1(markers, async ([contextGraph, marker]) => {
    await pollUntilV1(
      async () => askMarkerV1(
        lifecycle.receiver,
        contextGraph.id,
        marker,
        'shared-working-memory',
        request,
      ),
      config.timing.catchupTimeoutMs,
      config.timing.pollIntervalMs,
      sleep,
      () => failure('offline-catchup-timeout', 'swm'),
      { retryError: isRetryableNodeRequestErrorV1 },
    );
    return Object.freeze({
      contextGraphRef: contextGraph.contextGraphRef,
      markerRef: opaqueRef('marker', marker.subject),
      status: 'PASS',
    });
  });
  return Object.freeze({ status: 'PASS', receiverCount: 1, contextGraphs: evidence });
}

/** Own the receiver lifecycle boundary independently of catch-up evidence. */
/**
 * @template Result
 * @param {OfflineInputV1} input
 * @param {() => Result | Promise<Result>} operation
 * @returns {Promise<Result>}
 */
export async function withReceiverOfflineV1({
  config,
  lifecycle,
  request,
  runCommand,
  sleep,
}, operation) {
  const receiver = lifecycle.receiver;
  let stopInvoked = false;
  let operationResult;
  let operationFailure = null;
  try {
    stopInvoked = true;
    const stopped = await runCommand(lifecycle.stop, lifecycle.commandTimeoutMs);
    if (stopped.code !== 0) throw failure('receiver-stop-command-failed', 'lifecycle');
    let consecutiveOfflineProbes = 0;
    const offlineProbeIntervalMs = Math.min(
      config.timing.pollIntervalMs,
      Math.max(1, Math.floor(lifecycle.stopTimeoutMs / REQUIRED_OFFLINE_PROBES)),
    );
    await pollUntilV1(
      async () => {
        if (await request.reachable(receiver)) {
          consecutiveOfflineProbes = 0;
          return false;
        }
        consecutiveOfflineProbes += 1;
        return consecutiveOfflineProbes >= REQUIRED_OFFLINE_PROBES;
      },
      lifecycle.stopTimeoutMs,
      offlineProbeIntervalMs,
      sleep,
      () => failure('receiver-did-not-stop', 'lifecycle'),
    );
    operationResult = await operation();
  } catch (error) {
    operationFailure = error;
  }
  let startFailure = null;
  if (stopInvoked) {
    try {
      const started = await runCommand(lifecycle.start, lifecycle.commandTimeoutMs);
      if (started.code !== 0) {
        startFailure = failure('receiver-start-command-failed', 'lifecycle');
      }
    } catch (error) {
      startFailure = failure('receiver-start-command-failed', 'lifecycle', error);
    }
  }
  if (startFailure !== null) {
    if (operationFailure === null) throw startFailure;
    throw failure(
      'receiver-start-command-failed',
      'lifecycle',
      new AggregateError([operationFailure, startFailure], 'receiver-recovery-failed'),
    );
  }
  if (operationFailure !== null) throw operationFailure;

  await pollUntilV1(
    async () => {
      const status = await request.json(receiver, 'GET', '/api/status');
      validateNodePreflightV1(status, receiver, config);
      return true;
    },
    lifecycle.readyTimeoutMs,
    config.timing.pollIntervalMs,
    sleep,
    () => failure('receiver-did-not-recover', 'lifecycle'),
    { retryError: isRetryableRecoveryReadinessErrorV1 },
  );
  return /** @type {Result} */ (operationResult);
}

/** @param {unknown} error @returns {boolean} */
function isRetryableRecoveryReadinessErrorV1(error) {
  return isRetryableNodeRequestErrorV1(error)
    || (error instanceof RemoteCanaryError && [
      'rfc64-operational-mode-missing',
      'rfc64-catalog-service-not-started',
      'rfc64-operational-incomplete',
    ].includes(error.code));
}

/** @param {Pick<SwmInputV1, 'config' | 'request'>} input */
export function verifyCatalogSwmV1({ config, request }) {
  return mapCanaryPhaseV1(config.contextGraphs, async (contextGraph) => {
    if (contextGraph.catalogSwmAskSparql === undefined) {
      return Object.freeze({
        contextGraphRef: contextGraph.contextGraphRef,
        status: 'EVIDENCE_REQUIRED',
        requirement: 'known-catalog-swm-ask-query',
        queryChecked: false,
      });
    }
    const [sourceQueryPassed, receiverQueryPassed] = await Promise.all([
      askConfiguredQueryV1(
        contextGraph.source,
        contextGraph,
        contextGraph.catalogSwmAskSparql,
        'shared-working-memory',
        request,
      ),
      askConfiguredQueryV1(
        contextGraph.receiver,
        contextGraph,
        contextGraph.catalogSwmAskSparql,
        'shared-working-memory',
        request,
      ),
    ]);
    if (!sourceQueryPassed || !receiverQueryPassed) {
      throw failure('catalog-swm-query-failed', 'swm');
    }
    return Object.freeze({
      contextGraphRef: contextGraph.contextGraphRef,
      status: 'PASS',
      queryChecked: true,
      sourceQueryPassed,
      receiverQueryPassed,
    });
  });
}

/**
 * @param {NormalizedCanaryNodeV1} node
 * @param {string} contextGraphId
 * @param {CanaryMarkerV1} marker
 * @param {CanaryRequesterV1} request
 */
async function shareMarkerV1(node, contextGraphId, marker, request) {
  const result = await request.json(node, 'POST', '/api/knowledge-assets', {
    contextGraphId,
    name: marker.assetName,
    quads: [{
      subject: marker.subject,
      predicate: marker.predicate,
      object: JSON.stringify(marker.value),
    }],
    alsoShareSwm: true,
  });
  if (
    result === null
    || typeof result !== 'object'
    || Array.isArray(result)
    || /** @type {Record<string, unknown>} */ (result).swmShared !== true
  ) throw failure('swm-share-not-confirmed', 'swm');
}

/** @param {NormalizedCanaryNodeV1} receiver @param {CanaryRequesterV1} request */
async function assertReceiverOfflineV1(receiver, request) {
  if (await request.reachable(receiver)) {
    throw failure('receiver-became-reachable-during-offline-window', 'lifecycle');
  }
}

/**
 * @param {NormalizedCanaryNodeV1} node
 * @param {string} contextGraphId
 * @param {CanaryMarkerV1} marker
 * @param {'shared-working-memory'} view
 * @param {CanaryRequesterV1} request
 */
async function askMarkerV1(node, contextGraphId, marker, view, request) {
  const result = await request.json(node, 'POST', '/api/query', {
    sparql: `ASK { <${marker.subject}> <${marker.predicate}> ${JSON.stringify(marker.value)} . }`,
    contextGraphId,
    view,
  });
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false;
  const queryResult = /** @type {Record<string, unknown>} */ (result).result;
  return queryResult !== null
    && typeof queryResult === 'object'
    && !Array.isArray(queryResult)
    && /** @type {Record<string, unknown>} */ (queryResult).type === 'boolean'
    && /** @type {Record<string, unknown>} */ (queryResult).value === true;
}
