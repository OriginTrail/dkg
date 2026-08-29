"""GH#310 — ``dkg_find_agents`` advertises and forwards the daemon's new
``connectionStatus`` / ``local`` / ``limit`` / ``cursor`` filters.

The daemon rejects unknown parameter NAMES with a 400, so the mapping from
this plugin's snake_case tool args to the daemon's camelCase query params is
load-bearing — a wrong name here is a hard failure, not a silently ignored
filter.
"""

from __future__ import annotations

import json

import pytest


class _GetRecorder:
    def __init__(self):
        self.gets = []

    def _get(self, path):
        self.gets.append(path)
        return {"agents": []}


@pytest.fixture
def provider(plugin_module):
    p = plugin_module.DKGMemoryProvider()
    p._offline = False
    p._client = _GetRecorder()
    p._config = {}
    return p


def test_schema_advertises_the_310_filters(plugin_module):
    schema = plugin_module.DKG_FIND_AGENTS_SCHEMA
    props = schema["parameters"]["properties"]
    for key in ("framework", "skill_type", "connection_status", "local", "limit", "cursor"):
        assert key in props, f"dkg_find_agents schema is missing {key}"
    assert props["connection_status"]["enum"] == ["self", "connected", "disconnected"]


def test_handler_maps_snake_case_args_to_daemon_params(provider):
    out = provider._handle_find_agents({
        "framework": "hermes-agent",
        "connection_status": "connected",
        "local": True,
        "limit": 5,
        "cursor": "djE6YWJj",
    })
    assert json.loads(out) == {"agents": []}
    assert len(provider._client.gets) == 1
    path = provider._client.gets[0]
    assert path.startswith("/api/agents?")
    assert "framework=hermes-agent" in path
    assert "connectionStatus=connected" in path  # camelCase on the wire
    assert "local=true" in path
    assert "limit=5" in path
    assert "cursor=djE6YWJj" in path


def test_handler_urlencodes_values(provider):
    # The old handler string-joined k=v pairs raw; a framework value with a
    # space or '&' would have produced a malformed query.
    provider._handle_find_agents({"framework": "hermes agent&co"})
    path = provider._client.gets[0]
    assert "framework=hermes+agent%26co" in path


def test_local_false_is_sent_not_dropped(provider):
    provider._handle_find_agents({"local": False})
    assert "local=false" in provider._client.gets[0]


def test_malformed_values_are_forwarded_not_coerced(provider):
    # The daemon is the single validator; a typo folded to false (or a bad
    # limit dropped) would silently change the query instead of surfacing
    # the daemon's 400.
    provider._handle_find_agents({"local": "ture", "limit": 0, "connection_status": "onnected"})
    path = provider._client.gets[0]
    assert "local=ture" in path
    assert "limit=0" in path
    assert "connectionStatus=onnected" in path


def test_no_args_keeps_the_bare_path(provider):
    provider._handle_find_agents({})
    assert provider._client.gets[0] == "/api/agents"
