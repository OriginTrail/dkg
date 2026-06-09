"""Parity guard: no per-quad `graph` on the write/publish path.

CONTRACT §0 invariant 2 — the write wire shape is {subject,predicate,object};
the daemon pins every triple to the per-KA graph itself and overrides any
client-supplied graph. OpenClaw (PR1) and MCP (PR2) both dropped the per-quad
`graph` field from the write + one-shot-publish quad schemas and normalizer;
Hermes must match. The legitimate graph-scoping read params on dkg_query
(verified_graph / graph_suffix) are NOT per-quad write fields and stay.
"""

from __future__ import annotations


def _quad_item_props(schema):
    return schema["parameters"]["properties"]["quads"]["items"]["properties"]


def test_write_schema_quads_have_no_graph(plugin_module):
    write = plugin_module.DKG_ASSERTION_WRITE_SCHEMA
    props = _quad_item_props(write)
    assert set(props) == {"subject", "predicate", "object"}
    assert "graph" not in props


def test_publish_schema_quads_have_no_graph(plugin_module):
    publish = plugin_module.DKG_PUBLISH_SCHEMA
    props = _quad_item_props(publish)
    assert "graph" not in props


def test_normalize_quads_drops_client_supplied_graph(plugin_module):
    out = plugin_module._normalize_quads([
        {
            "subject": "urn:s",
            "predicate": "urn:p",
            "object": "urn:o",
            "graph": "urn:graph:should-be-dropped",
        }
    ])
    assert out == [{"subject": "urn:s", "predicate": "urn:p", "object": "urn:o"}]
    assert "graph" not in out[0]


def test_dkg_query_handler_keeps_graph_scoping_read_params(plugin_module):
    # verified_graph / graph_suffix are graph-SCOPING read params on the SPARQL
    # tool (forwarded by the dkg_query handler), NOT per-quad write fields — the
    # graph-field removal must not touch them.
    provider = plugin_module.DKGMemoryProvider()
    provider._offline = False
    provider._context_graph = ""

    captured = {}

    class QueryClient:
        def query(self, sparql, context_graph_id=None, **kwargs):
            captured.update(kwargs)
            return {"results": {"bindings": []}}

    provider._client = QueryClient()
    provider.handle_tool_call("dkg_query", {
        "sparql": "ASK {}",
        "verified_graph": "urn:vg",
        "graph_suffix": "tuesday",
    })
    assert captured.get("verified_graph") == "urn:vg"
    assert captured.get("graph_suffix") == "tuesday"


# -- A: client-level wire-level strip (CONTRACT §A) -------------------------

def test_write_assertion_strips_graph_at_the_wire(recording_client):
    # A hand-built quad carrying `graph` must not reach the POST body — the
    # client strips it even when the schema is bypassed (CONTRACT §A).
    client = recording_client
    client.write_assertion("ka", "cg1", [
        {"subject": "urn:s", "predicate": "urn:p", "object": "urn:o", "graph": "urn:g"},
    ])
    path, body = client.posts[-1]
    assert path == "/api/knowledge-assets/ka/wm/write"
    assert body["quads"] == [{"subject": "urn:s", "predicate": "urn:p", "object": "urn:o"}]
    assert all("graph" not in q for q in body["quads"])
