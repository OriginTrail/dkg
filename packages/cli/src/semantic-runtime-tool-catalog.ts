/** The built-in capabilities used by both bound Program execution and the editor. */
export const PROGRAM_TOOL_CATALOG = [
  { kind: 'sparqlRead', toolIri: 'urn:dkg:tool:sparql-read', label: 'SPARQL read',
    description: 'Run read-only SPARQL within the selected graph, with bounded results.',
    definition: { operation: 'dkg/sparql-read', version: '1', wit: 'origintrail:semantic-runtime/sparql-read@0.1.0' } },
  { kind: 'query', toolIri: 'urn:dkg:tool:query', label: 'Saved query',
    description: 'Run one approved query from this graph’s query catalog.',
    definition: { operation: 'dkg/query', version: '1', wit: 'origintrail:semantic-runtime/query-catalog@0.1.0' } },
  { kind: 'assetCreation', toolIri: 'urn:dkg:tool:asset-create', label: 'Create Knowledge Asset',
    description: 'Create an asset from RDF triples in the selected graph.',
    definition: { operation: 'dkg/asset-create', version: '1', wit: 'origintrail:semantic-runtime/asset-create@0.1.0' } },
] as const;

export function programToolDefinition(kind: typeof PROGRAM_TOOL_CATALOG[number]['kind']) {
  return PROGRAM_TOOL_CATALOG.find(tool => tool.kind === kind)!.definition;
}
