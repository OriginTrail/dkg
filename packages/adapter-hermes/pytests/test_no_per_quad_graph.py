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


def test_create_schema_quads_have_no_graph(plugin_module):
    # [D3] dkg_knowledge_asset_create now carries optional quads (one-call
    # create+write); they use the same no-graph write quad shape.
    create = plugin_module.DKG_ASSERTION_CREATE_SCHEMA
    props = _quad_item_props(create)
    assert set(props) == {"subject", "predicate", "object"}
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


# -- [D3] alsoShareSwm default-false leak guard (parity with the TS adapters) --
# The createKnowledgeAsset CLIENT HELPER in the TS adapters force-injects
# alsoShareSwm:true when a quads-create seals, so the TS handlers forward the
# flag explicitly to suppress it. Hermes' create_assertion builds the POST body
# DIRECTLY (no such helper) and emits alsoShareSwm ONLY when also_share_swm is
# true — so a default/false create must NEVER carry alsoShareSwm:true on the wire.
# These tests pin that invariant at the body level so a future body-builder change
# can't silently auto-share a private draft.

def test_create_quads_without_share_omits_also_share_swm(recording_client):
    client = recording_client
    client.create_assertion(context_graph_id="cg1", name="ka", quads=[
        {"subject": "urn:s", "predicate": "urn:p", "object": "urn:o"},
    ])
    path, body = client.posts[-1]
    assert path == "/api/knowledge-assets"
    # Arg-order / serialization guard: contextGraphId and name must not be swapped.
    assert body["contextGraphId"] == "cg1"
    assert body["name"] == "ka"
    assert "quads" in body
    # No alsoShareSwm on a private create — the daemon shares only on === true.
    assert "alsoShareSwm" not in body


def test_create_quads_explicit_false_does_not_share(recording_client):
    client = recording_client
    client.create_assertion(context_graph_id="cg1", name="ka", quads=[
        {"subject": "urn:s", "predicate": "urn:p", "object": "urn:o"},
    ], also_share_swm=False)
    _, body = client.posts[-1]
    assert body["contextGraphId"] == "cg1"
    assert body["name"] == "ka"
    assert body.get("alsoShareSwm") is not True
    assert "alsoShareSwm" not in body


def test_create_quads_with_share_sends_also_share_swm_true(recording_client):
    client = recording_client
    client.create_assertion(context_graph_id="cg1", name="ka", quads=[
        {"subject": "urn:s", "predicate": "urn:p", "object": "urn:o"},
    ], also_share_swm=True)
    _, body = client.posts[-1]
    assert body["contextGraphId"] == "cg1"
    assert body["name"] == "ka"
    assert body["alsoShareSwm"] is True


def test_create_without_quads_never_sends_also_share_swm(recording_client):
    # also_share_swm is meaningless without quads; the no-quads branch never emits it.
    client = recording_client
    client.create_assertion(context_graph_id="cg1", name="ka", also_share_swm=True)
    _, body = client.posts[-1]
    assert body["contextGraphId"] == "cg1"
    assert body["name"] == "ka"
    assert "alsoShareSwm" not in body
    assert "quads" not in body
