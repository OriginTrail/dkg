"""Exercise public tool dispatch through the real client to its HTTP boundary."""
import json
from urllib.parse import parse_qs, urlsplit

import pytest


CG = "did:dkg:context-graph:owner/team"
SCOPE = {"context_graph_id": CG, "name": "notes #1", "sub_graph_name": "sub/graph"}
WIRE_SCOPE = {"contextGraphId": "owner/team", "subGraphName": "sub/graph"}
QUADS = [{"subject": "urn:s", "predicate": "urn:p", "object": '"text"'}]


@pytest.mark.parametrize("tool,args,route,payload", [
    ("dkg_send_message", {"peer_id": "peer", "text": "hello"}, "/api/chat", {"to": "peer", "peerId": "peer", "text": "hello"}),
    ("dkg_invoke_skill", {"peer_id": "peer", "skill_uri": "urn:skill", "input": "input"}, "/api/invoke-skill", {"peerId": "peer", "skillUri": "urn:skill", "input": "input"}),
    ("dkg_subscribe", {"context_graph_id": CG, "include_shared_memory": False}, "/api/context-graph/subscribe", {"contextGraphId": "owner/team", "includeSharedMemory": False}),
    ("dkg_subscribe", {"context_graph_id": CG}, "/api/context-graph/subscribe", {"contextGraphId": "owner/team"}),
    ("dkg_context_graph_create", {"name": "Private project"}, "/api/context-graph/create", {"id": "private-project", "name": "Private project", "description": "", "accessPolicy": 1}),
    ("dkg_context_graph_create", {"name": "Public", "public": True, "id": "custom", "description": "description", "allowed_agents": ["ignored"]}, "/api/context-graph/create", {"id": "custom", "name": "Public", "description": "description"}),
    ("dkg_context_graph_create", {"name": "Curated", "allowed_agents": [" 0x" + "1" * 40 + " "]}, "/api/context-graph/create", {"id": "curated", "name": "Curated", "description": "", "accessPolicy": 1, "allowedAgents": ["0x" + "1" * 40]}),
    ("dkg_context_graph_create", {"name": "Empty", "allowed_agents": []}, "/api/context-graph/create", {"id": "empty", "name": "Empty", "description": "", "accessPolicy": 1}),
    ("dkg_participant_add", {"context_graph_id": CG, "agent_address": "0xabc"}, "/api/context-graph/owner%2Fteam/add-participant", {"agentAddress": "0xabc"}),
    ("dkg_participant_remove", {"context_graph_id": CG, "agent_address": "0xabc"}, "/api/context-graph/owner%2Fteam/remove-participant", {"agentAddress": "0xabc"}),
    ("dkg_join_request_approve", {"context_graph_id": CG, "agent_address": "0xabc"}, "/api/context-graph/owner%2Fteam/approve-join", {"agentAddress": "0xabc"}),
    ("dkg_join_request_reject", {"context_graph_id": CG, "agent_address": "0xabc"}, "/api/context-graph/owner%2Fteam/reject-join", {"agentAddress": "0xabc"}),
    ("dkg_knowledge_asset_write", {**SCOPE, "quads": QUADS}, "/api/knowledge-assets/notes%20%231/wm/write", {**WIRE_SCOPE, "quads": QUADS}),
    ("dkg_knowledge_asset_discard", SCOPE, "/api/knowledge-assets/notes%20%231/wm/discard", WIRE_SCOPE),
    ("dkg_knowledge_asset_pull_from", {**SCOPE, "layer": "vm"}, "/api/knowledge-assets/notes%20%231/wm/pull-from", {**WIRE_SCOPE, "layer": "vm"}),
    ("dkg_sub_graph_create", SCOPE, "/api/sub-graph/create", WIRE_SCOPE),
    ("dkg_knowledge_asset_import_artifact_resolve", {**SCOPE, "assertion_uri": "urn:source", "assertion_name": "source", "file_hash": "abc"}, "/api/knowledge-assets/import-artifact/resolve", {**WIRE_SCOPE, "assertionUri": "urn:source", "assertionName": "source", "fileHash": "abc"}),
    ("dkg_knowledge_asset_import_artifact_read_markdown", {**SCOPE, "source_assertion_uri": "urn:source", "assertion_name": "source", "file_hash": "abc", "max_bytes": " 100 "}, "/api/knowledge-assets/import-artifact/read-markdown", {**WIRE_SCOPE, "assertionUri": "urn:source", "assertionName": "source", "fileHash": "abc", "maxBytes": 100}),
    ("dkg_knowledge_asset_semantic_enrichment_write", {**{k: v for k, v in SCOPE.items() if k != "name"}, "assertion_uri": "urn:source", "assertion_name": "source", "file_hash": "abc", "generation_method": "method", "agent_identity": "agent", "generated_at": "2026-01-01", "semantic_quads": QUADS}, "/api/knowledge-assets/semantic-enrichment/write", {**WIRE_SCOPE, "assertionUri": "urn:source", "assertionName": "source", "fileHash": "abc", "generationMethod": "method", "agentIdentity": "agent", "generatedAt": "2026-01-01", "semanticQuads": QUADS}),
])
def test_mutation_tools_preserve_exact_route_scope_and_payload(provider_factory, tool, args, route, payload):
    provider = provider_factory()
    provider_factory.post.reset_mock()
    provider_factory.post.return_value = {"success": True, "receipt": "test-receipt"}
    assert json.loads(provider.handle_tool_call(tool, args)) == {"success": True, "receipt": "test-receipt"}
    provider_factory.post.assert_called_once_with(route, payload)


