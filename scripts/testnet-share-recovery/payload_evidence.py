"""Exact complete-graph comparison for the campaign's public, version-1 payloads."""
from collections import defaultdict


def rdf_tuple(row):
    obj = row['o']
    return (row['s']['value'], row['p']['value'], obj['type'], obj['value'], obj.get('datatype'), obj.get('xml:lang'))


def expected_payload(arm, name):
    return sorted((f'urn:2963:{arm}:{name}', f'https://schema.org/p{i}', 'literal', f'{name} value {i}', None, None) for i in range(8))


def audit_graphs(rows, cg, arm, coordinates, published, on_chain_id=None):
    by_graph = defaultdict(list)
    for row in rows:
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
        expected = expected_payload(arm, name)
        present = {layer: values for layer, graph in graphs.items() if (values := by_graph.get(graph))}
        assets[name] = {
            'requiredGraph': graphs[required],
            'requiredGraphPresent': bool(by_graph.get(graphs[required])),
            'contentCounts': {layer: len(values) for layer, values in present.items()},
            'exactContentByGraph': {layer: sorted(values) == expected for layer, values in present.items()},
        }
    materialized = [graph for graph in by_graph if graph.startswith(prefix + 'context/') and '/' not in graph.removeprefix(prefix + 'context/')]
    expected_union = sorted(row for name in published for row in expected_payload(arm, name))
    materialized_exact = {graph: sorted(by_graph[graph]) == expected_union for graph in materialized}
    unexpected = sorted(graph for graph in by_graph if graph.startswith(tuple(prefix + family + '/' for family in
                        ['_working_memory', '_shared_memory', '_verifiable_memory'])) and graph not in allowed)
    return {'assets': assets, 'materializedGraphsExact': materialized_exact,
            'materializedGraphPresent': (materialized == [prefix + 'context/' + str(on_chain_id)]) if published else not materialized,
            'unexpectedPayloadGraphs': unexpected}
