"""Provider lifecycle contracts across real files and the daemon wire boundary."""
import json
import threading
from unittest.mock import Mock

import pytest


def call(provider, name, **args):
    return json.loads(provider.handle_tool_call(name, args))


def test_registration_and_configuration_round_trip(plugin_module, hermes_host):
    ctx = Mock()
    plugin_module.register(ctx)
    provider = ctx.register_memory_provider.call_args.args[0]
    assert provider.name == "dkg"
    assert provider.is_available()
    assert {field["key"] for field in provider.get_config_schema()} == {"daemon_url", "context_graph", "agent_name"}
    values = {"daemon_url": "http://node.invalid", "agent_name": "alice"}
    provider.save_config(values, str(hermes_host))
    assert values == {"daemon_url": "http://node.invalid", "agent_name": "alice"}
    saved = json.loads((hermes_host / "dkg.json").read_text())
    assert saved == {**values, "managedBy": "@origintrail-official/dkg-adapter-hermes"}
    assert plugin_module._load_config()["agent_name"] == "alice"
    provider.save_config({"managedBy": "operator"}, str(hermes_host))
    assert json.loads((hermes_host / "dkg.json").read_text())["managedBy"] == "operator"
    provider.shutdown()  # never initialized


@pytest.mark.parametrize("result,expected", [
    ({"assertionUri": "urn:memory"}, "memory"),
    ({"alreadyExists": True}, "memory"),
    ({"success": False, "error": "unavailable"}, ""),
    ({}, ""),
])
def test_initialization_retains_only_a_confirmed_assertion(provider_factory, result, expected):
    provider_factory.post.return_value = result
    provider = provider_factory()
    assert provider._assertion_id == expected
    assert provider._agent_name == "hermes"
    assert provider._offline is False
    assert provider._session_id.startswith("hermes:dkg:profile-profile:home-")
    assert provider_factory.post.call_args_list[0].args == (
        "/api/knowledge-assets", {"contextGraphId": "agent-context", "name": "memory"})
    assert "empty" in provider.system_prompt_block()


@pytest.mark.parametrize("creation,retry", [
    ({"success": True}, True),
    ({"success": False, "error": "already exists"}, True),
    ({"success": False, "error": "permission denied"}, False),
    (None, False),
])
def test_missing_default_graph_is_created_privately_before_retry(provider_factory, creation, retry):
    missing = {"success": False, "code": "CONTEXT_GRAPH_NOT_FOUND"}
    provider_factory.post.side_effect = [missing, creation, {"assertionUri": "urn:new"}] if retry else [missing, creation]
    provider = provider_factory()
    assert provider_factory.post.call_args_list[1].args == (
        "/api/context-graph/create", {"id": "agent-context", "name": "Agent Context",
        "description": "Chat-turn working memory for local agent integrations.", "accessPolicy": 1})
    assert provider_factory.post.call_count == (3 if retry else 2)
    assert provider._assertion_id == ("memory" if retry else "")


def test_custom_graph_is_not_automatically_created(provider_factory):
    provider_factory.post.return_value = {"success": False, "error": "unknown contextGraphId"}
    provider = provider_factory({"context_graph": "team", "memory_assertion": "notes", "agent_name": "alice"}, agent_identity="ignored")
    assert provider_factory.post.call_count == 1
    assert provider._agent_name == "alice"
    assert provider._context_graph == "team"
    assert provider._assertion_id == ""


def test_offline_memory_edits_survive_restart_and_flush(provider_factory):
    provider_factory.health.return_value = False
    provider = provider_factory(agent_identity="alice")
    assert provider._offline
    assert provider_factory.post.call_count == 0
    assert call(provider, "dkg_memory", content="old fact")["queued"]
    call(provider, "dkg_memory", content="another fact")
    call(provider, "dkg_memory", action="replace", old_text="old", content="new fact")
    call(provider, "dkg_memory", action="replace", old_text="absent", content="appended fact")
    provider.on_memory_write("add", "user", "likes tea")
    provider.on_memory_write("remove", "memory", "another")
    before = json.loads((provider_factory.home / "dkg_cache_alice.json").read_text())
    assert before["memory"] == [{"target": "memory", "content": "new fact"}, {"target": "memory", "content": "appended fact"}]
    assert before["user"] == [{"target": "user", "content": "likes tea"}]
    assert len(before["queued_writes"]) == 6
    prompt = provider.system_prompt_block()
    assert "new fact" in prompt and "likes tea" in prompt and "another fact" not in prompt
    provider_factory.health.return_value = True
    restored = provider_factory(agent_identity="alice")
    assert restored._cache["queued_writes"] == []
    assert restored._cache["memory"] == before["memory"]
    writes = [c.args for c in provider_factory.post.call_args_list if c.args[0].endswith("/wm/write")]
    assert len(writes) == 6
    assert writes[0] == ("/api/knowledge-assets/memory/wm/write", {"contextGraphId": "agent-context", "quads": [
        {"subject": "urn:hermes:alice:memory", "predicate": "urn:hermes:content", "object": '"[memory]\\nnew fact"'},
        {"subject": "urn:hermes:alice:memory", "predicate": "urn:hermes:content", "object": '"[memory]\\nappended fact"'},
    ]})
    assert json.loads((provider_factory.home / "dkg_cache_alice.json").read_text())["queued_writes"] == []


