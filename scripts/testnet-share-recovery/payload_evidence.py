"""Exact complete-graph comparison for the campaign's public, version-1 payloads."""
from collections import defaultdict


XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string'
RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString'


def rdf_tuple(row):
    obj = row['o']
    language = obj.get('xml:lang', '').lower()
    kind = 'literal' if obj['type'] == 'typed-literal' else obj['type']
    datatype = obj.get('datatype', RDF_LANG_STRING if language else XSD_STRING) if kind == 'literal' else None
    return (row['s']['type'], row['s']['value'], row['p']['type'], row['p']['value'], kind, obj['value'], datatype, language)


def expected_payload(arm, name, triples_per_asset):
    return sorted(('uri', f'urn:2963:{arm}:{name}', 'uri', f'https://schema.org/p{i}', 'literal', f'{name} value {i}', XSD_STRING, '') for i in range(triples_per_asset))


def audit_graphs(rows, cg, arm, coordinates, published, on_chain_id=None, triples_per_asset=8):
    by_graph = defaultdict(list)
    for row in rows:
        if row['g']['type'] == 'uri':
            by_graph[row['g']['value']].append(rdf_tuple(row))
    prefix = f'did:dkg:context-graph:{cg}/'
    allowed = set()
    assets = {}
    for name, ual in coordinates.items():
        suffix = '/'.join(ual.split('/')[-2:])
        graphs = {layer: prefix + family + '/' + suffix for layer, family in
                  [('wm', '_working_memory'), ('swm', '_shared_memory'), ('vm', '_verifiable_memory')]}
        allowed.update(graphs.values())
        required = 'vm' if name in published else 'swm'
        expected = expected_payload(arm, name, triples_per_asset)
        present = {layer: values for layer, graph in graphs.items() if (values := by_graph.get(graph))}
        assets[name] = {
            'requiredGraph': graphs[required],
            'requiredGraphPresent': bool(by_graph.get(graphs[required])),
            'contentCounts': {layer: len(values) for layer, values in present.items()},
            'exactContentByGraph': {layer: sorted(values) == expected for layer, values in present.items()},
        }
    materialized = [graph for graph in by_graph if graph.startswith(prefix + 'context/') and '/' not in graph.removeprefix(prefix + 'context/')]
    expected_union = sorted(row for name in published for row in expected_payload(arm, name, triples_per_asset))
    materialized_exact = {graph: sorted(by_graph[graph]) == expected_union for graph in materialized}
    unexpected = sorted(graph for graph in by_graph if graph.startswith(tuple(prefix + family + '/' for family in
                        ['_working_memory', '_shared_memory', '_verifiable_memory'])) and graph not in allowed)
    unexpected.extend(sorted({f"{r['g']['type']}:{r['g']['value']}" for r in rows if r['g']['type'] != 'uri' and r['g']['value'].startswith(prefix)}))
    return {'assets': assets, 'materializedGraphsExact': materialized_exact,
            'materializedGraphPresent': (materialized == [prefix + 'context/' + str(on_chain_id)]) if published else not materialized,
            'unexpectedPayloadGraphs': unexpected}


def same_payload_graphs(before, after, graphs):
    def canonical(rows):
        return sorted((r['g']['type'], r['g']['value'], *rdf_tuple(r)) for r in rows if r['g']['value'] in graphs)
    original = canonical(before)
    return bool(original) and original == canonical(after)
