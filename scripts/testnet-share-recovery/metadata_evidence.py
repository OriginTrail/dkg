"""Authoritative metadata selection shared by main-run evidence reducers."""
from collections import defaultdict


def index_authoritative_metadata(rows, metadata_graph):
    index = defaultdict(list)
    for row in rows:
        if row['g']['type'] == 'uri' and row['g']['value'] == metadata_graph:
            index[row['s']['value']].append(row)
    return index