@pytest.mark.parametrize("response", [{"success": False, "error": "disk full"}, {"ok": False}, RuntimeError("broken connection")])
def test_failed_memory_write_is_durable_and_retryable(provider_factory, response):
    provider = provider_factory()
    provider_factory.post.side_effect = response if isinstance(response, Exception) else None
    provider_factory.post.return_value = response
    result = call(provider, "dkg_memory", content='quote " and newline\n')
    assert result == {"success": True, "action": "add", "target": "memory", "entries": 1, "store": "local_cache", "queued": True}
    provider._flush_queued_writes()
    assert len(provider._cache["queued_writes"]) == 1
    provider_factory.post.side_effect = None
    provider_factory.post.return_value = {"success": True}
    provider._flush_queued_writes()
    assert provider._cache["queued_writes"] == []


def test_online_memory_and_validation(provider_factory):
    provider = provider_factory()
    provider_factory.post.reset_mock()
    assert "required" in call(provider, "dkg_memory")["error"]
    assert provider_factory.post.call_count == 0
    result = call(provider, "dkg_memory", content="saved")
    assert result["store"] == "dkg" and result["queued"] is False
    assert "Unknown DKG tool" in call(provider, "typo")["error"]


def test_recall_decodes_wire_quads_and_snapshots_only_facts(provider_factory):
    provider = provider_factory()
    provider_factory.get.return_value = {"result": {"quads": [
        {"s": "urn:1", "p": {"value": "urn:hermes:content"}, "o": '"[user]\\nLikes tea"'},
        {"subject": "urn:2", "predicate": "urn:hermes:content", "object": {"term": '"[memory]\\nRemember \\\"tea\\\""'}},
        {"subject": "urn:3", "predicate": "urn:hermes:content", "object": "legacy fact"},
        {"predicate": "urn:other", "object": "ignore"}, "invalid",
    ]}}
    provider.on_session_end([])
    assert provider._cache["user"] == [{"target": "user", "content": "Likes tea"}]
    assert provider._cache["memory"] == [{"target": "memory", "content": 'Remember "tea"'}, {"target": "memory", "content": "legacy fact"}]
    for response in [{"quads": []}, RuntimeError("offline")]:
        provider_factory.get.side_effect = response if isinstance(response, Exception) else None
        provider_factory.get.return_value = response
        assert "legacy fact" in provider.system_prompt_block()
    provider._assertion_id = ""
    assert "legacy fact" in provider.system_prompt_block()


def test_prefetch_reads_scoped_working_memory_bindings(provider_factory):
    provider = provider_factory()
    provider_factory.get.return_value = {"results": {"bindings": [{"s": {"value": "urn:example#Alice"}, "p": {"value": "https://example/name"}, "o": {"value": "Alice"}}, {}]}}
    assert "Alice — name — Alice" in provider.prefetch('a"\\\nb')
    assert provider_factory.get.call_args.args == (
        "/api/knowledge-assets/memory/wm/quads?contextGraphId=agent-context",)


def test_prefetch_without_assertion_scopes_search_and_escapes_input(provider_factory):
    provider = provider_factory()
    bindings = {"results": {"bindings": [{"s": {"value": "urn:example#Alice"}, "p": {"value": "https://example/name"}, "o": {"value": "Alice"}}, {}]}}
    provider._assertion_id = ""
    provider_factory.post.return_value = bindings
    assert "Alice — name — Alice" in provider.prefetch('a"\\\nb')
    payload = provider_factory.post.call_args.args[1]
    assert payload["contextGraphId"] == "agent-context"
    assert 'a\\"\\\\ b' in payload["sparql"]


@pytest.mark.parametrize("query", ["tea", "", "nonexistent"])
def test_prefetch_filters_content_quads_and_limits_results(provider_factory, query):
    provider = provider_factory()
    provider._assertion_id = ""
    provider_factory.post.return_value = {"quads": [{"subject": "urn:ignore", "predicate": "urn:other", "object": "tea"},
        {"subject": "urn:miss", "predicate": "urn:hermes:content", "object": "coffee"}] + [
        {"subject": f"urn:fact:{i}", "predicate": "urn:hermes:content", "object": f"tea {i}"} for i in range(15)]}
    prefetched = provider.prefetch(query)
    assert "assertionName" not in provider_factory.post.call_args.args[1]
    if query == "tea":
        assert "tea 9" in prefetched and "tea 10" not in prefetched and "coffee" not in prefetched
    elif query == "":
        assert "coffee" in prefetched
    else:
        assert prefetched == ""


def test_prefetch_returns_empty_on_query_transport_failure(provider_factory):
    provider = provider_factory()
    provider._assertion_id = ""
    provider_factory.post.side_effect = RuntimeError("unavailable")
    assert provider.prefetch("tea") == ""


