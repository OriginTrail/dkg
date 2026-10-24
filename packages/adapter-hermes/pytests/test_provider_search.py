"""Recall routing, trust ranking, duplicate suppression, and offline fallback."""
import json
import pytest


def tool(provider, name, args):
    return json.loads(provider.handle_tool_call(name, args))


@pytest.mark.parametrize("args,error", [
    ({}, "SPARQL query is required"),
    *[({"sparql": "ASK {}", key: "x"}, "not a supported parameter") for key in ("contextGraph_id", "contextGraphId", "context_graph")],
    *[({"sparql": "ASK {}", key: True}, "no longer supported") for key in ("include_shared_memory", "includeSharedMemory")],
    ({"sparql": "ASK {}", "view": "invalid"}, "must be one of"),
    ({"sparql": "ASK {}", "view": "working-memory"}, "requires"),
    ({"sparql": "ASK {}", "view": "working-memory", "context_graph_id": "team", "sub_graph_name": "sub"}, "cannot be combined"),
    ({"sparql": "ASK {}", "agent_address": 42}, "must be a string"),
    ({"sparql": "ASK {}", "agent_address": " "}, "non-empty"),
])
def test_query_rejects_ambiguous_scope_without_io(provider_factory, args, error):
    provider = provider_factory()
    provider_factory.post.reset_mock()
    provider_factory.get.reset_mock()
    assert error in tool(provider, "dkg_query", args)["error"]
    provider_factory.post.assert_not_called()
    provider_factory.get.assert_not_called()


def test_working_memory_resolves_identity_checksums_it_and_retries_if_unavailable(provider_factory):
    provider = provider_factory()
    provider_factory.get.return_value = {}
    args = {"sparql": "ASK {}", "context_graph_id": "did:dkg:context-graph:team", "view": "working-memory"}
    provider_factory.post.reset_mock()
    assert "retry after identity" in tool(provider, "dkg_query", args)["error"]
    provider_factory.post.assert_not_called()
    provider_factory.get.return_value = {"agentAddress": "0x52908400098527886e0f7030069857d2e4169ee7"}
    tool(provider, "dkg_query", args)
    provider_factory.post.assert_called_once_with("/api/query", {"sparql": "ASK {}", "contextGraphId": "team", "view": "working-memory", "agentAddress": "0x52908400098527886E0F7030069857D2E4169EE7"})
    provider_factory.get.reset_mock()
    tool(provider, "dkg_query", args)
    provider_factory.get.assert_not_called()  # successful identity is cached


def test_query_forwards_legacy_scope_without_losing_zero_trust(provider_factory):
    provider = provider_factory()
    tool(provider, "dkg_query", {"sparql": "SELECT * {}", "assertion_name": "asset", "sub_graph_name": "sub", "verified_graph": "urn:g", "graph_suffix": "suffix", "min_trust": 0})
    provider_factory.post.assert_called_with("/api/query", {"sparql": "SELECT * {}", "contextGraphId": "agent-context", "assertionName": "asset", "subGraphName": "sub", "verifiedGraph": "urn:g", "graphSuffix": "suffix", "minTrust": 0})


def test_memory_search_queries_all_layers_and_ranks_before_limiting(provider_factory):
    provider = provider_factory({"context_graph": "team"})
    provider_factory.get.return_value = {"agentAddress": "0x" + "1" * 40}
    def query(path, payload):
        assert path == "/api/query"
        assert 'CONTAINS(LCASE(STR(?text)), "tea")' in payload["sparql"]
        assert payload["sparql"].endswith("LIMIT 4")
        if payload["view"] == "working-memory":
            assert payload["agentAddress"] == "0x" + "1" * 40
        else:
            assert "agentAddress" not in payload
        return {"bindings": [
            {"uri": {"value": "urn:same"}, "pred": {"id": "urn:p"}, "text": {"term": '"Tea"'}},
            {"s": "urn:same", "p": "urn:p", "o": "Tea leaves"},
            {"s": "urn:same", "p": "urn:p", "o": "Tea"},
            {"uri": "urn:empty", "text": ""},
        ]}
    provider_factory.post.reset_mock()
    provider_factory.post.side_effect = query
    result = tool(provider, "memory_search", {"query": "tea leaves", "limit": 4})
    assert provider_factory.post.call_count == 6
    assert result["scope"] == "team" and result["count"] == 4
    assert [hit["layer"] for hit in result["hits"]] == ["agent-context-vm", "project-vm", "agent-context-swm", "project-swm"]
    assert [hit["source"] for hit in result["hits"]] == ["sessions", "memory", "sessions", "memory"]
    assert all(hit["snippet"] == "Tea leaves" and hit["score"] == 1.0 and "_rank" not in hit for hit in result["hits"])
    assert all(hit["predicate"] == "urn:p" for hit in result["hits"])


def test_search_no_identity_skips_working_memory_and_does_not_duplicate_default_graph(provider_factory):
    provider = provider_factory()
    provider_factory.get.return_value = {}
    provider_factory.post.reset_mock()
    provider_factory.post.return_value = {"bindings": []}
    assert tool(provider, "memory_search", {"query": "tea", "limit": 999}) == {"query": "tea", "count": 0, "scope": None, "hits": []}
    assert provider_factory.post.call_count == 2
    assert {c.args[1]["view"] for c in provider_factory.post.call_args_list} == {"shared-working-memory", "verifiable-memory"}
    assert all(c.args[1]["sparql"].endswith("LIMIT 100") for c in provider_factory.post.call_args_list)


