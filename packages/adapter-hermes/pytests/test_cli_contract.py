"""Invoke the actual Click commands and verify effects on client/cache boundaries."""
import importlib
from copy import deepcopy
from unittest.mock import Mock
from types import SimpleNamespace

import click
import pytest
from click.testing import CliRunner


@pytest.fixture
def cli_fixture(plugin_module, monkeypatch):
    module = importlib.import_module(f"{plugin_module.__name__}.cli")
    client_module = importlib.import_module(f"{plugin_module.__name__}.client")
    client = Mock()
    client.health_check.return_value = True
    client.status.return_value = {"peerId": "peer-test"}
    client.list_context_graphs.return_value = [{"id": "cg:test", "name": "Test"}]
    client.query.return_value = {"bindings": [{"value": "actual"}]}
    client.store_turn.return_value = {"success": True}
    client.write_assertion.return_value = {"success": True}
    monkeypatch.setattr(client_module, "DKGClient", Mock(return_value=client))
    monkeypatch.setattr(plugin_module, "_load_config", lambda: {"agent_name": "agent", "context_graph": "cg:test", "daemon_url": "http://127.0.0.1:1"})
    cache = {"memory": [{"content": "retained fact"}], "user": [], "queued_writes": []}
    monkeypatch.setattr(plugin_module, "_load_cache", lambda _agent: deepcopy(cache))
    saved = []
    monkeypatch.setattr(plugin_module, "_save_cache", lambda value, agent: saved.append((deepcopy(value), agent)))
    cli = click.Group()
    module.register_cli(cli)
    return SimpleNamespace(runner=CliRunner(), cli=cli, client=client, cache=cache, saved=saved)


def test_status_and_query_are_scoped_to_configured_graph(cli_fixture):
    h = cli_fixture
    status = h.runner.invoke(h.cli, ["dkg", "status"])
    assert status.exit_code == 0
    assert "CONNECTED" in status.output and "peer-test" in status.output
    query = h.runner.invoke(h.cli, ["dkg", "query", "SELECT ?s WHERE { ?s ?p ?o }"])
    assert query.exit_code == 0 and "actual" in query.output
    h.client.query.assert_called_once_with("SELECT ?s WHERE { ?s ?p ?o }", "cg:test")


@pytest.mark.parametrize("command", ["query", "sync"])
def test_unreachable_daemon_fails_without_writes(cli_fixture, command):
    h = cli_fixture
    h.client.health_check.return_value = False
    result = h.runner.invoke(h.cli, ["dkg", command] + (["ASK {}"] if command == "query" else []))
    assert result.exit_code == 1 and "not reachable" in result.output
    h.client.query.assert_not_called()
    h.client.store_turn.assert_not_called()
    h.client.write_assertion.assert_not_called()
    assert h.saved == []


def test_offline_status_reports_cached_counts(cli_fixture):
    h = cli_fixture
    h.client.health_check.return_value = False
    h.cache["queued_writes"] = [{"type": "memory"}]
    result = h.runner.invoke(h.cli, ["dkg", "status"])
    assert result.exit_code == 0 and "OFFLINE" in result.output
    assert "Cached memory entries: 1" in result.output and "Queued writes: 1" in result.output


@pytest.mark.parametrize("failure", [None, "response", "exception", "empty"])
def test_sync_retains_failed_writes_and_only_clears_confirmed_work(cli_fixture, failure):
    h = cli_fixture
    queued = [{"type": "memory", "target": "memory"}, {"type": "turn", "session_id": "s", "user": "u", "assistant": "a", "idempotency_key": "stable"}]
    h.cache["queued_writes"] = deepcopy(queued)
    if failure == "response":
        h.client.write_assertion.return_value = {"success": False, "error": "store unavailable"}
        h.client.store_turn.return_value = {"success": False, "error": "store unavailable"}
    elif failure == "exception":
        h.client.write_assertion.side_effect = RuntimeError("lost reply")
        h.client.store_turn.side_effect = RuntimeError("lost reply")
    elif failure == "empty":
        h.cache["memory"] = []
    result = h.runner.invoke(h.cli, ["dkg", "sync"])
    assert result.exit_code == 0, result.output
    assert len(h.saved) == 1 and h.saved[0][1] == "agent"
    remaining = h.saved[0][0]["queued_writes"]
    if failure in ("response", "exception"):
        assert sorted(item["type"] for item in remaining) == ["memory", "turn"]
    elif failure == "empty":
        assert remaining == [queued[0]]
    else:
        assert remaining == []
        args = h.client.write_assertion.call_args.args
        assert args[1] == "cg:test" and args[2][0]["subject"] == "urn:hermes:agent:memory"
    assert h.client.store_turn.call_args.kwargs["idempotency_key"] == "stable"
    h.client.close.assert_called_once()


def test_empty_queue_does_not_write(cli_fixture):
    h = cli_fixture
    result = h.runner.invoke(h.cli, ["dkg", "sync"])
    assert result.exit_code == 0 and "Nothing to sync" in result.output
    h.client.write_assertion.assert_not_called()
    h.client.store_turn.assert_not_called()
    assert h.saved == []