@pytest.mark.parametrize("tool,args,path,query", [
    ("dkg_wallet_balances", {}, "/api/wallets/balances", {}),
    ("dkg_read_messages", {}, "/api/messages", {}),
    ("dkg_read_messages", {"peer": "a/b", "limit": 5, "since": 123}, "/api/messages", {"peer": ["a/b"], "limit": ["5"], "since": ["123"]}),
    ("dkg_participant_list", SCOPE, "/api/context-graph/owner%2Fteam/participants", {}),
    ("dkg_join_request_list", SCOPE, "/api/context-graph/owner%2Fteam/join-requests", {}),
    ("dkg_sub_graph_list", SCOPE, "/api/sub-graph/list", {"contextGraphId": ["owner/team"]}),
    ("dkg_knowledge_asset_query", SCOPE, "/api/knowledge-assets/notes%20%231/wm/quads", {"contextGraphId": ["owner/team"], "subGraphName": ["sub/graph"]}),
    ("dkg_knowledge_asset_history", {**SCOPE, "agent_address": "0xabc"}, "/api/knowledge-assets/notes%20%231", {"contextGraphId": ["owner/team"], "subGraphName": ["sub/graph"], "agentAddress": ["0xabc"]}),
])
def test_read_tools_encode_scope_once_and_return_daemon_result(provider_factory, tool, args, path, query):
    provider = provider_factory()
    provider_factory.get.reset_mock()
    provider_factory.get.return_value = {"rows": ["daemon-result"]}
    assert json.loads(provider.handle_tool_call(tool, args)) == {"rows": ["daemon-result"]}
    provider_factory.get.assert_called_once()
    url = urlsplit(provider_factory.get.call_args.args[0])
    assert url.path == path
    assert parse_qs(url.query) == query


OFFLINE_TOOLS = ["dkg_query", "dkg_wallet_balances", "dkg_list_context_graphs", "dkg_find_agents", "dkg_send_message",
    "dkg_read_messages", "dkg_invoke_skill", "dkg_subscribe", "dkg_context_graph_create", "dkg_context_graph_invite",
    "dkg_participant_add", "dkg_participant_remove", "dkg_participant_list", "dkg_join_request_list", "dkg_join_request_approve", "dkg_join_request_reject",
    *["dkg_knowledge_asset_" + suffix for suffix in ("create", "write", "share", "finalize", "publish", "pull_from", "discard", "import_file", "query", "history", "import_artifact_resolve", "import_artifact_read_markdown", "semantic_enrichment_write")],
    "dkg_sub_graph_create", "dkg_sub_graph_list"]


@pytest.mark.parametrize("tool", OFFLINE_TOOLS)
def test_offline_tools_fail_before_any_transport_call(provider_factory, tool):
    provider = provider_factory()
    provider._offline = True
    provider_factory.post.reset_mock()
    provider_factory.get.reset_mock()
    assert "offline" in json.loads(provider.handle_tool_call(tool, {}))["error"]
    provider_factory.post.assert_not_called()
    provider_factory.get.assert_not_called()