def test_search_distinguishes_failed_queries_from_successful_empty_results(provider_factory):
    provider = provider_factory({"context_graph": "team"})
    provider._cache = {"memory": [None, {"content": "tea"}, {"content": "other"}], "user": [{"content": "tea leaves"}]}
    provider_factory.get.return_value = {}
    provider_factory.post.return_value = {"success": False}
    fallback = tool(provider, "memory_search", {"query": "tea leaves", "limit": "invalid"})
    assert fallback["offline"] is True and fallback["scope"] == "team"
    assert [hit["source"] for hit in fallback["hits"]] == ["user", "memory"]
    assert [hit["score"] for hit in fallback["hits"]] == [1.0, 0.5]
    provider_factory.post.return_value = {"bindings": []}
    assert tool(provider, "memory_search", {"query": "tea"}) == {"query": "tea", "count": 0, "scope": "team", "hits": []}
    provider._offline = True
    result = tool(provider, "memory_search", {"query": "tea leaves", "limit": 0})
    assert result["count"] == 1 and result["hits"][0]["source"] == "user"
    provider._cache["user"] = "bad cache"
    assert tool(provider, "memory_search", {"query": "tea"})["count"] == 1
    assert tool(provider, "memory_search", {"query": "a b"})["count"] == 0
    assert "at least 2" in tool(provider, "memory_search", {"query": "a"})["error"]
    provider._offline = False
    assert tool(provider, "memory_search", {"query": "a b"}) == {"query": "a b", "count": 0, "scope": None, "hits": []}
    assert "not a supported parameter" in tool(provider, "memory_search", {"query": "tea", "context_graph": "team"})["error"]
    provider._client = None
    assert tool(provider, "memory_search", {"query": "tea"})["offline"]


def test_context_graph_list_filters_caller_scope_but_preserves_legacy_rows(provider_factory):
    provider = provider_factory()
    rows = [None, {"id": "system", "isSystem": True}, {"id": "mine", "callerInvolved": True},
            {"id": "foreign", "callerInvolved": False}, {"id": "owner", "role": " OWNER "}, {"id": "legacy"}]
    provider_factory.get.return_value = {"contextGraphs": rows, "daemonMeta": 7}
    mine = tool(provider, "dkg_list_context_graphs", {})
    assert mine == {"contextGraphs": [rows[2], rows[4], rows[5]], "daemonMeta": 7, "count": 3, "scope": "mine"}
    assert tool(provider, "dkg_list_context_graphs", {"scope": "all"})["contextGraphs"] == rows
    assert "scope must be" in tool(provider, "dkg_list_context_graphs", {"scope": "invalid"})["error"]
    provider_factory.get.return_value = {"contextGraphs": "malformed"}
    assert tool(provider, "dkg_list_context_graphs", {})["contextGraphs"] == []
    provider_factory.get.return_value = []
    assert tool(provider, "dkg_list_context_graphs", {}) == {"contextGraphs": [], "scope": "mine", "count": 0}


@pytest.mark.parametrize("addrs,chosen", [
    ([], None),
    (["/ip4/127.0.0.1/tcp/1", "/ip4/10.0.0.2/tcp/2", "/dns4/node.example/tcp/3", "/ip4/8.8.8.8/tcp/4"], "/ip4/8.8.8.8/tcp/4"),
    (["/ip4/8.8.8.8/tcp/4", "/p2p/relay/p2p-circuit/p2p/local"], "/p2p/relay/p2p-circuit/p2p/local"),
    (["/ip4/172.16.0.1/tcp/1", "/ip4/172.32.0.1/tcp/2"], "/ip4/172.32.0.1/tcp/2"),
    (["/ip4/192.168.1.1/tcp/1", "/ip4/169.254.1.1/tcp/2", "/ip4/172.invalid/tcp/3"], "/ip4/172.invalid/tcp/3"),
    (["/ip4"], "/ip4"),
])
def test_invites_prefer_relay_then_public_addresses(provider_factory, addrs, chosen):
    provider = provider_factory()
    provider_factory.get.return_value = {"multiaddrs": [None, *addrs]}
    provider_factory.post.return_value = {"success": True}
    result = tool(provider, "dkg_context_graph_invite", {"context_graph_id": "team", "peer_id": "peer"})
    assert result == {"success": True, "peerId": "peer", "curatorMultiaddr": chosen, "inviteCode": "team" + ("\n" + chosen if chosen else "")}
    provider_factory.post.assert_called_with("/api/context-graph/invite", {"contextGraphId": "team", "peerId": "peer"})


@pytest.mark.parametrize("status", [None, RuntimeError("offline")])
def test_invite_survives_unavailable_node_status(provider_factory, status):
    provider = provider_factory()
    provider_factory.get.side_effect = status if isinstance(status, Exception) else None
    provider_factory.get.return_value = status
    provider_factory.post.return_value = "invited"
    assert tool(provider, "dkg_context_graph_invite", {"context_graph_id": "team", "peer_id": "peer"}) == {
        "result": "invited", "peerId": "peer", "curatorMultiaddr": None, "inviteCode": "team"}


def test_query_binding_envelopes_and_non_object_responses(plugin_module):
    binding = {"text": {"value": "tea"}}
    assert plugin_module._extract_query_bindings({"result": {"bindings": [binding, None]}}) == [binding]
    assert plugin_module._extract_query_bindings(None) == []


def test_find_agents_omits_explicit_null_filters(provider_factory):
    provider = provider_factory()
    provider_factory.get.reset_mock()
    provider.handle_tool_call("dkg_find_agents", {"framework": None})
    provider_factory.get.assert_called_once_with("/api/agents")
