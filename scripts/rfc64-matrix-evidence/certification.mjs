const IDENTITY_FIELDS = Object.freeze([
  'lane',
  'index',
  'name',
  'subject',
  'tripleCount',
  'expectedDigest',
]);

const RECOVERY_EVIDENCE_FIELDS = Object.freeze([
  'sentinel',
  'swmShared',
  'swmReadbackPassed',
  'swmSharedAt',
  'finalized',
  'readbackPassed',
  'actions',
  'chainAlreadyMinted',
  'ual',
  'kaId',
  'txHash',
  'blockNumber',
  'merkleRoot',
  'storageAckPeerIds',
  'finalStatus',
  'finalMemoryLayer',
  'readback',
  'startedAt',
  'completedAt',
  'shareDurationMs',
  'publishDurationMs',
  'vmReadbackDurationMs',
  'durationMs',
  'error',
]);

function fail(message) {
  throw new Error(`RFC-64 matrix evidence rejected: ${message}`);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
}

function snapshotLaneBindings(manifest) {
  if (!manifest?.lanes || typeof manifest.lanes !== 'object' || Array.isArray(manifest.lanes)) {
    fail('manifest lanes must be an object');
  }
  return Object.fromEntries(Object.entries(manifest.lanes).map(([lane, config]) => [
    requireNonEmptyString(lane, 'lane name'),
    requireNonEmptyString(config?.contextGraphId, `manifest lane ${lane} contextGraphId`),
  ]));
}

function evidenceKey(contextGraphId, subject) {
  return `${contextGraphId}\0${subject}`;
}

function snapshotManifest(manifest) {
  const runId = requireNonEmptyString(manifest?.runId, 'manifest runId');
  const datasetDigest = requireNonEmptyString(manifest?.datasetDigest, 'manifest datasetDigest');
  if (!Array.isArray(manifest?.assets)) fail('manifest assets must be an array');

  const laneBindings = snapshotLaneBindings(manifest);
  const byEvidenceKey = new Map();
  const byLaneIndex = new Map();
  for (const asset of manifest.assets) {
    const lane = requireNonEmptyString(asset?.lane, 'asset lane');
    const contextGraphId = laneBindings[lane];
    if (!contextGraphId) fail(`asset references unknown lane ${lane}`);
    const index = requireNonNegativeInteger(asset?.index, `${lane} asset index`);
    const name = requireNonEmptyString(asset?.name, `${lane}:${index} asset name`);
    const subject = requireNonEmptyString(asset?.subject, `${lane}:${index} asset subject`);
    const tripleCount = requireNonNegativeInteger(
      asset?.tripleCount,
      `${lane}:${index} asset tripleCount`,
    );
    const expectedDigest = requireNonEmptyString(
      asset?.expectedDigest,
      `${lane}:${index} asset expectedDigest`,
    );
    const snapshot = {
      ...asset,
      lane,
      index,
      name,
      subject,
      tripleCount,
      expectedDigest,
      contextGraphId,
    };
    const boundKey = evidenceKey(contextGraphId, subject);
    const ordinalKey = `${lane}\0${index}`;
    if (byEvidenceKey.has(boundKey)) fail(`duplicate CG-bound asset ${contextGraphId} ${subject}`);
    if (byLaneIndex.has(ordinalKey)) fail(`duplicate asset ordinal ${lane}:${index}`);
    byEvidenceKey.set(boundKey, snapshot);
    byLaneIndex.set(ordinalKey, snapshot);
  }

  return {
    runId,
    datasetDigest,
    laneBindings,
    assets: manifest.assets,
    byEvidenceKey,
    byLaneIndex,
  };
}

function assertSame(value, expected, label, source) {
  if (value !== expected) {
    fail(`${source} ${label} differs from the source manifest`);
  }
}

function validateRecoveryHeader(header, manifest, source) {
  assertSame(header?.runId, manifest.runId, 'runId', source);
  assertSame(header?.datasetDigest, manifest.datasetDigest, 'datasetDigest', source);
  if (
    !header?.contextGraphBindings
    || typeof header.contextGraphBindings !== 'object'
    || Array.isArray(header.contextGraphBindings)
  ) {
    fail(`${source} recovery_start lacks contextGraphBindings`);
  }
  const expectedLanes = Object.keys(manifest.laneBindings).sort();
  const actualLanes = Object.keys(header.contextGraphBindings).sort();
  assertSame(JSON.stringify(actualLanes), JSON.stringify(expectedLanes), 'lane set', source);
  for (const lane of expectedLanes) {
    assertSame(
      header.contextGraphBindings[lane],
      manifest.laneBindings[lane],
      `context graph binding for ${lane}`,
      source,
    );
  }
}

function validateRecoveryResult(record, manifest, source) {
  assertSame(record?.runId, manifest.runId, 'runId', source);
  assertSame(record?.datasetDigest, manifest.datasetDigest, 'datasetDigest', source);
  const lane = requireNonEmptyString(record?.lane, `${source} recovery lane`);
  const contextGraphId = requireNonEmptyString(
    record?.contextGraphId,
    `${source} recovery contextGraphId`,
  );
  assertSame(
    contextGraphId,
    manifest.laneBindings[lane],
    `contextGraphId for ${lane}`,
    source,
  );

  const subject = requireNonEmptyString(record?.subject, `${source} recovery subject`);
  const asset = manifest.byEvidenceKey.get(evidenceKey(contextGraphId, subject));
  if (!asset) fail(`${source} recovery row does not identify a manifest asset`);
  for (const field of IDENTITY_FIELDS) {
    assertSame(record[field], asset[field], `asset ${field}`, source);
  }
  const ordinalAsset = manifest.byLaneIndex.get(`${lane}\0${record.index}`);
  if (ordinalAsset !== asset) fail(`${source} recovery ordinal resolves to a different asset`);
  return asset;
}

