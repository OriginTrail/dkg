import { createHash } from 'node:crypto';

import { canonicalizeJson, type CanonicalJsonValue } from '@origintrail-official/dkg-core';
import { QUERY_CATALOG_SCHEMA_VERSION, type QueryCatalogItem } from '@origintrail-official/dkg-core/query-catalog';
import type { SemanticQueryOutputSchema, SemanticQueryPin } from '@origintrail-official/dkg-semantic-runtime';

const SHA256 = /^[0-9a-f]{64}$/;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_SCHEMA_NODES = 256;
const MAX_SCHEMA_DEPTH = 12;

/** Hash the decoded catalog contract, including selection, scope, parameters and view. */
export function queryCatalogDefinitionSha256(item: QueryCatalogItem): string {
  return digest({
    contract: 'dkg-query-definition-v1', catalogSchemaVersion: QUERY_CATALOG_SCHEMA_VERSION,
    queryIri: item.queryIri, catalogIri: item.catalogIri, slug: item.slug,
    name: item.name, sparql: item.sparql, resultColumn: item.resultColumn ?? null,
    catalogSlug: item.catalogSlug, subGraph: item.subGraph, scopeGraph: item.scopeGraph,
    view: item.view ?? null,
    parameters: item.parameters.map((parameter) => ({
      name: parameter.name, type: parameter.type, label: parameter.label ?? null,
      description: parameter.description ?? null, required: parameter.required ?? null,
      defaultValue: parameter.defaultValue ?? null,
    })),
  });
}

export function queryOutputSchemaSha256(schema: SemanticQueryOutputSchema): string {
  validateSchema(schema, 0, { remaining: MAX_SCHEMA_NODES });
  return digest({ contract: 'dkg-query-output-v1', schema });
}

/** Provisioning helper: operators review the item/schema before installing this pin. */
export function createSemanticQueryPin(
  selector: string,
  item: QueryCatalogItem,
  outputSchema: SemanticQueryOutputSchema,
): SemanticQueryPin {
  const pin = {
    selector, queryIri: item.queryIri, definitionSha256: queryCatalogDefinitionSha256(item),
    outputSchema: structuredClone(outputSchema), outputSchemaSha256: queryOutputSchemaSha256(outputSchema),
  };
  validateSemanticQueryPins([pin]);
  return pin;
}

export function validateSemanticQueryPins(value: unknown): asserts value is SemanticQueryPin[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('INVALID_SEMANTIC_QUERY_PINS');
  const selectors = new Set<string>();
  for (const pin of value) {
    if (!record(pin) || !text(pin.selector, 512) || pin.selector.trim() !== pin.selector
      || !text(pin.queryIri, 2048) || typeof pin.definitionSha256 !== 'string' || !SHA256.test(pin.definitionSha256)
      || typeof pin.outputSchemaSha256 !== 'string' || !SHA256.test(pin.outputSchemaSha256)
      || selectors.has(pin.selector)
      || Object.keys(pin).some((key) => !['selector', 'queryIri', 'definitionSha256', 'outputSchema', 'outputSchemaSha256'].includes(key))) {
      throw new Error('INVALID_SEMANTIC_QUERY_PINS');
    }
    if (queryOutputSchemaSha256(pin.outputSchema as SemanticQueryOutputSchema) !== pin.outputSchemaSha256) {
      throw new Error('SEMANTIC_QUERY_SCHEMA_PIN_MISMATCH');
    }
    selectors.add(pin.selector);
  }
}

export function assertSemanticQueryDefinition(
  pins: SemanticQueryPin[], selector: string, item: QueryCatalogItem,
): SemanticQueryPin {
  validateSemanticQueryPins(pins);
  const pin = pins.find((candidate) => candidate.selector === selector);
  if (!pin || pin.queryIri !== item.queryIri || pin.definitionSha256 !== queryCatalogDefinitionSha256(item)) {
    throw new Error('SEMANTIC_QUERY_DEFINITION_NOT_PINNED');
  }
  return pin;
}

/** Validate the actual query result before it can become a Program output or leave the node. */
export function assertSemanticQueryOutput(pin: SemanticQueryPin, result: unknown): void {
  if (queryOutputSchemaSha256(pin.outputSchema) !== pin.outputSchemaSha256) {
    throw new Error('SEMANTIC_QUERY_SCHEMA_PIN_MISMATCH');
  }
  if (!matchesSchema(pin.outputSchema, result, { remaining: 100_000 })) {
    throw new Error('SEMANTIC_QUERY_OUTPUT_SCHEMA_MISMATCH');
  }
}

