// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';

import { failure } from './errors.mjs';
import {
  isRetryableNodeRequestErrorV1,
  mapCanaryPhaseV1,
  pollUntilV1,
} from './phase-helpers.mjs';
import { validateNodePreflightV1 } from './preflight.mjs';
import { askConfiguredQueryV1 } from './query.mjs';
import { opaqueRef } from './references.mjs';

const REQUIRED_OFFLINE_PROBES = 3;

function createMarker() {
  const nonce = randomUUID();
  return Object.freeze({
    assetName: `rfc64-canary-${nonce}`,
    subject: `urn:dkg:rfc64-canary:${nonce}`,
    predicate: 'https://schema.origintrail.io/rfc64/canaryValue',
    value: nonce,
  });
}

export function verifyLiveSwmPropagationV1({ config, request, sleep }) {
  return mapCanaryPhaseV1(config.contextGraphs, async (contextGraph) => {
    const marker = createMarker();
    await shareMarkerV1(
      contextGraph.source,
      contextGraph.id,
      marker,
      request,
      'live-swm-propagation',
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
      () => failure('swm-propagation-timeout', 'live-swm-propagation'),
      { retryError: isRetryableNodeRequestErrorV1 },
    );
    return Object.freeze({
      contextGraphRef: contextGraph.contextGraphRef,
      markerRef: opaqueRef('marker', marker.subject),
      status: 'PASS',
    });
  });
}

export async function verifyOfflineCatchupV1({
  config,
  lifecycle,
  request,
  runCommand,
  sleep,
}) {
  const receiver = lifecycle.receiver;
  let stopInvoked = false;
  let primaryFailure = null;
  let startFailure = null;
  let markers = [];
  try {
    stopInvoked = true;
    const stopped = await runCommand(lifecycle.stop, lifecycle.commandTimeoutMs);
    if (stopped.code !== 0) throw failure('receiver-stop-command-failed', 'offline-catchup');
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
      () => failure('receiver-did-not-stop', 'offline-catchup'),
    );
    markers = await mapCanaryPhaseV1(config.contextGraphs, async (contextGraph) => {
      await assertReceiverOfflineV1(receiver, request);
      const marker = createMarker();
      await shareMarkerV1(
        contextGraph.source,
        contextGraph.id,
        marker,
        request,
        'offline-catchup',
      );
      await assertReceiverOfflineV1(receiver, request);
      return [contextGraph, marker];
    });
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (stopInvoked) {
      const started = await runCommand(lifecycle.start, lifecycle.commandTimeoutMs).catch(() => null);
      if (started === null || started.code !== 0) {
        startFailure = failure('receiver-start-command-failed', 'offline-catchup');
      }
    }
  }
  if (startFailure !== null) {
    throw primaryFailure === null
      ? startFailure
      : failure(
          'receiver-start-command-failed',
          'offline-catchup',
          new AggregateError([primaryFailure, startFailure], 'receiver-recovery-failed'),
        );
  }
  if (primaryFailure !== null) throw primaryFailure;

  await pollUntilV1(
    async () => {
      const status = await request.json(receiver, 'GET', '/api/status');
      validateNodePreflightV1(status, receiver, config);
      return true;
    },
    lifecycle.readyTimeoutMs,
    config.timing.pollIntervalMs,
    sleep,
    () => failure('receiver-did-not-recover', 'offline-catchup'),
    { retryError: isRetryableNodeRequestErrorV1 },
  );

  const evidence = await mapCanaryPhaseV1(markers, async ([contextGraph, marker]) => {
    await pollUntilV1(
      async () => askMarkerV1(receiver, contextGraph.id, marker, 'shared-working-memory', request),
      config.timing.catchupTimeoutMs,
      config.timing.pollIntervalMs,
      sleep,
      () => failure('offline-catchup-timeout', 'offline-catchup'),
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
      throw failure('catalog-swm-query-failed', 'catalog-swm-evidence');
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

async function shareMarkerV1(node, contextGraphId, marker, request, phase) {
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
  if (result.swmShared !== true) throw failure('swm-share-not-confirmed', phase);
}

async function assertReceiverOfflineV1(receiver, request) {
  if (await request.reachable(receiver)) {
    throw failure('receiver-became-reachable-during-offline-window', 'offline-catchup');
  }
}

async function askMarkerV1(node, contextGraphId, marker, view, request) {
  const result = await request.json(node, 'POST', '/api/query', {
    sparql: `ASK { <${marker.subject}> <${marker.predicate}> ${JSON.stringify(marker.value)} . }`,
    contextGraphId,
    view,
  });
  return result.result?.type === 'boolean' && result.result.value === true;
}
