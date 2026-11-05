#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, open, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { enrollKafkaSource, resolveKafkaRegistryEntry } from './registry.mjs';

export async function runEnrollment(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    'registry-url': { type: 'string' }, ual: { type: 'string' }, 'registry-context-graph': { type: 'string' },
    'registry-token-env': { type: 'string' }, 'expected-hash': { type: 'string' },
    'expected-publisher': { type: 'string' }, options: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('dkg-kafka-enroll --registry-url URL --ual UAL --registry-context-graph ID --options local-options.json --out source.private.json [--registry-token-env NAME] [--expected-hash HASH] [--expected-publisher IRI]');
    return;
  }
  for (const key of ['registry-url', 'ual', 'registry-context-graph', 'options', 'out']) {
    if (!values[key]) throw new Error('KAFKA_REGISTRY_CLI_ARGUMENTS_REQUIRED');
  }
  const tokenEnv = values['registry-token-env'];
  if (tokenEnv && (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv) || !process.env[tokenEnv]))
    throw new Error('KAFKA_REGISTRY_TOKEN_ENV_REQUIRED');
  const entry = await resolveKafkaRegistryEntry({ registryUrl: values['registry-url'], ual: values.ual,
    contextGraphId: values['registry-context-graph'], registryToken: tokenEnv ? process.env[tokenEnv] : undefined,
    expectedDescriptorHash: values['expected-hash'], expectedPublisherIri: values['expected-publisher'] });
  const source = enrollKafkaSource(entry, JSON.parse(await readFile(values.options, 'utf8')));
  const file = await open(values.out, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(source, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  console.log('Kafka source configuration created. Add it to your private Source Worker config.sources.');
}

export async function main(args) {
  try { await runEnrollment(args); } catch (error) {
    console.error(/^KAFKA_REGISTRY_[A-Z_0-9]+$/.test(error.message) ? error.message : 'KAFKA_REGISTRY_ENROLLMENT_FAILED');
    process.exitCode = 1;
  }
}

// Package-manager binaries are symlinks; compare their canonical file paths.
if (process.argv[1] && await realpath(process.argv[1]).catch(() => undefined)
    === await realpath(fileURLToPath(import.meta.url))) {
  void main();
}
