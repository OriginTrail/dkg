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
const PARAMETER_PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;
const INTEGER = /^[+-]?\d+$/;
const NUMBER = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;
const SAFE_IRI = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>"{}|\\^`\x00-\x20]+$/;

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
    if (value.required !== undefined) {
      if (typeof value.required !== 'boolean') {
        throw new Error(`Query parameter ${name} required must be a boolean.`);
      }
      definition.required = value.required;
    }
    if (value.defaultValue !== undefined) {
      if (!isParameterValue(value.defaultValue)) {
        throw new Error(`Query parameter ${name} has an invalid defaultValue.`);
      }
      renderQueryCatalogParameter(definition, value.defaultValue);
      definition.defaultValue = value.defaultValue;
    }
    if (definition.required === false && definition.defaultValue === undefined) {
      throw new Error(`Optional query parameter ${name} must declare a defaultValue.`);
    }
    return definition;
  });
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
  for (const match of template.matchAll(PARAMETER_PLACEHOLDER)) {
    if (!names.includes(match[1])) names.push(match[1]);
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

  return template.replace(PARAMETER_PLACEHOLDER, (_placeholder, name: string) => rendered.get(name)!);
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
      if (!SAFE_IRI.test(normalized)) throw new Error(`Query parameter ${definition.name} must be a safe absolute IRI.`);
      return `<${normalized}>`;
    }
  }
}

function isParameterValue(value: unknown): value is QueryCatalogParameterValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isMissing(value: unknown): value is undefined | null | '' {
  return value === undefined || value === null || value === '';
}

function sparqlString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}
