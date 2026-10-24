"""Configuration, policy exposure, and durable host-profile isolation."""
import json
from pathlib import Path
from unittest.mock import Mock

import pytest


@pytest.mark.parametrize("file_config,expected", [
    ({"daemon_url": None, "agent_name": "", "import_roots": 4}, {"daemon_url": "http://127.0.0.1:9200", "import_roots": []}),
    ({"publish_guard": {"defaultToolExposure": "disabled", "allowDirectPublish": False}, "allowContextGraphAdminTools": False},
     {"publish_tool": "disabled", "allow_direct_publish": False, "allow_context_graph_admin_tools": False}),
    ({"publish_guard": {"default_tool_exposure": "request", "allow_direct_publish": True}, "allow_context_graph_admin_tools": True},
     {"publish_tool": "request", "allow_direct_publish": True, "allow_context_graph_admin_tools": True}),
    ({"publish_guard": {}, "import_roots": "/one: :/two"}, {"import_roots": ["/one", "/two"]}),
    ({"publish_guard": "invalid", "import_roots": ["/one"]}, {"import_roots": ["/one"]}),
])
def test_file_config_aliases_and_empty_value_defaults(plugin_module, hermes_host, file_config, expected):
    (hermes_host / "dkg.json").write_text(json.dumps(file_config))
    loaded = plugin_module._load_config()
    for key, value in expected.items():
        assert loaded[key] == value


def test_environment_overrides_file_config(plugin_module, hermes_host, monkeypatch):
    (hermes_host / "dkg.json").write_text(json.dumps({"daemon_url": "file", "agent_name": "file", "import_roots": ["file"]}))
    env = {"DKG_DAEMON_URL": "http://test.invalid", "DKG_CONTEXT_GRAPH": "team", "DKG_MEMORY_ASSERTION": "notes",
           "DKG_AGENT_NAME": "alice", "DKG_PUBLISH_TOOL": "disabled", "DKG_ALLOW_DIRECT_PUBLISH": "no",
           "DKG_ALLOW_CONTEXT_GRAPH_ADMIN_TOOLS": "YES", "DKG_HERMES_IMPORT_ROOTS": "/a:: /b"}
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    cfg = plugin_module._load_config()
    assert cfg == {"daemon_url": "http://test.invalid", "context_graph": "team", "memory_assertion": "notes",
                   "agent_name": "alice", "publish_tool": "disabled", "allow_direct_publish": False,
                   "allow_context_graph_admin_tools": True, "import_roots": ["/a", " /b"]}
    monkeypatch.setenv("DKG_ALLOW_DIRECT_PUBLISH", "1")
    monkeypatch.setenv("DKG_ALLOW_CONTEXT_GRAPH_ADMIN_TOOLS", "false")
    assert plugin_module._load_config()["allow_direct_publish"] is True
    assert plugin_module._load_config()["allow_context_graph_admin_tools"] is False


@pytest.mark.parametrize("alias", ["HERMES_DKG_IMPORT_ROOTS", "DKG_IMPORT_ROOTS"])
def test_import_root_environment_aliases(plugin_module, hermes_host, monkeypatch, alias):
    monkeypatch.setenv(alias, "/alias")
    assert plugin_module._load_config()["import_roots"] == ["/alias"]


def test_bad_config_and_cache_recover_and_failed_save_is_logged(plugin_module, hermes_host, monkeypatch, caplog):
    (hermes_host / "dkg.json").write_text("{bad json")
    assert plugin_module._load_config()["context_graph"] == "agent-context"
    (hermes_host / "dkg_cache.json").write_text("not JSON")
    assert plugin_module._load_cache() == {"memory": [], "user": [], "queued_writes": []}
    plugin_module._save_cache({"memory": ["test"]})
    assert plugin_module._load_cache() == {"memory": ["test"]}
    assert not (hermes_host / "dkg_cache.tmp").exists()
    monkeypatch.setattr(Path, "replace", Mock(side_effect=PermissionError("read-only directory")))
    plugin_module._save_cache({"memory": ["new"]})
    assert "Failed to save cache" in caplog.text
    assert json.loads((hermes_host / "dkg_cache.json").read_text()) == {"memory": ["test"]}
    monkeypatch.setattr(plugin_module, "_load_config", Mock(side_effect=RuntimeError("missing host")))
    assert plugin_module.DKGMemoryProvider().is_available() is False
    monkeypatch.setattr(plugin_module, "_load_config", lambda: {"daemon_url": ""})
    assert plugin_module.DKGMemoryProvider().is_available() is False


