import { readFileSync } from 'node:fs';

import {
  decodeExpectedSelectiveCoverageProvenance,
  decodeSelectiveCoverageCorpus,
} from './evidence-codec.ts';
import type {
  ExpectedSelectiveCoverageProvenanceV1,
  SelectiveCoverageCorpusV1,
} from './manifest.ts';

export function readSelectiveCoverageCorpus(
  path: string,
): SelectiveCoverageCorpusV1 {
  return readDecodedJson(
    path,
    'M1 selective-coverage corpus',
    decodeSelectiveCoverageCorpus,
  );
}

export function readExpectedSelectiveCoverageProvenance(
  path: string,
): ExpectedSelectiveCoverageProvenanceV1 {
  return readDecodedJson(
    path,
    'M1 selective-coverage trust anchor',
    decodeExpectedSelectiveCoverageProvenance,
  );
}

function readDecodedJson<T>(
  path: string,
  label: string,
  decoder: (input: unknown) => T | undefined,
): T {
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${label}: ${path}`, { cause: error });
  }
  const decoded = decoder(input);
  if (decoded === undefined) {
    throw new TypeError(`${label} failed closed-schema validation: ${path}`);
  }
  return decoded;
}
