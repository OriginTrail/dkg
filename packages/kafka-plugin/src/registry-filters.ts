import { z } from 'zod';
import { sparqlIri, sparqlString } from '@origintrail-official/dkg-core';
import { agentAddressSchema, registryIriSchema, STREAMS, SCHEMA } from './registry.js';

const filtersSchema = z.object({
  publisher: registryIriSchema.optional(),
  registeredBy: agentAddressSchema.optional(),
  provider: registryIriSchema.optional(),
  about: registryIriSchema.optional(),
  schema: registryIriSchema.optional(),
  dataFormat: z.string().min(1).max(128).optional(),
  q: z.string().min(1).max(200).optional(),
}).strict();
export type RegistryFilters = z.infer<typeof filtersSchema>;

export function parseRegistryFilters(params: URLSearchParams): RegistryFilters {
  const values: Record<string, string> = {};
  const allowed = new Set([...Object.keys(filtersSchema.shape), 'limit', 'offset', 'includeRegistry']);
  for (const key of params.keys()) if (!allowed.has(key)) throw new Error(`Unknown registry filter: ${key}`);
  for (const key of Object.keys(filtersSchema.shape)) {
    if (params.getAll(key).length > 1) throw new Error(`Repeated registry filter: ${key}`);
    if (params.has(key)) values[key] = params.get(key)!;
  }
  return filtersSchema.parse(values);
}

/** Shared by count and page selection, always before LIMIT/OFFSET. */
export function registryFilterPattern(filters: RegistryFilters = {}): string {
  const parsed = filtersSchema.parse(filters);
  const clauses: string[] = [];
  if (parsed.publisher) clauses.push(`FILTER(?publisher = ${sparqlIri(parsed.publisher)})`);
  const fields: Array<[keyof RegistryFilters, string, boolean]> = [
    ['registeredBy', `${STREAMS}registeredByAgentAddress`, false],
    ['provider', `${STREAMS}providerIri`, true],
    ['about', `${SCHEMA}about`, true],
    ['schema', `${STREAMS}schemaIri`, true],
    ['dataFormat', `${STREAMS}dataFormat`, false],
  ];
  for (const [key, predicate, isIri] of fields) {
    const value = parsed[key];
    if (value !== undefined) clauses.push(`GRAPH ?contentGraph { ?root <${predicate}> ${isIri ? sparqlIri(value) : sparqlString(value)} . }`);
  }
  if (parsed.q) clauses.push(`GRAPH ?contentGraph {
    ?root <${SCHEMA}name> ?filterName .
    OPTIONAL { ?root <${SCHEMA}description> ?filterDescription . }
    FILTER(CONTAINS(LCASE(STR(?filterName)), LCASE(${sparqlString(parsed.q)})) ||
      CONTAINS(LCASE(COALESCE(STR(?filterDescription), "")), LCASE(${sparqlString(parsed.q)})))
  }`);
  return clauses.join('\n  ');
}
