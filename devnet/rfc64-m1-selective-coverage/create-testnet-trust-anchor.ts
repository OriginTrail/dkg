import { resolve } from 'node:path';

import {
  atomicWriteExactBytes,
  readCleanRepositoryHead,
} from '../rfc64-persistence-lifecycle/evidence.ts';
import { buildGate2RuntimeManifestV1 } from
  '../rfc64-gate2-multi-asset-completeness/runtime-provenance.ts';
import { canonicalJson, type ExpectedSelectiveCoverageProvenanceV1 } from './manifest.ts';
import { readSelectiveCoverageCorpus } from './operator-input.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const corpusPath = resolve(requiredEnvironment('DKG_RFC64_M1_CORPUS_FILE'));
const outputPath = resolve(requiredEnvironment('DKG_RFC64_M1_TRUST_ANCHOR_FILE'));
const corpus = readSelectiveCoverageCorpus(corpusPath);
const sourceCommit = readCleanRepositoryHead(repoRoot);
const runtimeManifest = buildGate2RuntimeManifestV1(repoRoot, sourceCommit);
const trustAnchor: ExpectedSelectiveCoverageProvenanceV1 = {
  networkId: corpus.networkId,
  testedHeadCommit: sourceCommit,
  runtimeManifestDigest: runtimeManifest.manifestDigest,
  corpusManifestDigest: corpus.manifestDigest,
  publisherPeerId: peerId('DKG_RFC64_M1_PUBLISHER_PEER_ID'),
  edgePeerId: peerId('DKG_RFC64_M1_EDGE_PEER_ID'),
  corePeerId: peerId('DKG_RFC64_M1_CORE_PEER_ID'),
};
const published = atomicWriteExactBytes(
  outputPath,
  Buffer.from(`${canonicalJson(trustAnchor)}\n`, 'utf8'),
);
process.stdout.write(
  `[rfc64-m1] wrote externally anchored runtime/peer provenance to ${outputPath} `
    + `sha256:${published.sha256}\n`,
);

function peerId(name: string): string {
  const value = requiredEnvironment(name);
  if (!/^12D3KooW[1-9A-HJ-NP-Za-km-z]{40,60}$/u.test(value)) {
    throw new TypeError(`${name} is not a bounded libp2p Ed25519 peer ID`);
  }
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