function validateSchema(value: unknown, depth: number, budget: { remaining: number }): void {
  if (!record(value) || depth > MAX_SCHEMA_DEPTH || --budget.remaining < 0) invalidSchema();
  const schema = value as Record<string, unknown>;
  const keysByType: Record<string, string[]> = {
    object: ['properties', 'required', 'additionalProperties'], array: ['items', 'minItems', 'maxItems'],
    string: ['minLength', 'maxLength', 'enum', 'format'], number: ['minimum', 'maximum'],
    integer: ['minimum', 'maximum'], boolean: [], null: [],
  };
  if (typeof schema.type !== 'string' || !Object.hasOwn(keysByType, schema.type)
    || Object.keys(schema).some((key) => key !== 'type' && !keysByType[schema.type as string].includes(key))) invalidSchema();
  if (schema.type === 'object') {
    if (!record(schema.properties) || Object.keys(schema.properties).length > 64
      || !Array.isArray(schema.required) || schema.required.length > 64
      || schema.additionalProperties !== false) invalidSchema();
    const properties = schema.properties as Record<string, unknown>;
    const required = schema.required as unknown[];
    if (required.some((key) => typeof key !== 'string' || !Object.hasOwn(properties, key))
      || new Set(required).size !== required.length) invalidSchema();
    for (const [key, child] of Object.entries(properties)) {
      if (!text(key, 256) || UNSAFE_KEYS.has(key)) invalidSchema();
      validateSchema(child, depth + 1, budget);
    }
  } else if (schema.type === 'array') {
    if (!boundedInteger(schema.maxItems, 0, 1000) || (schema.minItems !== undefined
      && !boundedInteger(schema.minItems, 0, schema.maxItems as number))) invalidSchema();
    validateSchema(schema.items, depth + 1, budget);
  } else if (schema.type === 'string') {
    if (!boundedInteger(schema.maxLength, 0, 1_048_576) || (schema.minLength !== undefined
      && !boundedInteger(schema.minLength, 0, schema.maxLength as number))) invalidSchema();
    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length < 1 || schema.enum.length > 64
      || schema.enum.some((entry) => typeof entry !== 'string' || entry.length > (schema.maxLength as number)))) invalidSchema();
    if (schema.format !== undefined && !['rdf-integer', 'rdf-decimal', 'rdf-boolean'].includes(String(schema.format))) invalidSchema();
  } else if (schema.type === 'number' || schema.type === 'integer') {
    for (const bound of [schema.minimum, schema.maximum]) {
      if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) invalidSchema();
    }
    if (schema.minimum !== undefined && schema.maximum !== undefined
      && (schema.minimum as number) > (schema.maximum as number)) invalidSchema();
  }
}

function matchesSchema(schema: SemanticQueryOutputSchema, value: unknown, budget: { remaining: number }): boolean {
  if (--budget.remaining < 0) return false;
  switch (schema.type) {
    case 'object':
      return record(value) && schema.required.every((key) => Object.hasOwn(value, key))
        && Object.entries(value).every(([key, child]) => Object.hasOwn(schema.properties, key)
          && matchesSchema(schema.properties[key], child, budget));
    case 'array':
      return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= schema.maxItems
        && value.every((child) => matchesSchema(schema.items, child, budget));
    case 'string':
      return typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= schema.maxLength
        && (!schema.enum || schema.enum.includes(value)) && (!schema.format || matchesRdfFormat(value, schema.format));
    case 'integer':
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && (schema.type !== 'integer' || Number.isSafeInteger(value))
        && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
  }
}

function matchesRdfFormat(value: string, format: 'rdf-integer' | 'rdf-decimal' | 'rdf-boolean'): boolean {
  // These formats deliberately accept only exact N-Triples datatypes/lexical forms.
  if (format === 'rdf-integer') return /^"[+-]?\d+"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#integer>$/.test(value);
  if (format === 'rdf-decimal') return /^"[+-]?(?:\d+(?:\.\d*)?|\.\d+)"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#decimal>$/.test(value);
  return /^"(?:true|false|0|1)"\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#boolean>$/.test(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value as CanonicalJsonValue, { maxBytes: 262_144 })).digest('hex');
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max; }
function boundedInteger(value: unknown, min: number, max: number): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max; }
function invalidSchema(): never { throw new Error('INVALID_SEMANTIC_QUERY_OUTPUT_SCHEMA'); }
