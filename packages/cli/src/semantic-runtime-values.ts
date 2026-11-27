import { createHash } from 'node:crypto';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { canonicalizeJson, type CanonicalJsonValue, sparqlIri, validateContextGraphId } from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { type SemanticRuntimeConfig } from '@origintrail-official/dkg-semantic-runtime';
import { SemanticMemoryLayer, SemanticProgramError, StoredSemanticProgram } from './semantic-runtime-types.js';

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const PROV = 'http://www.w3.org/ns/prov#';
export const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
export const SR = 'https://origintrail.io/semantic-runtime/v1#';

export function sourceHashOf(program: StoredSemanticProgram): string {
  return createHash('sha256').update(program.source, 'utf8').digest('hex');
}

export function programPolicyHash(config: SemanticRuntimeConfig | undefined): string {
  return config?.programPolicy ? hashParts([canonicalizeJson(config.programPolicy as unknown as CanonicalJsonValue)]) : '';
}

export function validateGraphAndProgram(contextGraphId: string, programIri: string): void {
  const graphValidation = validateContextGraphId(contextGraphId);
  if (!graphValidation.valid) {
    throw new SemanticProgramError(
      'INVALID_CONTEXT_GRAPH',
      `Invalid contextGraphId: ${graphValidation.reason}`,
      400,
    );
  }
  try {
    sparqlIri(programIri);
  } catch {
    throw new SemanticProgramError('INVALID_PROGRAM_IRI', 'programIri must be an absolute IRI', 400);
  }
}

export function checksumAgentAddress(value: string, code: string): string {
  try {
    return ethers.getAddress(value);
  } catch {
    throw new SemanticProgramError(code, 'Executing wallet is invalid', 400);
  }
}

export function isOperatorVmGraph(value: unknown, contextGraphId: string, operatorAddress: string): boolean {
  return programGraphAuthor(value, contextGraphId, 'vm')?.toLowerCase() === operatorAddress.toLowerCase();
}

export function programGraphAuthor(
  value: unknown,
  contextGraphId: string,
  layer: SemanticMemoryLayer,
): string | null {
  try {
    const directory = {
      wm: '_working_memory',
      swm: '_shared_memory',
      vm: '_verifiable_memory',
    }[layer];
    const prefix = `did:dkg:context-graph:${contextGraphId}/${directory}/`;
    const graphIri = iriValue(value);
    if (!graphIri.startsWith(prefix)) return null;
    const suffix = graphIri.slice(prefix.length);
    const separator = suffix.indexOf('/');
    if (separator <= 0 || suffix.indexOf('/', separator + 1) !== -1) return null;
    const agentAddress = suffix.slice(0, separator);
    const kaNumber = suffix.slice(separator + 1);
    return ethers.isAddress(agentAddress) && /^\d+$/.test(kaNumber)
      ? ethers.getAddress(agentAddress)
      : null;
  } catch {
    return null;
  }
}

export function queryOptions(
  contextGraphId: string,
  layer: SemanticMemoryLayer,
  source: string,
  callerAgentAddress?: string,
) {
  const view = {
    wm: 'working-memory',
    swm: 'shared-working-memory',
    vm: 'verifiable-memory',
  } as const;
  return {
    contextGraphId,
    view: view[layer],
    source,
    ...(layer === 'wm' && callerAgentAddress ? { agentAddress: callerAgentAddress } : {}),
    ...(callerAgentAddress ? { callerAgentAddress } : {}),
  };
}

export function isSemanticMemoryLayer(value: unknown): value is SemanticMemoryLayer {
  return value === 'wm' || value === 'swm' || value === 'vm';
}

export function validateSemanticMemoryLayer(value: unknown, field: string): asserts value is SemanticMemoryLayer {
  if (!isSemanticMemoryLayer(value)) {
    throw new SemanticProgramError(
      'INVALID_MEMORY_LAYER',
      `${field} must be one of wm, swm, or vm`,
      400,
    );
  }
}

export function semanticLayerLabel(layer: SemanticMemoryLayer): string {
  if (layer === 'wm') return 'Working Memory';
  if (layer === 'swm') return 'Shared Working Memory';
  return 'Verifiable Memory';
}

export function historyLayerLabel(
  history: NonNullable<Awaited<ReturnType<DKGAgent['assertion']['history']>>>,
): string {
  if (history.memoryLayer === 'WM') return 'Working Memory';
  if (history.memoryLayer === 'SWM') return 'Shared Working Memory';
  if (history.memoryLayer === 'VM') return 'Verifiable Memory';
  return 'an unfinished lifecycle state';
}

export function historyIsAtLayer(
  history: NonNullable<Awaited<ReturnType<DKGAgent['assertion']['history']>>>,
  layer: SemanticMemoryLayer,
): boolean {
  return history.memoryLayer === ({ wm: 'WM', swm: 'SWM', vm: 'VM' } as const)[layer]
    && Boolean(history[({ wm: 'wmCurrentAssertion', swm: 'swmCurrentAssertion', vm: 'vmCurrentAssertion' } as const)[layer]])
    && (layer !== 'vm' || Boolean(history.publishedUal));
}

export function resultRows(result: unknown): Array<Record<string, unknown>> {
  if (typeof result !== 'object' || result === null || !('bindings' in result)) return [];
  const rows = (result as { bindings?: unknown }).bindings;
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

export function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

export function hashParts(parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

export function iriValue(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return String((value as { value: unknown }).value);
  }
  if (typeof value !== 'string') throw new Error('Expected RDF IRI binding');
  const match = value.match(/^<([^>]+)>$/);
  return match?.[1] ?? value;
}

export function literalValue(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return String((value as { value: unknown }).value);
  }
  if (typeof value !== 'string') {
    throw new SemanticProgramError('INVALID_PROGRAM', 'Program fields must be RDF literals', 422);
  }
  const match = value.match(/^"((?:\\.|[^"\\])*)"(?:@[A-Za-z0-9-]+|\^\^<[^>]+>)?$/s);
  if (!match) {
    throw new SemanticProgramError('INVALID_PROGRAM', 'Program fields must be RDF literals', 422);
  }
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    throw new SemanticProgramError('INVALID_PROGRAM', 'Program contains an invalid RDF literal', 422);
  }
}

export function iriQuad(subject: string, predicate: string, object: string) {
  return { subject, predicate, object };
}

export function literalQuad(subject: string, predicate: string, value: string) {
  return { subject, predicate, object: JSON.stringify(value) };
}

export function typedLiteralQuad(subject: string, predicate: string, value: string, datatype: string) {
  return { subject, predicate, object: `${JSON.stringify(value)}^^<${datatype}>` };
}

export function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validatePositiveInteger(value: number | undefined, name: string, maximum: number): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
}
