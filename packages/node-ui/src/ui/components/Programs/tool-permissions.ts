import type { OutputSchema, RequestedToolPermissions } from '@origintrail-official/dkg-graph-computer';
import type { ToolKind } from './client.js';

export const toolIris = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];
export const canonicalGraph = (graph: string) => graph.trim().replace(/^did:dkg:context-graph:/, '');
export function readPermissions(text: string): RequestedToolPermissions | undefined {
  if (!text.trim()) return undefined;
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.graphId !== 'string'
    || Object.keys(value).some(key => !['graphId', 'executionLayer', 'query', 'sparqlRead', 'assetCreation'].includes(key))) {
    throw new Error('Permissions need graphId and only query, sparqlRead, assetCreation or executionLayer fields.');
  }
  return value;
}
export function toolFor(kind: ToolKind, permissions: RequestedToolPermissions, tools: string[]): string | undefined {
  if (kind === 'query') return tools.find(iri => iri !== permissions.sparqlRead?.toolIri && iri !== permissions.assetCreation?.toolIri);
  return permissions[kind]?.toolIri;
}
export function rowSchema(columns = ['s', 'p', 'o'], maxItems = 100): OutputSchema {
  return { type: 'object', additionalProperties: false, required: ['bindings'], properties: {
    bindings: { type: 'array', maxItems, items: { type: 'object', additionalProperties: false,
      required: columns, properties: Object.fromEntries(columns.map(name => [name, { type: 'string', maxLength: 1024 }])) } },
  } };
}
/** Only expose a simplified form when it can preserve the complete schema. */
export function simpleRows(schema: OutputSchema) {
  if (schema?.type !== 'object' || !schema.properties || !Array.isArray(schema.required) || Object.keys(schema.properties).join() !== 'bindings' || schema.required.join() !== 'bindings') return null;
  const rows = schema.properties.bindings;
  if (rows?.type !== 'array' || rows.items?.type !== 'object' || !rows.items.properties || !Array.isArray(rows.items.required)) return null;
  if (!Object.values(rows.items.properties).every(column => column && column.type === 'string')) return null;
  return { rows, item: rows.items };
}
export function toolCall(kind: ToolKind, iri: string, permissions: RequestedToolPermissions, parameters: Record<string, string> = {}) {
  let input: unknown;
  if (kind === 'query') input = { selector: permissions.query?.selector ?? '', ...(Object.keys(parameters).length ? { parameters } : {}) };
  else if (kind === 'assetCreation') input = { quads: [{ subject: 'urn:example:report', predicate: 'http://schema.org/name', object: '"My report"' }] };
  else {
    const rows = permissions.sparqlRead && simpleRows(permissions.sparqlRead.outputSchema);
    const columns = rows ? Object.keys(rows.item.properties) : ['s', 'p', 'o'];
    const pattern = columns.join() === 's,p,o' ? '?s ?p ?o .' : '/* Add your graph pattern here */';
    input = { sparql: `SELECT ${columns.map(name => `?${name}`).join(' ')} WHERE { ${pattern} } LIMIT ${permissions.sparqlRead?.maxResultItems ?? 100}` };
  }
  return `import { invoke_tool } from '@origintrail-official/dkg-graph-computer/program';\n\n// Inside your async run() function:\nconst result = await invoke_tool(${JSON.stringify(iri)}, ${JSON.stringify(input, null, 2)});`;
}
