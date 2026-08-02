import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSelectiveCoverageCorpus,
  type ExpectedSelectiveCoverageProvenanceV1,
} from './manifest.ts';
import {
  readExpectedSelectiveCoverageProvenance,
  readSelectiveCoverageCorpus,
} from './operator-input.ts';

const digest = `sha256:${'a'.repeat(64)}`;
const snapshot = {
  vm: { headDigest: digest, inventoryDigest: digest, assetCount: 1, dataTripleCount: 1 },
  swm: { headDigest: digest, inventoryDigest: digest, assetCount: 1, dataTripleCount: 1 },
};
const corpus = createSelectiveCoverageCorpus({
  networkId: 'otp:20430',
  coreAutomaticBatchSize: 1,
  coreCoverageRoundLimit: 1,
  graphs: [{
    contextGraphId: '0x1111111111111111111111111111111111111111/public-open',
    accessPolicy: 0,
    publishPolicy: 1,
    edgePolicy: 'on-demand',
    selectedSnapshot: snapshot,
    finalSnapshot: { vm: { ...snapshot.vm }, swm: { ...snapshot.swm } },
  }],
});
const provenance: ExpectedSelectiveCoverageProvenanceV1 = {
  networkId: corpus.networkId,
  testedHeadCommit: 'b'.repeat(40),
  runtimeManifestDigest: digest,
  corpusManifestDigest: corpus.manifestDigest,
  publisherPeerId: 'publisher-peer',
  edgePeerId: 'edge-peer',
  corePeerId: 'core-peer',
};

test('operator input readers return only closed decoded corpus and provenance', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'rfc64-m1-input-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const corpusPath = join(directory, 'corpus.json');
  const provenancePath = join(directory, 'provenance.json');
  writeFileSync(corpusPath, JSON.stringify(corpus));
  writeFileSync(provenancePath, JSON.stringify(provenance));

  assert.deepEqual(readSelectiveCoverageCorpus(corpusPath), corpus);
  assert.deepEqual(readExpectedSelectiveCoverageProvenance(provenancePath), provenance);
});

test('operator input readers label malformed JSON and schema failures', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'rfc64-m1-input-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const corpusPath = join(directory, 'corpus.json');
  const provenancePath = join(directory, 'provenance.json');
  writeFileSync(corpusPath, JSON.stringify({ ...corpus, unexpected: true }));
  writeFileSync(provenancePath, '{');

  assert.throws(
    () => readSelectiveCoverageCorpus(corpusPath),
    /M1 selective-coverage corpus failed closed-schema validation/u,
  );
  assert.throws(
    () => readExpectedSelectiveCoverageProvenance(provenancePath),
    /Could not read M1 selective-coverage trust anchor/u,
  );
});
