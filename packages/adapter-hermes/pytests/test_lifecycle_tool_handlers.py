"""Unit tests for the new lifecycle tool handlers + schema gating.

Exercises the provider's ``get_tool_schemas`` / ``handle_tool_call`` wiring for
``dkg_knowledge_asset_finalize`` / ``_publish`` / ``_pull_from`` plus the
rename of the lifecycle family (no ``dkg_assertion_*`` names remain).
"""

from __future__ import annotations

import json

import pytest

LEGACY_NAMES = [
    "dkg_assertion_create",
    "dkg_assertion_write",
    "dkg_assertion_promote",
    "dkg_assertion_discard",
    "dkg_assertion_query",
    "dkg_assertion_history",
    "dkg_assertion_import_file",
    # B-H1: the import-artifact + semantic-enrichment trio renamed to the full
    # dkg_knowledge_asset_* family for parity with OpenClaw (PR1) + MCP (PR2) +
    # CONTRACT section 2. Guard against any regression to the old short names.
    "dkg_import_artifact_resolve",
    "dkg_import_artifact_read_markdown",
    "dkg_semantic_enrichment_write",
]


class _FakeClient:
    def __init__(self):
        self.calls = []

    def finalize_assertion(self, name, cg, sub_graph_name=None,
                           author_agent_address=None, scheme_version=None):
        self.calls.append(("finalize", name, cg, sub_graph_name,
                           author_agent_address, scheme_version))
        return {"merkleRoot": "0xroot", "authorAddress": author_agent_address or "0xdefault"}

    def publish_finalized_assertion(self, name, cg, sub_graph_name=None, options=None):
        self.calls.append(("publish", name, cg, sub_graph_name, options))
        return {"kaId": "ka1", "ual": "did:dkg:1/0xabc/5", "txHash": "0xtx", "status": "confirmed"}

    def pull_from(self, name, cg, layer, on_conflict=None, sub_graph_name=None):
        self.calls.append(("pull", name, cg, layer, on_conflict, sub_graph_name))
        return {"wmDraft": "open", "seededFrom": {"layer": layer}}


@pytest.fixture
def provider(plugin_module):
    p = plugin_module.DKGMemoryProvider()
    p._offline = False
    p._client = _FakeClient()
    p._config = {"publish_tool": "direct", "allow_direct_publish": True}
    return p


# -- schema gating + rename -------------------------------------------------

def test_no_legacy_assertion_names_in_schemas(provider):
    names = {s["name"] for s in provider.get_tool_schemas()}
    for legacy in LEGACY_NAMES:
        assert legacy not in names, legacy


def test_renamed_lifecycle_tools_present(provider):
    names = {s["name"] for s in provider.get_tool_schemas()}
    for new in [
        "dkg_knowledge_asset_create",
        "dkg_knowledge_asset_write",
        "dkg_knowledge_asset_finalize",
        "dkg_knowledge_asset_share",
        "dkg_knowledge_asset_pull_from",
        "dkg_knowledge_asset_discard",
        "dkg_knowledge_asset_query",
        "dkg_knowledge_asset_history",
        "dkg_knowledge_asset_import_file",
    ]:
        assert new in names, new


def test_finalize_and_pull_from_available_without_publish_guard(provider):
    provider._config = {"publish_tool": "disabled", "allow_direct_publish": False}
    names = {s["name"] for s in provider.get_tool_schemas()}
    assert "dkg_knowledge_asset_finalize" in names
    assert "dkg_knowledge_asset_pull_from" in names
    # publish is guard-gated
    assert "dkg_knowledge_asset_publish" not in names


def test_publish_appears_only_when_direct_publish_allowed(provider):
    provider._config = {"publish_tool": "direct", "allow_direct_publish": True}
    names = {s["name"] for s in provider.get_tool_schemas()}
    assert "dkg_knowledge_asset_publish" in names


def test_share_description_carries_subset_language(provider):
    share = next(s for s in provider.get_tool_schemas()
                 if s["name"] == "dkg_knowledge_asset_share")
    assert "NOT publishable to Verifiable Memory" in share["description"]


# -- finalize handler -------------------------------------------------------

def test_finalize_handler_normalizes_author_to_checksum(provider):
    provider.handle_tool_call("dkg_knowledge_asset_finalize", {
        "context_graph_id": "cg1",
        "name": "ka",
        "author_agent_address": "0x52908400098527886e0f7030069857d2e4169ee7",
        "scheme_version": 1,
    })
    call = provider._client.calls[-1]
    assert call[0] == "finalize"
    # EIP-55 checksum (mixed case)
    assert call[4] == "0x52908400098527886E0F7030069857D2E4169EE7"
    assert call[5] == 1


def test_finalize_handler_defaults_author_to_none(provider):
    provider.handle_tool_call("dkg_knowledge_asset_finalize", {
        "context_graph_id": "cg1", "name": "ka",
    })
    assert provider._client.calls[-1][4] is None


# -- publish handler --------------------------------------------------------

def test_publish_handler_builds_nested_options(provider):
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1",
        "name": "ka",
        "publish_epochs": 3,
        "clear_shared_memory_after": True,
        "publisher_node_identity_id_override": "12",
    }))
    call = provider._client.calls[-1]
    assert call[0] == "publish"
    assert call[4] == {
        "publishEpochs": 3,
        "clearSharedMemoryAfter": True,
        "publisherNodeIdentityIdOverride": "12",
    }
    assert out["ual"] == "did:dkg:1/0xabc/5"


def test_publish_handler_omits_empty_options(provider):
    provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka",
    })
    assert provider._client.calls[-1][4] is None


def test_publish_handler_rejects_non_boolean_clear_flag(provider):
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka", "clear_shared_memory_after": "yes",
    }))
    assert "must be a boolean" in out["error"]


def test_publish_handler_enforces_publish_guard(provider):
    provider._config = {"publish_tool": "disabled", "allow_direct_publish": False}
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka",
    }))
    assert "disabled by the adapter publish guard" in out["error"]


# -- pull_from handler ------------------------------------------------------

def test_pull_from_handler_passes_layer_and_conflict(provider):
    provider.handle_tool_call("dkg_knowledge_asset_pull_from", {
        "context_graph_id": "cg1", "name": "ka", "layer": "swm", "on_conflict": "replace",
    })
    call = provider._client.calls[-1]
    assert call[0] == "pull" and call[3] == "swm" and call[4] == "replace"


def test_pull_from_handler_validates_layer(provider):
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_pull_from", {
        "context_graph_id": "cg1", "name": "ka", "layer": "bogus",
    }))
    assert "layer must be" in out["error"]

    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_pull_from", {
        "context_graph_id": "cg1", "name": "ka",
    }))
    assert "layer must be" in out["error"]


def test_pull_from_handler_validates_on_conflict(provider):
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_pull_from", {
        "context_graph_id": "cg1", "name": "ka", "layer": "vm", "on_conflict": "merge",
    }))
    assert "on_conflict must be" in out["error"]


# -- required-field validation across the new handlers ----------------------

@pytest.mark.parametrize("tool", [
    "dkg_knowledge_asset_finalize",
    "dkg_knowledge_asset_publish",
    "dkg_knowledge_asset_pull_from",
])
def test_new_handlers_require_context_graph_id(provider, tool):
    args = {"name": "ka"}
    if tool == "dkg_knowledge_asset_pull_from":
        args["layer"] = "swm"
    out = json.loads(provider.handle_tool_call(tool, args))
    assert "context_graph_id is required" in out["error"]
