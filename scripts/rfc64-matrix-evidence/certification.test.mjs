import assert from 'node:assert/strict';
import test from 'node:test';

import {
  certifyMatrixEvidence,
  createRecoveryResultEvidence,
  createRecoveryStartEvidence,
} from './certification.mjs';

function fixtureManifest() {
  return {
    schemaVersion: 1,
    runId: 'run-a',
    datasetDigest: 'dataset-a',
    lanes: {
      'public-open': {
        contextGraphId: '0xabc/run-a-public-open',
      },
      'private-curated': {
        contextGraphId: '0xabc/run-a-private-curated',
      },
    },
    assets: [
      {
        lane: 'public-open',
        index: 0,
        name: 'run-a-public-open-0',
        subject: 'urn:run-a:public-open:0',
        tripleCount: 101,
        expectedDigest: 'digest-public',
        finalized: false,
        readbackPassed: false,
      },
      {
        lane: 'private-curated',
        index: 0,
        name: 'run-a-private-curated-0',
        subject: 'urn:run-a:private-curated:0',
        tripleCount: 202,
        expectedDigest: 'digest-private',
        finalized: true,
        readbackPassed: true,
      },
    ],
    publicationSummary: {
      expectedAssets: 2,
    },
  };
}

function source(manifest, asset = manifest.assets[0], evidence = {}) {
  return {
    source: 'recovery.jsonl',
    records: [
      createRecoveryStartEvidence(manifest),
      createRecoveryResultEvidence(manifest, asset, evidence),
    ],
  };
}

test('merges only CG-bound recovery evidence and preserves manifest identity', () => {
  const manifest = fixtureManifest();
  const certified = certifyMatrixEvidence({
    manifest,
    recoverySources: [source(manifest, manifest.assets[0], {
      finalized: true,
      readbackPassed: true,
      actions: ['publish'],
      txHash: '0x1234',
    })],
    certifiedAt: '2026-07-24T00:00:00.000Z',
  });

  assert.equal(certified.schemaVersion, 3);
  assert.equal(certified.assets[0].name, manifest.assets[0].name);
  assert.equal(certified.assets[0].subject, manifest.assets[0].subject);
  assert.equal(certified.assets[0].finalized, true);
  assert.equal(certified.assets[0].readbackPassed, true);
  assert.equal(certified.assets[0].evidence, 'recovery:publish');
  assert.equal(certified.certificationSummary.chainFinalized, 2);
  assert.equal(certified.certificationSummary.publisherExactReadback, 2);
  assert.equal(
    certified.certificationSummary.byLane['public-open'].contextGraphId,
    manifest.lanes['public-open'].contextGraphId,
  );
});

test('rejects a recovery file from another run even when lane and index collide', () => {
  const manifest = fixtureManifest();
  const recovery = source(manifest);
  recovery.records[0].runId = 'run-b';
  recovery.records[1].runId = 'run-b';

  assert.throws(
    () => certifyMatrixEvidence({ manifest, recoverySources: [recovery] }),
    /runId differs from the source manifest/,
  );
});

test('rejects a recovery file with a different dataset digest', () => {
  const manifest = fixtureManifest();
  const recovery = source(manifest);
  recovery.records[0].datasetDigest = 'dataset-b';

  assert.throws(
    () => certifyMatrixEvidence({ manifest, recoverySources: [recovery] }),
    /datasetDigest differs from the source manifest/,
  );
});

test('rejects a recovery header whose lane points at another context graph', () => {
  const manifest = fixtureManifest();
  const recovery = source(manifest);
  recovery.records[0].contextGraphBindings['public-open'] = '0xabc/other-public-open';

  assert.throws(
    () => certifyMatrixEvidence({ manifest, recoverySources: [recovery] }),
    /context graph binding for public-open differs/,
  );
});

test('rejects a recovery row whose context graph differs from its manifest lane', () => {
  const manifest = fixtureManifest();
  const recovery = source(manifest);
  recovery.records[1].contextGraphId = manifest.lanes['private-curated'].contextGraphId;

  assert.throws(
    () => certifyMatrixEvidence({ manifest, recoverySources: [recovery] }),
    /contextGraphId for public-open differs/,
  );
});

test('rejects cross-asset evidence even within the same run and context graph', () => {
  const manifest = fixtureManifest();
  const recovery = source(manifest);
  recovery.records[1].subject = 'urn:run-a:public-open:attacker';

  assert.throws(
    () => certifyMatrixEvidence({ manifest, recoverySources: [recovery] }),
    /does not identify a manifest asset/,
  );
});

test('rejects recovery JSON that tries to replace immutable identity', () => {
  const manifest = fixtureManifest();
  const recovery = source(manifest);
  recovery.records[1].expectedDigest = 'attacker-digest';

  assert.throws(
    () => certifyMatrixEvidence({ manifest, recoverySources: [recovery] }),
    /asset expectedDigest differs/,
  );
});

test('requires one CG-bound recovery_start per recovery file', () => {
  const manifest = fixtureManifest();
  const recovery = source(manifest);
  recovery.records.shift();

  assert.throws(
    () => certifyMatrixEvidence({ manifest, recoverySources: [recovery] }),
    /must contain exactly one recovery_start/,
  );
});

test('selects the strongest valid recovery without mixing asset identities', () => {
  const manifest = fixtureManifest();
  const first = source(manifest, manifest.assets[0], {
    finalized: true,
    readbackPassed: false,
    actions: ['chain-already-minted'],
  });
  first.source = 'first.jsonl';
  const second = source(manifest, manifest.assets[0], {
    finalized: true,
    readbackPassed: true,
    actions: ['verified-readback'],
  });
  second.source = 'second.jsonl';

  const certified = certifyMatrixEvidence({
    manifest,
    recoverySources: [first, second],
  });
  assert.equal(certified.assets[0].recoveryFile, 'second.jsonl');
  assert.equal(certified.assets[0].evidence, 'recovery:verified-readback');
});
