import { createHash } from 'node:crypto';

import { canonicalizeJson, sparqlIri, validateContextGraphId, type CanonicalJsonValue } from '@origintrail-official/dkg-core';
import type { SemanticProgramBinding, SemanticRuntimeConfig } from '@origintrail-official/dkg-semantic-runtime';
import { ethers } from 'ethers';

import { validateSparqlReadGrant } from './semantic-runtime-sparql-adapter.js';
import { validateSemanticQueryPins } from './semantic-runtime-query-pins.js';

/** Validate trusted local configuration at startup, before any grant can be used. */
export function validateProgramBindings(value: unknown): asserts value is SemanticProgramBinding[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error('INVALID_PROGRAM_BINDINGS');
  const seen = new Set<string>();
  for (const binding of value) {
    if (!record(binding)
      || !keys(binding, ['operationIri', 'contextGraphId', 'enabled', 'allowedCallerAgentAddresses', 'executorAgentAddress', 'program', 'query', 'sparqlRead', 'assetCreation', 'executionLayer', 'authorizationRevision'])
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
    if (binding.authorizationRevision !== undefined && (typeof binding.authorizationRevision !== 'number'
      || !Number.isSafeInteger(binding.authorizationRevision) || binding.authorizationRevision < 1)) throw new Error('INVALID_AUTHORIZATION_REVISION');
    if (binding.query !== undefined) validateSemanticQueryPins([binding.query]);
    if (binding.assetCreation !== undefined) {
      if (!record(binding.assetCreation) || !keys(binding.assetCreation, ['toolIri'])
        || typeof binding.assetCreation.toolIri !== 'string' || binding.assetCreation.toolIri.length > 2_048
        || !/^[a-z][a-z0-9+.-]*:/i.test(binding.assetCreation.toolIri)) throw new Error('INVALID_ASSET_CREATION_GRANT');
      sparqlIri(binding.assetCreation.toolIri);
    }
    if (binding.sparqlRead !== undefined) validateSparqlReadGrant(binding.sparqlRead);
    if (binding.sparqlRead && binding.assetCreation && (binding.sparqlRead as { toolIri: string }).toolIri === binding.assetCreation.toolIri) throw new Error('DUPLICATE_PROGRAM_TOOL');
    if (!binding.query && !binding.assetCreation && !binding.sparqlRead) throw new Error('EMPTY_PROGRAM_BINDING');
    if (binding.executionLayer !== undefined && !['wm', 'swm', 'vm'].includes(String(binding.executionLayer))) throw new Error('INVALID_EXECUTION_LAYER');
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

/** Routing never grants target authority or selects a signing identity. */
export function validateProgramRoutes(value: unknown): asserts value is NonNullable<SemanticRuntimeConfig['programRoutes']> {
  if (!Array.isArray(value) || value.length > 256) throw new Error('INVALID_PROGRAM_ROUTES');
  const seen = new Set<string>();
  for (const route of value) {
    if (!record(route) || !keys(route, ['contextGraphId', 'operationIri', 'targetPeerId'])
      || typeof route.contextGraphId !== 'string' || !validateContextGraphId(route.contextGraphId).valid
      || typeof route.operationIri !== 'string' || route.operationIri.length > 2_048
      || !/^[a-z][a-z0-9+.-]*:/i.test(route.operationIri)
      || typeof route.targetPeerId !== 'string' || !/^\S{1,512}$/.test(route.targetPeerId)) {
      throw new Error('INVALID_PROGRAM_ROUTE');
    }
    sparqlIri(route.operationIri);
    const key = `${route.contextGraphId}\0${route.operationIri}`;
    if (seen.has(key)) throw new Error('DUPLICATE_PROGRAM_ROUTE');
    seen.add(key);
  }
}

/** One graph/operation has one execution path, including after API overlays. */
export function validateProgramConfiguration(bindings: unknown, routes: unknown): void {
  validateProgramBindings(bindings);
  validateProgramRoutes(routes);
  for (const route of routes) {
    if (bindings.some((binding) => binding.contextGraphId === route.contextGraphId
      && binding.operationIri === route.operationIri)) throw new Error('AMBIGUOUS_PROGRAM_ROUTE');
  }
}