@pytest.mark.parametrize("unavailable", ["offline", "missing-client"])
def test_prefetch_without_connectivity_avoids_transport(provider_factory, unavailable):
    provider = provider_factory()
    if unavailable == "offline":
        provider._offline = True
    else:
        provider._client = None
    provider_factory.get.reset_mock()
    provider_factory.post.reset_mock()
    assert provider.prefetch("tea") == ""
    provider_factory.get.assert_not_called()
    provider_factory.post.assert_not_called()


@pytest.mark.parametrize("outcome", [{"success": True}, {"success": False}, RuntimeError("offline")])
def test_background_turn_sync_preserves_identity_and_queues_only_failures(provider_factory, monkeypatch, outcome):
    provider = provider_factory({"agent_name": "alice"})
    # Keep real threads; join at their boundary to make queue assertions deterministic.
    real_thread = threading.Thread
    threads = []
    def tracked_thread(*args, **kwargs):
        thread = real_thread(*args, **kwargs)
        threads.append(thread)
        return thread
    monkeypatch.setattr(threading, "Thread", tracked_thread)
    provider_factory.post.side_effect = outcome if isinstance(outcome, Exception) else None
    provider_factory.post.return_value = outcome
    provider.sync_turn("u" * 2100, "a" * 2100)
    for thread in threads:
        thread.join(timeout=3)
        assert not thread.is_alive()
    payload = provider_factory.post.call_args.args[1]
    assert payload["userMessage"] == "u" * 2000 and payload["assistantReply"] == "a" * 2000
    assert payload["sessionId"] == provider._session_id
    assert payload["agentName"] == "alice"
    assert payload["idempotencyKey"] == "hermes:" + payload["turnId"]
    assert len(provider._cache.get("queued_writes", [])) == (0 if outcome == {"success": True} else 1)
    if provider._cache.get("queued_writes"):
        provider_factory.post.side_effect = None
        provider_factory.post.return_value = {"success": True}
        provider._flush_queued_writes()
        assert provider_factory.post.call_args.args[1] == payload
        assert provider._cache["queued_writes"] == []


@pytest.mark.parametrize("sequences,expected_sequence", [([], 1), ({"hermes:dkg:test": "invalid"}, 1), ({"hermes:dkg:test": 7}, 8)])
def test_offline_turn_sequence_recovers_bad_cache_and_deduplicates_retries(provider_factory, sequences, expected_sequence):
    provider = provider_factory(initialize=False)
    provider._cache = {"turn_sequences": sequences}
    provider.sync_turn("user", "assistant", session_id="hermes:dkg:test")
    item = provider._cache["queued_writes"][0]
    assert provider._turn_count == expected_sequence
    assert item["session_id"] == "hermes:dkg:test"
    provider._queue_turn(item["session_id"], item["turn_id"], item["idempotency_key"], "user", "assistant")
    assert len(provider._cache["queued_writes"]) == 1
    provider.sync_turn("user", "assistant", session_id="hermes:dkg:test")
    assert len(provider._cache["queued_writes"]) == 2
    assert provider._cache["queued_writes"][1]["turn_id"] != item["turn_id"]


def test_flush_retains_failed_turns_then_succeeds_without_duplicate_ids(provider_factory):
    provider = provider_factory(initialize=False)
    provider.sync_turn("one", "reply")
    provider.sync_turn("two", "reply")
    queued = list(provider._cache["queued_writes"])
    provider._offline = True
    provider._flush_queued_writes()
    assert provider._cache["queued_writes"] == queued
    provider._offline = False
    provider._client = provider_factory()._client
    provider_factory.post.side_effect = [RuntimeError("offline"), {"success": False}, {"success": True}, {"success": True}]
    provider._flush_queued_writes()
    assert provider._cache["queued_writes"] == queued
    provider._flush_queued_writes()
    assert provider._cache["queued_writes"] == []


def test_first_activation_imports_delimited_files_and_preserves_existing_memory(provider_factory):
    memories = provider_factory.home / "memories"
    memories.mkdir()
    (memories / "MEMORY.md").write_text(" first \n§\n \n§\n second ")
    (memories / "USER.md").write_text("profile")
    provider = provider_factory(hermes_home=str(provider_factory.home))
    assert provider._cache["memory"] == [{"target": "memory", "content": "first"}, {"target": "memory", "content": "second"}]
    assert provider._cache["user"] == [{"target": "user", "content": "profile"}]
    provider._backlog_import_if_needed(str(provider_factory.home))
    assert len(provider._cache["memory"]) == 2
    provider._offline = True
    provider._backlog_import_if_needed(str(provider_factory.home))
    assert len(provider._cache["memory"]) == 2


def test_backlog_ignores_empty_and_unreadable_files(provider_factory, caplog):
    memories = provider_factory.home / "memories"
    memories.mkdir()
    (memories / "MEMORY.md").write_text("   ")
    (memories / "USER.md").write_bytes(b"\xff")
    provider = provider_factory(hermes_home=str(provider_factory.home))
    assert provider._cache == {"memory": [], "user": [], "queued_writes": []}
    assert "Backlog import failed for USER.md" in caplog.text
    provider.on_session_end([])
    assert not (provider_factory.home / "dkg_cache_hermes.json").exists()
