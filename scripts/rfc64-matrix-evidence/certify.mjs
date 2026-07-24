#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { certifyMatrixEvidence } from './certification.mjs';

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const manifestArgument = arg('--manifest');
const outputArgument = arg('--output');
const recoveryArguments = process.argv.flatMap((value, index, values) => (
  value === '--recovery' && values[index + 1] ? [values[index + 1]] : []
));
if (!manifestArgument) throw new Error('--manifest is required');
if (!outputArgument) throw new Error('--output is required');
if (recoveryArguments.length === 0) throw new Error('at least one --recovery is required');

const manifestFile = resolve(manifestArgument);
const outputFile = resolve(outputArgument);
const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
const recoverySources = recoveryArguments.map((argument) => {
  const source = resolve(argument);
  const records = readFileSync(source, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { source, records };
});

const certified = certifyMatrixEvidence({ manifest, recoverySources });
writeFileSync(outputFile, `${JSON.stringify(certified, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  outputFile,
  datasetDigest: certified.datasetDigest,
  summary: certified.certificationSummary,
}, null, 2)}\n`);
