import unittest
from payload_evidence import audit_graphs
from metadata_evidence import index_authoritative_metadata

CG, ARM, NAME, UAL = 'cg', 'test', 'asset', 'did:dkg:base:84532/0xabc/1'
GRAPH = 'did:dkg:context-graph:cg/_shared_memory/0xabc/1'


def row(subject, predicate, value, graph=GRAPH):
    return {'g': {'value': graph}, 's': {'value': subject}, 'p': {'value': predicate}, 'o': {'type': 'literal', 'value': value}}


def payload():
    return [row('urn:2963:test:asset', f'https://schema.org/p{i}', f'asset value {i}') for i in range(8)]


class ExactGraphEvidence(unittest.TestCase):
    def test_non_injected_metadata_relocated_under_same_context_graph_is_missing(self):
        graph = 'did:dkg:context-graph:cg/_meta'
        seal, lifecycle = 'did:dkg:context-graph:cg/assertion/author/catalog-000', 'urn:dkg:assertion:cg:author:catalog-000'
        rows = [row(seal, 'http://dkg.io/ontology/kaUal', UAL, graph),
                row(lifecycle, 'http://dkg.io/ontology/state', 'promoted', graph)]
        for item in rows:
            item['g']['type'] = 'uri'
        original = index_authoritative_metadata(rows, graph)
        self.assertEqual(len(original[seal]), 1)
        self.assertEqual(len(original[lifecycle]), 1)
        for item in rows:
            item['g']['value'] = graph + '-relocated'
        moved = index_authoritative_metadata(rows, graph)
        self.assertEqual(moved[seal], [])
        self.assertEqual(moved[lifecycle], [])

    def audit(self, rows):
        return audit_graphs(rows, CG, ARM, {NAME: UAL}, set())

    def test_exact_complete_graph(self):
        proof = self.audit(payload())['assets'][NAME]
        self.assertTrue(proof['requiredGraphPresent'])
        self.assertEqual(proof['exactContentByGraph'], {'swm': True})

    def test_unexpected_subject_is_not_filtered_out(self):
        proof = self.audit(payload() + [row('urn:unexpected', 'urn:p', 'corrupt')])['assets'][NAME]
        self.assertEqual(proof['exactContentByGraph'], {'swm': False})

    def test_missing_content(self):
        self.assertFalse(self.audit(payload()[:-1])['assets'][NAME]['exactContentByGraph']['swm'])
        self.assertFalse(self.audit([])['assets'][NAME]['requiredGraphPresent'])

    def test_content_in_wrong_graph(self):
        rows = payload()
        for item in rows:
            item['g']['value'] = GRAPH + '-wrong'
        proof = self.audit(rows)
        self.assertFalse(proof['assets'][NAME]['requiredGraphPresent'])
        self.assertEqual(proof['unexpectedPayloadGraphs'], [GRAPH + '-wrong'])


if __name__ == '__main__':
    unittest.main()