@pytest.mark.parametrize("tool,args,error", [
    ("dkg_send_message", {}, "Both peer_id and text"), ("dkg_send_message", {"peer_id": "peer"}, "Both peer_id and text"),
    ("dkg_invoke_skill", {}, "peer_id and skill_uri"), ("dkg_invoke_skill", {"peer_id": "peer"}, "peer_id and skill_uri"),
    ("dkg_subscribe", {}, "context_graph_id"), ("dkg_subscribe", {"context_graph_id": CG, "include_shared_memory": "yes"}, "boolean"),
    ("dkg_context_graph_create", {}, "name is required"), ("dkg_context_graph_create", {"name": "team", "public": "yes"}, "boolean"),
    *[("dkg_context_graph_create", {"name": "team", "allowed_agents": value}, error) for value, error in [("agent", "array"), ([42], "string"), ([" "], "empty"), (["0x12"], "Invalid Ethereum")]],
    *[(tool, args, error) for tool in ("dkg_context_graph_invite", "dkg_participant_add", "dkg_participant_remove", "dkg_join_request_approve", "dkg_join_request_reject") for args, error in [({}, "context_graph_id"), ({"context_graph_id": CG}, "peer_id" if tool.endswith("invite") else "agent_address")]],
    *[(tool, {}, "context_graph_id") for tool in ("dkg_participant_list", "dkg_join_request_list", "dkg_sub_graph_create", "dkg_sub_graph_list")],
    ("dkg_sub_graph_create", {"context_graph_id": CG}, "sub_graph_name"),
    *[("dkg_knowledge_asset_" + suffix, args, error) for suffix in ("create", "write", "share", "finalize", "publish", "pull_from", "discard", "import_file", "query", "history") for args, error in [({}, "context_graph_id"), ({"context_graph_id": CG}, "name is required")]],
    ("dkg_knowledge_asset_import_file", SCOPE, "file_path"),
    *[("dkg_knowledge_asset_" + suffix, args, error) for suffix in ("import_artifact_resolve", "import_artifact_read_markdown", "semantic_enrichment_write") for args, error in [({}, "context_graph_id"), ({"context_graph_id": CG}, "assertion_uri")]],
    *[("dkg_knowledge_asset_import_artifact_read_markdown", {"context_graph_id": CG, "assertion_uri": "urn:source", "max_bytes": value}, "positive integer") for value in (True, "", "nan", 1.5, 0, -1)],
    *[("dkg_knowledge_asset_semantic_enrichment_write", {"context_graph_id": CG, "assertion_uri": "urn:source", key: "forbidden"}, "target assertion names") for key in ("name", "semanticAssertionName", "semantic_assertion_name")],
    ("dkg_knowledge_asset_semantic_enrichment_write", {"context_graph_id": CG, "assertion_uri": "urn:source", "semantic_quads": []}, "semantic_quads"),
])
def test_invalid_tool_arguments_fail_without_io(provider_factory, tool, args, error):
    provider = provider_factory()
    provider_factory.post.reset_mock()
    provider_factory.get.reset_mock()
    assert error in json.loads(provider.handle_tool_call(tool, args))["error"]
    provider_factory.post.assert_not_called()
    provider_factory.get.assert_not_called()


def test_status_distinguishes_offline_queue_from_connected_identity(provider_factory):
    provider = provider_factory()
    online = json.loads(provider.handle_tool_call("dkg_status", {}))
    assert online == {"status": "connected", "daemon_url": "http://127.0.0.1:9200", "node": {"peerId": "peer-local"}, "context_graphs": {"peerId": "peer-local"}, "assertion_id": "memory", "agent_name": "hermes", "session_id": provider._session_id, "turn_count": 0}
    provider._offline = True
    provider.on_memory_write("add", "memory", "fact")
    offline = json.loads(provider.handle_tool_call("dkg_status", {}))
    assert offline == {"status": "offline", "daemon_url": "http://127.0.0.1:9200", "cached_memory_entries": 1, "cached_user_entries": 0, "queued_writes": 1}


@pytest.mark.parametrize("quads", [None, "invalid", [42], [{"subject": "urn:s"}], []])
def test_writes_require_complete_quad_arrays(provider_factory, quads):
    provider = provider_factory()
    provider_factory.post.reset_mock()
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_write", {**SCOPE, "quads": quads}))
    assert "quads must contain" in out["error"]
    provider_factory.post.assert_not_called()


