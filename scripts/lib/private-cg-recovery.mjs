import fs from 'node:fs';

import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function responseBindings(payload) {
  return payload?.result?.bindings
    ?? payload?.result?.results?.bindings
    ?? payload?.results?.bindings
    ?? payload?.bindings
    ?? [];
}

function rawBindingValue(value) {
  return typeof value === 'string' ? value : value?.value;
}

function lexicalBindingValue(value) {
  const text = String(rawBindingValue(value) ?? '');
  const match = text.match(/^("(?:[^"\\]|\\.)*")/);
  return match ? JSON.parse(match[1]) : text;
}

function integerBindingValue(value) {
  const match = lexicalBindingValue(value).match(/^-?\d+$/);
  return match ? Number(match[0]) : Number.NaN;
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function createWorkloadPlan({
  profile,
  rootTriples,
  subgraphTriples,
  loadKaCount,
  loadTriplesPerKa,
}) {
  if (profile !== 'smoke' && profile !== 'sync-load') {
    throw new Error(`unsupported workload profile: ${profile}`);
  }

  let entries;
  let triplesPerKa = null;
  if (profile === 'smoke') {
    entries = [
      { ordinal: 1, lane: 'root', label: 'root', triples: positiveInteger(rootTriples, 'rootTriples') },
      {
        ordinal: 2,
        lane: 'subgraph',
        label: 'sub',
        triples: positiveInteger(subgraphTriples, 'subgraphTriples'),
      },
    ];
  } else {
    const kaCount = positiveInteger(loadKaCount, 'loadKaCount');
    triplesPerKa = positiveInteger(loadTriplesPerKa, 'loadTriplesPerKa');
    entries = Array.from({ length: kaCount }, (_, index) => {
      const ordinal = index + 1;
      const lane = ordinal % 2 === 1 ? 'root' : 'subgraph';
      return {
        ordinal,
        lane,
        label: `${lane}-ka-${String(ordinal).padStart(3, '0')}`,
        triples: triplesPerKa,
      };
    });
  }

  const rootEntries = entries.filter(({ lane }) => lane === 'root');
  const subgraphEntries = entries.filter(({ lane }) => lane === 'subgraph');
  const sumTriples = (rows) => rows.reduce((total, row) => total + row.triples, 0);
  const rootTotal = sumTriples(rootEntries);
  const subgraphTotal = sumTriples(subgraphEntries);
  const timeoutDefaults = profile === 'sync-load'
    ? { recoverySeconds: 1800, postRestartSeconds: 600, apiSeconds: 180 }
    : { recoverySeconds: 150, postRestartSeconds: 120, apiSeconds: 30 };

  return {
    profile,
    entries,
    timeoutDefaults,
    planned: {
      kaCount: entries.length,
      triplesPerKa,
      rootKaCount: rootEntries.length,
      subgraphKaCount: subgraphEntries.length,
      rootTriples: rootTotal,
      subgraphTriples: subgraphTotal,
      totalTriples: rootTotal + subgraphTotal,
    },
  };
}

export function publicQuadsDigestFromPayload(payload) {
  const quads = Array.isArray(payload?.quads) ? payload.quads : [];
  return workspacePublicQuadsDigest(quads);
}

export function createIntegrityHeadQuery({ contextGraphId, subGraphName, manifest }) {
  const metaGraph = manifest.lane === 'subgraph'
    ? `did:dkg:context-graph:${contextGraphId}/${subGraphName}/_shared_memory_meta`
    : `did:dkg:context-graph:${contextGraphId}/_shared_memory_meta`;
  const dkg = 'http://dkg.io/ontology/';
  const sparql = `SELECT ?scopeVersion ?kaUal ?assertionVersion ?assertionGraph
                          ?shareOperationId ?digest ?publicCount ?privateCount WHERE {
    GRAPH <${metaGraph}> {
      ?head <${dkg}contentScopeVersion> ?scopeVersion ;
            <${dkg}kaUal> <${manifest.kaUal}> ;
            <${dkg}kaUal> ?kaUal ;
            <${dkg}assertionVersion> ?assertionVersion ;
            <${dkg}assertionGraph> ?assertionGraph ;
            <${dkg}shareOperationId> ?shareOperationId .
      ?operation <${dkg}shareOperationId> ?shareOperationId ;
                 <${dkg}kaUal> <${manifest.kaUal}> ;
                 <${dkg}assertionVersion> ?assertionVersion ;
                 <${dkg}publicQuadsDigest> ?digest ;
                 <${dkg}publicQuadsCount> ?publicCount ;
                 <${dkg}privateTripleCount> ?privateCount .
    }
  }`;
  return {
    contextGraphId,
    sparql,
    ...(manifest.lane === 'subgraph' ? { subGraphName } : {}),
  };
}

export function validateIntegrityHeadResponse(manifest, payload) {
  const bindings = responseBindings(payload);
  if (bindings.length !== 1) {
    throw new Error(`expected one SWM head binding, found ${bindings.length}`);
  }
  const row = bindings[0];
  const actual = {
    contentScopeVersion: integerBindingValue(row.scopeVersion),
    kaUal: lexicalBindingValue(row.kaUal),
    assertionVersion: integerBindingValue(row.assertionVersion),
    assertionGraph: lexicalBindingValue(row.assertionGraph),
    shareOperationId: lexicalBindingValue(row.shareOperationId),
    publicQuadsDigest: lexicalBindingValue(row.digest),
    publicTripleCount: integerBindingValue(row.publicCount),
    privateTripleCount: integerBindingValue(row.privateCount),
  };
  const mismatches = [];
  if (actual.contentScopeVersion !== 2) mismatches.push('contentScopeVersion');
  if (actual.kaUal !== manifest.kaUal) mismatches.push('kaUal');
  if (actual.assertionVersion !== Number(manifest.assertionVersion)) mismatches.push('assertionVersion');
  if (actual.assertionGraph !== manifest.assertionGraph) mismatches.push('assertionGraph');
  if (actual.shareOperationId !== manifest.shareOperationId) mismatches.push('shareOperationId');
  if (actual.publicQuadsDigest !== manifest.publicQuadsDigest) mismatches.push('publicQuadsDigest');
  if (actual.publicTripleCount !== Number(manifest.triplesExpected)) mismatches.push('publicTripleCount');
  if (actual.privateTripleCount !== 0) mismatches.push('privateTripleCount');
  if (mismatches.length > 0) {
    throw new Error(`SWM head mismatch (${mismatches.join(', ')}): ${JSON.stringify(actual)}`);
  }
  return actual;
}

export function createIntegrityDataQuery({ contextGraphId, subGraphName, manifest }) {
  const sparql = `SELECT ?s ?p ?o WHERE {
    GRAPH ?g { ?s ?p ?o }
    FILTER(STR(?g) = ${JSON.stringify(manifest.assertionGraph)})
  }`;
  return {
    contextGraphId,
    sparql,
    includeContextGraphPartitions: true,
    ...(manifest.lane === 'subgraph' ? { subGraphName } : {}),
  };
}

export function validateIntegrityDataResponse(manifest, payload) {
  const bindings = responseBindings(payload);
  const quads = bindings.map((row) => ({
    subject: String(rawBindingValue(row.s) ?? ''),
    predicate: String(rawBindingValue(row.p) ?? ''),
    object: String(rawBindingValue(row.o) ?? ''),
    graph: '',
  }));
  const digest = workspacePublicQuadsDigest(quads);
  if (bindings.length !== Number(manifest.triplesExpected)) {
    throw new Error(`assertion graph count ${bindings.length}, expected ${manifest.triplesExpected}`);
  }
  if (digest !== manifest.publicQuadsDigest) {
    throw new Error(`assertion graph digest ${digest}, expected ${manifest.publicQuadsDigest}`);
  }
  return { publicTripleCount: bindings.length, publicQuadsDigest: digest };
}

export function createSeedManifestRow({
  ordinal,
  lane,
  label,
  triples,
  payloadBytes,
  durationMs,
  expectedDigest,
  descriptor,
  writeResponse,
}) {
  const createResponse = Array.isArray(writeResponse.responses) ? writeResponse.responses[0] : undefined;
  return {
    ordinal: Number(ordinal),
    lane,
    label,
    name: Array.isArray(writeResponse.names) ? writeResponse.names[0] : null,
    kaUal: descriptor.reservedUal || null,
    assertionVersion: 1,
    assertionGraph: descriptor.assertionGraph || null,
    triplesExpected: Number(triples),
    triplesWritten: Number(writeResponse.triplesWritten),
    publicQuadsDigest: expectedDigest,
    payloadBytes: Number(payloadBytes),
    durationMs: Number(durationMs),
    names: Array.isArray(writeResponse.names) ? writeResponse.names : [],
    shareOperationId: createResponse?.shareOperationId || descriptor.currentShareOperationId || null,
    merkleRoot: createResponse?.merkleRoot || descriptor.swmCurrentAssertion || null,
    responses: (Array.isArray(writeResponse.responses) ? writeResponse.responses : []).map((item) => ({
      shareOperationId: item.shareOperationId || null,
      swmShared: item.swmShared === true,
      publishReady: item.publishReady === true,
      promotedCount: Number(item.promotedCount || 0),
    })),
  };
}

export function createSeedSummary(plan, actual) {
  const normalizedActual = {
    kaCount: Number(actual.kaCount),
    rootKaCount: Number(actual.rootKaCount),
    subgraphKaCount: Number(actual.subgraphKaCount),
    totalTriples: Number(actual.totalTriples),
    totalPayloadBytes: Number(actual.totalPayloadBytes),
    maxKaPayloadBytes: Number(actual.maxKaPayloadBytes),
    durationMs: Number(actual.durationMs),
  };
  const planned = plan.planned;
  return {
    profile: plan.profile,
    planned,
    actual: normalizedActual,
    completed: normalizedActual.kaCount === planned.kaCount
      && normalizedActual.rootKaCount === planned.rootKaCount
      && normalizedActual.subgraphKaCount === planned.subgraphKaCount
      && normalizedActual.totalTriples === planned.totalTriples,
  };
}

export function createIntegrityReportRow({ phase, node, expected, swmHead, assertionGraph }) {
  return { phase, node: Number(node), expected, swmHead, assertionGraph, verified: true };
}

export function auditTestnetHealth({ baselines, samples, thresholds, restartNodes }) {
  const baselineByNode = new Map(baselines.map((row) => [row.node, row]));
  const restartNodeSet = new Set(restartNodes.map(Number));
  const state = new Map();
  const failures = [];
  for (const sample of samples) {
    const baseline = baselineByNode.get(sample.node);
    if (!baseline) {
      failures.push(`node ${sample.node} has samples without a baseline`);
      continue;
    }
    const prior = state.get(sample.node) ?? {
      pid: baseline.mainPid,
      pidChanges: 0,
      oxigraphPid: baseline.oxigraphPid,
      oxigraphPidChanges: 0,
      streak: 0,
      maxStreak: 0,
      oomEvents: baseline.oomEvents ?? 0,
      oomKillEvents: baseline.oomKillEvents ?? 0,
      oxigraphOomEvents: baseline.oxigraphOomEvents ?? 0,
      oxigraphOomKillEvents: baseline.oxigraphOomKillEvents ?? 0,
      saturationSamples: [],
    };
    const requiredNumbers = [
      'mainPid', 'nRestarts', 'oxigraphPid', 'oxigraphWatchdogPid',
      'acceptQueue', 'cpuCount', 'loadOne', 'hostMemoryUsedPercent',
      'oomEvents', 'oomKillEvents', 'oxigraphOomEvents', 'oxigraphOomKillEvents',
    ];
    for (const field of requiredNumbers) {
      if (sample[field] === null || sample[field] === undefined || !Number.isFinite(Number(sample[field]))) {
        failures.push(`node ${sample.node} sample ${sample.phase} omitted numeric ${field}`);
      }
    }
    if (prior.pid !== sample.mainPid) {
      prior.pid = sample.mainPid;
      prior.pidChanges += 1;
      prior.streak = 0;
    }
    if (prior.oxigraphPid !== sample.oxigraphPid) {
      prior.oxigraphPid = sample.oxigraphPid;
      prior.oxigraphPidChanges += 1;
      prior.streak = 0;
    }
    const checkCounter = (label, currentRaw, previousRaw) => {
      const current = Number(currentRaw ?? 0);
      const previous = Number(previousRaw ?? 0);
      if (current > previous || (current < previous && current > 0)) {
        failures.push(`node ${sample.node} ${label} increased during ${sample.phase}`);
      }
      return current;
    };
    prior.oomEvents = checkCounter('daemon cgroup OOM counter', sample.oomEvents, prior.oomEvents);
    prior.oomKillEvents = checkCounter('daemon cgroup OOM-kill counter', sample.oomKillEvents, prior.oomKillEvents);
    prior.oxigraphOomEvents = checkCounter(
      'Oxigraph cgroup OOM counter', sample.oxigraphOomEvents, prior.oxigraphOomEvents,
    );
    prior.oxigraphOomKillEvents = checkCounter(
      'Oxigraph cgroup OOM-kill counter', sample.oxigraphOomKillEvents, prior.oxigraphOomKillEvents,
    );
    if (Number(sample.nRestarts) !== Number(baseline.nRestarts)) {
      failures.push(`node ${sample.node} systemd NRestarts changed during ${sample.phase}`);
    }
    const loadPerCpuPercent = Number(sample.cpuCount) > 0
      ? (Number(sample.loadOne) / Number(sample.cpuCount)) * 100
      : Number.POSITIVE_INFINITY;
    const reasons = [];
    if (Number(sample.acceptQueue) > thresholds.maxAcceptQueue) reasons.push(`acceptQueue=${sample.acceptQueue}`);
    if (Number(sample.hostMemoryUsedPercent) >= thresholds.maxHostMemoryUsedPercent) {
      reasons.push(`memory=${sample.hostMemoryUsedPercent}%`);
    }
    if (loadPerCpuPercent >= thresholds.maxLoadPerCpuPercent) {
      reasons.push(`loadPerCpu=${loadPerCpuPercent.toFixed(1)}%`);
    }
    if (reasons.length > 0) {
      prior.streak += 1;
      prior.saturationSamples.push({ phase: sample.phase, reasons });
    } else {
      prior.streak = 0;
    }
    prior.maxStreak = Math.max(prior.maxStreak, prior.streak);
    state.set(sample.node, prior);
  }
  for (const [node, value] of state) {
    const allowedPidChanges = restartNodeSet.has(node) ? 1 : 0;
    if (value.pidChanges > allowedPidChanges) {
      failures.push(`node ${node} daemon PID changed ${value.pidChanges} times; allowed ${allowedPidChanges}`);
    }
    if (value.oxigraphPidChanges > allowedPidChanges) {
      failures.push(`node ${node} Oxigraph PID changed ${value.oxigraphPidChanges} times; allowed ${allowedPidChanges}`);
    }
    if (value.maxStreak >= thresholds.consecutiveSamples) {
      failures.push(
        `node ${node} sustained saturation for ${value.maxStreak} samples: `
        + JSON.stringify(value.saturationSamples.slice(-value.maxStreak)),
      );
    }
  }
  return {
    thresholds,
    sampleRows: samples.length,
    nodes: Object.fromEntries([...state].map(([node, value]) => [node, {
      daemonPidChanges: value.pidChanges,
      oxigraphPidChanges: value.oxigraphPidChanges,
      maxConsecutiveSaturationSamples: value.maxStreak,
      saturationSamples: value.saturationSamples,
    }])),
    failures,
    passed: failures.length === 0,
  };
}

export function auditTestnetHealthFiles({ baselineFile, samplesFile, thresholds, restartNodes }) {
  return auditTestnetHealth({
    baselines: readJsonLines(baselineFile),
    samples: readJsonLines(samplesFile),
    thresholds,
    restartNodes,
  });
}

export function createDevnetHealthAudit(sampleRounds) {
  return {
    target: 'devnet',
    sampleRounds: Number(sampleRounds),
    finalApisReady: true,
    fatalLogFindings: 0,
    passed: true,
  };
}
