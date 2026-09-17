import { createHash } from 'node:crypto';

import { canonicalizeJson, sparqlIri, validateContextGraphId, type CanonicalJsonValue } from '@origintrail-official/dkg-core';
import type { SemanticProgramBinding } from '@origintrail-official/dkg-semantic-runtime';
import { ethers } from 'ethers';

import { validateSemanticQueryPins } from './semantic-runtime-query-pins.js';

/** Validate trusted local configuration at startup, before any grant can be used. */
export function validateProgramBindings(value: unknown): asserts value is SemanticProgramBinding[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('INVALID_PROGRAM_BINDINGS');
  const seen = new Set<string>();
  for (const binding of value) {
    if (!record(binding)
      || !keys(binding, ['operationIri', 'contextGraphId', 'enabled', 'allowedCallerAgentAddresses', 'executorAgentAddress', 'program', 'query'])
      || typeof binding.enabled !== 'boolean'
      || !address(binding.executorAgentAddress)
      || !Array.isArray(binding.allowedCallerAgentAddresses)
      || binding.allowedCallerAgentAddresses.length > 256
      || !binding.allowedCallerAgentAddresses.every(address)
      || !record(binding.program)
      || !keys(binding.program, ['contextGraphId', 'programIri', 'programLayer', 'authorAgentAddress', 'sourceHash'])
      || !address(binding.program.authorAgentAddress)
      || !['wm', 'swm', 'vm'].includes(String(binding.program.programLayer))
      || typeof binding.program.sourceHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(binding.program.sourceHash)) {
      throw new Error('INVALID_PROGRAM_BINDING');
    }
    for (const graph of [binding.contextGraphId, binding.program.contextGraphId]) {
      if (typeof graph !== 'string' || !validateContextGraphId(graph).valid) throw new Error('INVALID_PROGRAM_BINDING_GRAPH');
    }
    for (const iri of [binding.operationIri, binding.program.programIri]) {
      if (typeof iri !== 'string') throw new Error('INVALID_PROGRAM_BINDING_IRI');
      sparqlIri(iri);
    }
    validateSemanticQueryPins([binding.query]);
    const key = `${binding.contextGraphId}\0${binding.operationIri}`;
    if (seen.has(key)) throw new Error('DUPLICATE_PROGRAM_BINDING');
    seen.add(key);
  }
}

/** Includes the complete grant, Program identity, query definition and output contract. */
export function programBindingDigest(binding: SemanticProgramBinding): string {
  return createHash('sha256')
    .update(canonicalizeJson(binding as unknown as CanonicalJsonValue))
    .digest('hex');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function address(value: unknown): value is string {
  return typeof value === 'string' && ethers.isAddress(value);
}
