/**
 * Runtime parameters for profile-backed saved SPARQL queries.
 *
 * A parameter placeholder represents one complete SPARQL RDF term:
 *
 *   FILTER(?configurationId = {{configurationId}})
 *
 * Values are rendered according to the declared type. Catalog consumers must
 * never perform raw string interpolation on parameter values.
 */

import { isSafeIri, sparqlString } from './sparql-safe.js';

export const QUERY_CATALOG_PARAMETER_TYPES = [
  'string',
  'integer',
  'number',
  'boolean',
  'iri',
] as const;

export type QueryCatalogParameterType = typeof QUERY_CATALOG_PARAMETER_TYPES[number];
export type QueryCatalogParameterValue = string | number | boolean;

export interface QueryCatalogParameterDefinition {
  name: string;
  type: QueryCatalogParameterType;
  label?: string;
  description?: string;
  required?: boolean;
  defaultValue?: QueryCatalogParameterValue;
}

const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const INTEGER = /^[+-]?\d+$/;
const NUMBER = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

interface QueryCatalogTemplatePlaceholder {
  name: string;
  start: number;
  end: number;
}

export function normalizeQueryCatalogParameters(input: unknown): QueryCatalogParameterDefinition[] {
  if (input === undefined || input === null || input === '') return [];
  if (!Array.isArray(input)) throw new Error('Query parameters must be an array.');

  const seen = new Set<string>();
  return input.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Query parameter at index ${index} must be an object.`);
    }
    const value = raw as Record<string, unknown>;
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!PARAMETER_NAME.test(name)) {
      throw new Error(`Query parameter at index ${index} has an invalid name: ${name || '<empty>'}.`);
    }
    if (seen.has(name)) throw new Error(`Duplicate query parameter: ${name}.`);
    seen.add(name);

    const type = value.type;
    if (typeof type !== 'string' || !(QUERY_CATALOG_PARAMETER_TYPES as readonly string[]).includes(type)) {
      throw new Error(`Query parameter ${name} has an unsupported type: ${String(type)}.`);
    }

    const definition: QueryCatalogParameterDefinition = {
      name,
      type: type as QueryCatalogParameterType,
    };
    if (typeof value.label === 'string' && value.label.trim()) definition.label = value.label.trim();
    if (typeof value.description === 'string' && value.description.trim()) {
      definition.description = value.description.trim();
    }
    let declaredRequired: boolean | undefined;
    if (value.required !== undefined) {
      if (typeof value.required !== 'boolean') {
        throw new Error(`Query parameter ${name} required must be a boolean.`);
      }
      declaredRequired = value.required;
    }
    const hasDefault = value.defaultValue !== undefined;
    if (hasDefault) {
      if (!isParameterValue(value.defaultValue)) {
        throw new Error(`Query parameter ${name} has an invalid defaultValue.`);
      }
      renderQueryCatalogParameter(definition, value.defaultValue);
      definition.defaultValue = value.defaultValue;
    }
    if (declaredRequired === true && hasDefault) {
      throw new Error(`Required query parameter ${name} cannot declare a defaultValue.`);
    }
    if (declaredRequired === false && !hasDefault) {
      throw new Error(`Optional query parameter ${name} must declare a defaultValue.`);
    }
    // The normalized model derives requiredness from default presence. Keep
    // accepting the legacy `required` input as a validation hint, but do not
    // persist a second independent state that can drift from defaultValue.
    return definition;
  });
}

export function isQueryCatalogParameterRequired(
  definition: QueryCatalogParameterDefinition,
): boolean {
  return definition.defaultValue === undefined;
}

export function parseQueryCatalogParameters(value: string | undefined): QueryCatalogParameterDefinition[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Saved query has invalid prof:queryParameters JSON.');
  }
  return normalizeQueryCatalogParameters(parsed);
}

export function serializeQueryCatalogParameters(input: unknown): string {
  return JSON.stringify(normalizeQueryCatalogParameters(input));
}

export function queryCatalogTemplateParameterNames(template: string): string[] {
  const names: string[] = [];
  for (const placeholder of scanQueryCatalogTemplatePlaceholders(template)) {
    if (!names.includes(placeholder.name)) names.push(placeholder.name);
  }
  return names;
}

export function assertQueryCatalogTemplate(
  template: string,
  definitions: readonly QueryCatalogParameterDefinition[],
): void {
  const normalized = normalizeQueryCatalogParameters(definitions);
  const declared = new Set(normalized.map((definition) => definition.name));
  const used = new Set(queryCatalogTemplateParameterNames(template));
  for (const name of used) {
    if (!declared.has(name)) throw new Error(`SPARQL template uses undeclared query parameter: ${name}.`);
  }
  for (const definition of normalized) {
    if (!used.has(definition.name)) {
      throw new Error(`Query parameter ${definition.name} is not used by the SPARQL template.`);
    }
  }
}

export function renderQueryCatalogTemplate(
  template: string,
  definitions: readonly QueryCatalogParameterDefinition[],
  values: Record<string, unknown>,
): string {
  const normalized = normalizeQueryCatalogParameters(definitions);
  assertQueryCatalogTemplate(template, normalized);
  const declared = new Set(normalized.map((definition) => definition.name));
  for (const name of Object.keys(values)) {
    if (!declared.has(name)) throw new Error(`Unknown query parameter: ${name}.`);
  }

  const rendered = new Map<string, string>();
  for (const definition of normalized) {
    const supplied = values[definition.name];
    const value = isMissing(supplied) ? definition.defaultValue : supplied;
    if (isMissing(value)) {
      throw new Error(`Missing required query parameter: ${definition.name}.`);
    }
    if (!isParameterValue(value)) {
      throw new Error(`Query parameter ${definition.name} must be a string, number, or boolean.`);
    }
    rendered.set(definition.name, renderQueryCatalogParameter(definition, value));
  }

  const placeholders = scanQueryCatalogTemplatePlaceholders(template);
  let output = '';
  let cursor = 0;
  for (const placeholder of placeholders) {
    output += template.slice(cursor, placeholder.start);
    output += rendered.get(placeholder.name)!;
    cursor = placeholder.end;
  }
  return output + template.slice(cursor);
}

export function renderQueryCatalogParameter(
  definition: QueryCatalogParameterDefinition,
  value: QueryCatalogParameterValue,
): string {
  switch (definition.type) {
    case 'string':
      return sparqlString(String(value));
    case 'integer': {
      const normalized = String(value).trim();
      if (!INTEGER.test(normalized)) throw new Error(`Query parameter ${definition.name} must be an integer.`);
      return normalized;
    }
    case 'number': {
      const normalized = String(value).trim();
      if (!NUMBER.test(normalized)) throw new Error(`Query parameter ${definition.name} must be a number.`);
      return normalized;
    }
    case 'boolean': {
      if (value === true || value === 'true') return 'true';
      if (value === false || value === 'false') return 'false';
      throw new Error(`Query parameter ${definition.name} must be true or false.`);
    }
    case 'iri': {
      const normalized = String(value).trim();
      if (!isSafeIri(normalized)) throw new Error(`Query parameter ${definition.name} must be a safe absolute IRI.`);
      return `<${normalized}>`;
    }
  }
}

function isParameterValue(value: unknown): value is QueryCatalogParameterValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isMissing(value: unknown): value is undefined | null {
  return value === undefined || value === null;
}

function scanQueryCatalogTemplatePlaceholders(
  template: string,
): QueryCatalogTemplatePlaceholder[] {
  const placeholders: QueryCatalogTemplatePlaceholder[] = [];
  let index = 0;
  let quote: "'" | '"' | "'''" | '"""' | undefined;
  let inComment = false;
  let inIri = false;

  while (index < template.length) {
    const char = template[index];
    if (inComment) {
      if (char === '\n' || char === '\r') inComment = false;
      index += 1;
      continue;
    }
    if (quote) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (template.startsWith(quote, index)) {
        index += quote.length;
        quote = undefined;
      } else {
        index += 1;
      }
      continue;
    }
    if (inIri) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '>') inIri = false;
      index += 1;
      continue;
    }
    if (char === '#') {
      inComment = true;
      index += 1;
      continue;
    }
    if (template.startsWith("'''", index) || template.startsWith('"""', index)) {
      quote = template.slice(index, index + 3) as "'''" | '"""';
      index += 3;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      index += 1;
      continue;
    }
    if (char === '<' && template[index + 1] !== '=' && !/\s/.test(template[index + 1] ?? '')) {
      inIri = true;
      index += 1;
      continue;
    }
    if (template.startsWith('{{', index)) {
      const match = template.slice(index).match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/);
      if (match) {
        const end = index + match[0].length;
        const before = template[index - 1];
        const after = template[end];
        if ((before && /[A-Za-z0-9_?:.%~-]/.test(before))
          || (after && /[A-Za-z0-9_?:.%~-]/.test(after))) {
          throw new Error(`Query parameter ${match[1]} must occupy a complete SPARQL term position.`);
        }
        placeholders.push({ name: match[1], start: index, end });
        index = end;
        continue;
      }
    }
    index += 1;
  }
  return placeholders;
}
