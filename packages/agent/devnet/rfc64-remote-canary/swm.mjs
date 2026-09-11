// SPDX-License-Identifier: Apache-2.0

import { createMarker, failure, opaqueRef } from './common.mjs';
import { mapCanaryPhaseV1, pollUntilV1 } from './phase-helpers.mjs';
import { validateNodePreflightV1 } from './preflight.mjs';

export function verifyLiveSwmPropagationV1({ config, nodeById, request, sleep }) {
  return mapCanaryPhaseV1(config.contextGraphs, async (contextGraph) => {
    const marker = createMarker();
    const source = nodeById.get(contextGraph.sourceNodeId);
    const receiver = nodeById.get(contextGraph.receiverNodeId);
    await shareMarkerV1(source, contextGraph.id, marker, request, 'live-swm-propagation');
    await pollUntilV1(
      async () => askMarkerV1(receiver, contextGraph.id, marker, 'shared-working-memory', request),
      config.timing.propagationTimeoutMs,
      config.timing.pollIntervalMs,
      sleep,
      () => failure('swm-propagation-timeout', 'live-swm-propagation'),
    );
    return Object.freeze({
      contextGraphRef: opaqueRef('cg', contextGraph.id),
      markerRef: opaqueRef('marker', marker.subject),
      status: 'PASS',
    });
  });
}

export async function verifyOfflineCatchupV1({
  config,
  lifecycle,
  nodeById,
  request,
  runCommand,
  sleep,
}) {
  const receiver = nodeById.get(lifecycle.receiverNodeId);
  let stopInvoked = false;
  let primaryFailure = null;
  let startFailure = null;
  let markers = [];
  try {
    stopInvoked = true;
    const stopped = await runCommand(lifecycle.stop, lifecycle.commandTimeoutMs);
    if (stopped.code !== 0) throw failure('receiver-stop-command-failed', 'offline-catchup');
    await pollUntilV1(
      async () => !(await request.reachable(receiver)),
      lifecycle.stopTimeoutMs,
      config.timing.pollIntervalMs,
      sleep,
      () => failure('receiver-did-not-stop', 'offline-catchup'),
    );
    markers = await mapCanaryPhaseV1(config.contextGraphs, async (contextGraph) => {
      const marker = createMarker();
      await shareMarkerV1(
        nodeById.get(contextGraph.sourceNodeId),
        contextGraph.id,
        marker,
        request,
        'offline-catchup',
      );
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
      try {
        const status = await request.json(receiver, 'GET', '/api/status');
        validateNodePreflightV1(status, receiver, config);
        return true;
      } catch {
        return false;
      }
    },
    lifecycle.readyTimeoutMs,
    config.timing.pollIntervalMs,
    sleep,
    () => failure('receiver-did-not-recover', 'offline-catchup'),
  );

  const evidence = await mapCanaryPhaseV1(markers, async ([contextGraph, marker]) => {
    await pollUntilV1(
      async () => askMarkerV1(receiver, contextGraph.id, marker, 'shared-working-memory', request),
      config.timing.catchupTimeoutMs,
      config.timing.pollIntervalMs,
      sleep,
      () => failure('offline-catchup-timeout', 'offline-catchup'),
    );
    return Object.freeze({
      contextGraphRef: opaqueRef('cg', contextGraph.id),
      markerRef: opaqueRef('marker', marker.subject),
      status: 'PASS',
    });
  });
  return Object.freeze({ status: 'PASS', receiverCount: 1, contextGraphs: evidence });
}

export function verifyCatalogSwmV1({ config, nodeById, request }) {
  return mapCanaryPhaseV1(config.contextGraphs, async (contextGraph) => {
    if (contextGraph.catalogSwmAskSparql === undefined) {
      return Object.freeze({
        contextGraphRef: opaqueRef('cg', contextGraph.id),
        status: 'EVIDENCE_REQUIRED',
        requirement: 'known-catalog-swm-ask-query',
        queryChecked: false,
      });
    }
    const source = nodeById.get(contextGraph.sourceNodeId);
    const receiver = nodeById.get(contextGraph.receiverNodeId);
    const [sourceQueryPassed, receiverQueryPassed] = await Promise.all([
      askConfiguredQueryV1(
        source,
        contextGraph,
        contextGraph.catalogSwmAskSparql,
        'shared-working-memory',
        request,
      ),
      askConfiguredQueryV1(
        receiver,
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
      contextGraphRef: opaqueRef('cg', contextGraph.id),
      status: 'PASS',
      queryChecked: true,
      sourceQueryPassed,
      receiverQueryPassed,
    });
  });
}

export async function askConfiguredQueryV1(node, contextGraph, sparql, view, request) {
  const result = await request.json(node, 'POST', '/api/query', {
    sparql,
    contextGraphId: contextGraph.id,
    view,
  });
  return result.result?.type === 'boolean' && result.result.value === true;
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

async function askMarkerV1(node, contextGraphId, marker, view, request) {
  const result = await request.json(node, 'POST', '/api/query', {
    sparql: `ASK { <${marker.subject}> <${marker.predicate}> ${JSON.stringify(marker.value)} . }`,
    contextGraphId,
    view,
  });
  return result.result?.type === 'boolean' && result.result.value === true;
}
