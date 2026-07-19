import { join } from 'node:path';
import process from 'node:process';

import { atomicWriteStableJson, buildGate3RawEvidence } from './raw-evidence.js';

/**
 * RFC-64 Gate 3 raw-evidence generator (FIXTURES-ONLY).
 *
 * Synthesizes the deterministic golden evidence document entirely in-process
 * and atomically writes it. It performs NO git, network, product-runtime, or
 * child-process work. The pinned sourceCommit is embedded as a constant so the
 * output bytes are a pure function of the fixture builder.
 */

const DEFAULT_ARTIFACT = join(import.meta.dirname, 'artifacts/raw-evidence.json');
const artifactPath = process.env.DKG_RFC64_GATE3_RAW_ARTIFACT ?? DEFAULT_ARTIFACT;

const raw = buildGate3RawEvidence();
const publication = atomicWriteStableJson(artifactPath, raw);

process.stdout.write(`RAW_SHA256=${publication.sha256}\n`);
process.stdout.write(`[rfc64-gate3-generator] artifact: ${artifactPath}\n`);
process.stdout.write(`[rfc64-gate3-generator] productBoundary=${raw.productBoundary} gateEvaluation=${raw.gateEvaluation}\n`);
process.stdout.write('[rfc64-gate3-generator] fixtures-only: this artifact does NOT prove the product passes Gate 3\n');