function recoveryScore(record) {
  return Number(record.finalized === true) * 2 + Number(record.readbackPassed === true);
}

function recoveryEvidence(record, source) {
  const evidence = {};
  for (const field of RECOVERY_EVIDENCE_FIELDS) {
    if (record[field] !== undefined) evidence[field] = record[field];
  }
  return {
    ...evidence,
    evidence: Array.isArray(record.actions) && record.actions.length > 0
      ? `recovery:${record.actions.join('+')}`
      : 'recovery:verified-existing',
    recoveryFile: source,
  };
}

export function createRecoveryStartEvidence(manifest, extra = {}) {
  const snapshot = snapshotManifest(manifest);
  return {
    ...extra,
    type: 'recovery_start',
    runId: snapshot.runId,
    datasetDigest: snapshot.datasetDigest,
    contextGraphBindings: { ...snapshot.laneBindings },
  };
}

export function createRecoveryResultEvidence(manifest, asset, evidence = {}) {
  const snapshot = snapshotManifest(manifest);
  const sourceAsset = snapshot.byLaneIndex.get(`${asset?.lane}\0${asset?.index}`);
  if (!sourceAsset) fail('recovery result references an unknown manifest asset');
  const result = {
    type: 'recovery_result',
    runId: snapshot.runId,
    datasetDigest: snapshot.datasetDigest,
    contextGraphId: sourceAsset.contextGraphId,
  };
  for (const field of IDENTITY_FIELDS) result[field] = sourceAsset[field];
  for (const field of RECOVERY_EVIDENCE_FIELDS) {
    if (evidence[field] !== undefined) result[field] = evidence[field];
  }
  return result;
}

export function certifyMatrixEvidence({
  manifest,
  recoverySources,
  certifiedAt = new Date().toISOString(),
}) {
  const snapshot = snapshotManifest(manifest);
  if (!Array.isArray(recoverySources) || recoverySources.length === 0) {
    fail('at least one recovery source is required');
  }

  const bestRecovery = new Map();
  for (const input of recoverySources) {
    const source = requireNonEmptyString(input?.source, 'recovery source');
    if (!Array.isArray(input?.records)) fail(`${source} records must be an array`);
    const headers = input.records.filter((record) => record?.type === 'recovery_start');
    if (headers.length !== 1) fail(`${source} must contain exactly one recovery_start`);
    validateRecoveryHeader(headers[0], snapshot, source);
    for (const record of input.records.filter((row) => row?.type === 'recovery_result')) {
      const asset = validateRecoveryResult(record, snapshot, source);
      const key = evidenceKey(asset.contextGraphId, asset.subject);
      const current = bestRecovery.get(key);
      if (!current || recoveryScore(record) >= recoveryScore(current.record)) {
        bestRecovery.set(key, { record, source });
      }
    }
  }

  const assets = snapshot.assets.map((asset) => {
    const contextGraphId = snapshot.laneBindings[asset.lane];
    const recovery = bestRecovery.get(evidenceKey(contextGraphId, asset.subject));
    return recovery
      ? { ...asset, ...recoveryEvidence(recovery.record, recovery.source) }
      : { ...asset, evidence: 'first-attempt' };
  });

  const byLane = Object.fromEntries(Object.keys(snapshot.laneBindings).map((lane) => {
    const selected = assets.filter((asset) => asset.lane === lane);
    return [lane, {
      contextGraphId: snapshot.laneBindings[lane],
      expectedAssets: selected.length,
      expectedTriples: selected.reduce((sum, asset) => sum + asset.tripleCount, 0),
      chainFinalized: selected.filter((asset) => asset.finalized === true).length,
      publisherExactReadback: selected.filter((asset) => asset.readbackPassed === true).length,
      unresolvedIndexes: selected
        .filter((asset) => asset.finalized !== true || asset.readbackPassed !== true)
        .map((asset) => asset.index),
    }];
  }));
  const unresolved = assets
    .filter((asset) => asset.finalized !== true || asset.readbackPassed !== true)
    .map((asset) => ({
      lane: asset.lane,
      index: asset.index,
      name: asset.name,
      subject: asset.subject,
      contextGraphId: snapshot.laneBindings[asset.lane],
      ual: asset.ual,
      finalized: asset.finalized,
      readbackPassed: asset.readbackPassed,
      evidence: asset.evidence,
      finalStatus: asset.finalStatus,
      finalMemoryLayer: asset.finalMemoryLayer,
    }));

  return {
    ...manifest,
    schemaVersion: Math.max(Number(manifest.schemaVersion) || 0, 3),
    certifiedAt,
    recoveryFiles: recoverySources.map((source) => source.source),
    firstAttemptPublicationSummary: manifest.publicationSummary,
    assets,
    certificationSummary: {
      expectedAssets: assets.length,
      expectedTriples: assets.reduce((sum, asset) => sum + asset.tripleCount, 0),
      chainFinalized: assets.filter((asset) => asset.finalized === true).length,
      publisherExactReadback: assets.filter((asset) => asset.readbackPassed === true).length,
      byLane,
      unresolved,
    },
  };
}
