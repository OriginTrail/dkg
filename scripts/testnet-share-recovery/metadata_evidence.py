"""Authoritative metadata selection shared by main-run evidence reducers."""
from collections import defaultdict


def index_authoritative_metadata(rows, metadata_graph):
    index = defaultdict(list)
    for row in rows:
        if row['g']['type'] == 'uri' and row['g']['value'] == metadata_graph:
            index[row['s']['value']].append(row)
    return index


def preserves_original_operation(before, after):
    """Compare the complete immutable record, including cardinality and RDF kinds."""
    import json
    from collections import Counter
    from payload_evidence import rdf_tuple, XSD_STRING
    prefix = 'http://dkg.io/ontology/'
    predicates = {prefix + 'shareOperationId', prefix + 'promoteOperationIntent'}
    original = [row for row in before if row['p']['value'] in predicates]
    if not original:
        return True  # A newly shared draft had no original operation to preserve.
    if Counter(row['p']['value'] for row in original) != Counter({p: 1 for p in predicates}):
        return False
    values = {}
    for row in original:
        obj = row['o']
        if (row['s']['type'] != 'uri' or row['p']['type'] != 'uri'
                or obj['type'] not in ('literal', 'typed-literal')
                or obj.get('datatype', XSD_STRING) != XSD_STRING or obj.get('xml:lang')):
            return False
        values[row['p']['value']] = obj['value']
    try:
        intent = json.loads(values[prefix + 'promoteOperationIntent'])
        if not isinstance(intent, dict):
            return False
        peers = intent.get('allowedPeers')
        peer = intent.get('publisherPeerId')
        if (type(intent.get('version')) is not int or intent['version'] != 1 or not values[prefix + 'shareOperationId']
                or intent.get('operationId') != values[prefix + 'shareOperationId']
                or type(intent.get('timestampMs')) is not int or not 0 < intent['timestampMs'] <= 9007199254740991
                or type(intent.get('confirmationRequired')) is not bool
                or intent.get('accessPolicy') not in ('public', 'ownerOnly', 'allowList')
                or not isinstance(peers, list) or any(not isinstance(p, str) or not p or p != p.strip() for p in peers)
                or peers != sorted(set(peers)) or (intent['accessPolicy'] == 'allowList') != bool(peers)
                or ('publisherPeerId' in intent and (not isinstance(peer, str) or not peer or peer != peer.strip()))):
            return False
    except (ValueError, TypeError):
        return False
    current = [row for row in after if row['p']['value'] in predicates]
    return Counter(map(rdf_tuple, original)) == Counter(map(rdf_tuple, current))