@pytest.mark.parametrize("args,error", [
    ({"quads": []}, "quads must contain"), ({"also_share_swm": "yes"}, "boolean"),
])
def test_create_validation_stops_before_creating_a_draft(provider_factory, args, error):
    provider = provider_factory()
    provider_factory.post.reset_mock()
    assert error in json.loads(provider.handle_tool_call("dkg_knowledge_asset_create", {**SCOPE, **args}))["error"]
    provider_factory.post.assert_not_called()


@pytest.mark.parametrize("share", [False, True])
def test_create_normalizes_quads_and_shares_only_by_explicit_opt_in(provider_factory, share):
    provider = provider_factory()
    provider_factory.post.reset_mock()
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_create", {**SCOPE, "quads": [{"subject": "<urn:s>", "predicate": "<urn:p>", "object": "text", "graph": "urn:untrusted"}], "also_share_swm": share}))
    assert out["success"]
    provider_factory.post.assert_called_once_with("/api/knowledge-assets", {**WIRE_SCOPE, "name": "notes #1", "quads": QUADS, **({"alsoShareSwm": True} if share else {})})


def test_partial_create_surfaces_share_failure_instead_of_publish_ready(provider_factory):
    provider = provider_factory()
    provider_factory.post.return_value = {"sealed": True, "errors": [{"phase": "swm-share", "error": "peer unavailable"}]}
    result = json.loads(provider.handle_tool_call("dkg_knowledge_asset_create", {**SCOPE, "quads": QUADS, "also_share_swm": True}))
    assert "Created and sealed" in result["error"]
    assert "peer unavailable" in result["error"] and "NOT publish-ready" in result["error"]


@pytest.mark.parametrize("quads,error", [([42], "must be an object"), ([{**QUADS[0], "graph": "urn:foreign"}], ".graph is not supported"), ([{"subject": " "}], "non-empty")])
def test_semantic_enrichment_never_writes_to_another_graph(provider_factory, quads, error):
    provider = provider_factory()
    provider_factory.post.reset_mock()
    args = {"context_graph_id": CG, "assertion_uri": "urn:source", "semantic_quads": quads}
    assert error in json.loads(provider.handle_tool_call("dkg_knowledge_asset_semantic_enrichment_write", args))["error"]
    provider_factory.post.assert_not_called()


def test_minimal_markdown_and_semantic_tools_preserve_source_identity(provider_factory):
    provider = provider_factory()
    args = {"context_graph_id": CG, "source_assertion_uri": "urn:source"}
    provider.handle_tool_call("dkg_knowledge_asset_import_artifact_read_markdown", args)
    provider_factory.post.assert_called_with("/api/knowledge-assets/import-artifact/read-markdown", {"contextGraphId": "owner/team", "assertionUri": "urn:source"})
    provider.handle_tool_call("dkg_knowledge_asset_semantic_enrichment_write", {**args, "semantic_quads": [{"subject": " urn:s ", "predicate": " urn:p ", "object": " simple text "}]})
    provider_factory.post.assert_called_with("/api/knowledge-assets/semantic-enrichment/write", {"contextGraphId": "owner/team", "assertionUri": "urn:source", "semanticQuads": [{"subject": "urn:s", "predicate": "urn:p", "object": '"simple text"'}]})


def test_file_import_dispatch_preserves_all_optional_metadata(provider_factory, monkeypatch):
    from unittest.mock import Mock
    provider = provider_factory()
    upload = Mock(return_value={"status": "completed"})
    monkeypatch.setattr(provider._client, "import_assertion_file", upload)
    assert json.loads(provider.handle_tool_call("dkg_knowledge_asset_import_file", {**SCOPE, "file_path": "/approved/doc.md", "content_type": "text/markdown", "ontology_ref": "urn:ontology"})) == {"status": "completed"}
    upload.assert_called_once_with("notes #1", CG, "/approved/doc.md", content_type="text/markdown", ontology_ref="urn:ontology", sub_graph_name="sub/graph")


@pytest.mark.parametrize("value", [-1, 2.5])
def test_publish_rejects_negative_or_fractional_node_identity(provider_factory, value):
    provider = provider_factory()
    provider_factory.post.reset_mock()
    result = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {**SCOPE, "publisher_node_identity_id_override": value}))
    assert "non-negative integer" in result["error"]
    provider_factory.post.assert_not_called()