@pytest.mark.parametrize("allow,exposure,expected", [(True, "direct", True), ("yes", "request", True), ("true", "request", True),
    ("1", "request", True), (False, "direct", False), ("0", "direct", False), ("false", "direct", False),
    ("no", "direct", False), (True, "disabled", False), ("unknown", "request", False), ("unknown", "direct", True)])
def test_publish_policy_changes_schemas_prompt_and_dispatch_together(provider_factory, allow, exposure, expected):
    provider = provider_factory({"allow_direct_publish": allow, "publish_tool": exposure})
    provider._cache["memory"] = [{"target": "memory", "content": "remember"}]
    schemas = {s["name"] for s in provider.get_tool_schemas()}
    assert ("dkg_knowledge_asset_publish" in schemas) == expected
    prompt = provider.system_prompt_block()
    assert ("dkg_knowledge_asset_publish —" in prompt) == expected
    provider_factory.post.reset_mock()
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {"context_graph_id": "team", "name": "notes"}))
    assert ("error" not in out) == expected
    assert provider_factory.post.call_count == int(expected)


@pytest.mark.parametrize("allow,expected", [(True, True), ("true", True), ("yes", True), ("1", True),
    (False, False), ("false", False), ("no", False), ("0", False), ("unknown", False)])
def test_admin_policy_hides_mutations_but_preserves_read_tools(provider_factory, allow, expected):
    provider = provider_factory({"allow_context_graph_admin_tools": allow})
    provider._cache["user"] = [{"target": "user", "content": "profile"}]
    schemas = {s["name"] for s in provider.get_tool_schemas()}
    assert ("dkg_participant_add" in schemas) == expected
    assert {"dkg_participant_list", "dkg_join_request_list"} <= schemas
    assert ("dkg_context_graph_invite /" in provider.system_prompt_block()) == expected
    provider_factory.post.reset_mock()
    for name in ("dkg_context_graph_invite", "dkg_participant_add", "dkg_participant_remove", "dkg_join_request_approve", "dkg_join_request_reject"):
        result = json.loads(provider.handle_tool_call(name, {"context_graph_id": "team", "peer_id": "peer", "agent_address": "agent"}))
        assert ("error" not in result) == expected
    assert provider_factory.post.call_count == 5 * int(expected)


def test_scoped_sessions_are_stable_bounded_and_profile_specific(plugin_module, hermes_host, monkeypatch):
    first = plugin_module._scoped_session_id("session", {"profile_name": "A profile"})
    assert first == plugin_module._scoped_session_id("session", {"profile_name": "A profile"})
    assert first != plugin_module._scoped_session_id("session", {"profile_name": "Other"})
    assert "profile-a-profile:" in first
    assert plugin_module._scoped_session_id("hermes:dkg:existing") == "hermes:dkg:existing"
    assert plugin_module._scoped_session_id("hermes:dkg-ui:existing") == "hermes:dkg-ui:existing"
    assert plugin_module._scoped_session_id("").endswith(":default")
    long = plugin_module._scoped_session_id("z" * 80, {"profile_name": "x" * 80})
    assert len(long.rsplit(":", 1)[1]) == 48
    assert len(long.split(":")[2].removeprefix("profile-")) == 32
    assert plugin_module._session_segment("!!!") == plugin_module._stable_scope_hash("!!!")
    import sys
    monkeypatch.setattr(sys.modules["hermes_constants"], "get_hermes_home", lambda: Path("/"))
    assert "profile-default:" in plugin_module._scoped_session_id("session")
    assert first != plugin_module._scoped_session_id("session", {"profile_name": "A profile"})
