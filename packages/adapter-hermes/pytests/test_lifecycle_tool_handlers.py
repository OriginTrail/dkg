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

    def promote_assertion(self, name, cg, entities, sub_graph_name=None):
        self.calls.append(("share", name, cg, entities, sub_graph_name))
        return {"swmShared": True, "promotedCount": 1}


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


# -- G2: the agent prompt must not advertise the gated publish tool ----------

def test_prompt_advertises_publish_only_when_allowed(provider):
    provider._recall_facts = lambda: [{"target": "memory", "content": "a fact"}]

    provider._config = {"publish_tool": "direct", "allow_direct_publish": True,
                        "allow_context_graph_admin_tools": False}
    allowed = provider.system_prompt_block()
    assert "dkg_knowledge_asset_create/write/finalize/share/publish" in allowed

    provider._config = {"publish_tool": "disabled", "allow_direct_publish": False,
                        "allow_context_graph_admin_tools": False}
    gated = provider.system_prompt_block()
    # the gated prompt must NOT name the unregistered publish verb in the
    # lifecycle line, and the tool really is absent from the registered set
    assert "dkg_knowledge_asset_create/write/finalize/share/publish" not in gated
    assert "chain publish is disabled" in gated
    assert "dkg_knowledge_asset_publish" not in {
        s["name"] for s in provider.get_tool_schemas()
    }


def test_share_description_carries_subset_language(provider):
    share = next(s for s in provider.get_tool_schemas()
                 if s["name"] == "dkg_knowledge_asset_share")
    assert "NOT publishable to Verifiable Memory" in share["description"]


# -- B: entities accepts "all" | string[] | omitted -------------------------

def test_share_entities_all_passes_through(provider):
    provider.handle_tool_call("dkg_knowledge_asset_share", {
        "context_graph_id": "cg1", "name": "ka", "entities": "all",
    })
    assert provider._client.calls[-1][3] == "all"


def test_share_entities_array_passes_through(provider):
    provider.handle_tool_call("dkg_knowledge_asset_share", {
        "context_graph_id": "cg1", "name": "ka", "entities": ["urn:a", "urn:b"],
    })
    assert provider._client.calls[-1][3] == ["urn:a", "urn:b"]


def test_share_entities_omitted_is_none_not_coerced(provider):
    provider.handle_tool_call("dkg_knowledge_asset_share", {
        "context_graph_id": "cg1", "name": "ka",
    })
    # omitted stays None — NOT coerced to "all" (both are full-share daemon-side)
    assert provider._client.calls[-1][3] is None


def test_share_entities_empty_array_rejected(provider):
    before = len(provider._client.calls)
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_share", {
        "context_graph_id": "cg1", "name": "ka", "entities": [],
    }))
    assert "error" in out and '"all"' in out["error"]
    assert len(provider._client.calls) == before  # never reached the wire


def test_share_entities_bad_string_rejected(provider):
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_share", {
        "context_graph_id": "cg1", "name": "ka", "entities": "everything",
    }))
    assert "error" in out


def test_share_schema_entities_is_union(provider):
    share = next(s for s in provider.get_tool_schemas()
                 if s["name"] == "dkg_knowledge_asset_share")
    assert "anyOf" in share["parameters"]["properties"]["entities"]


# -- E: no pre-signed reference; finalize follow-up note ---------------------

def test_finalize_description_has_no_presigned_ref(provider):
    fin = next(s for s in provider.get_tool_schemas()
               if s["name"] == "dkg_knowledge_asset_finalize")
    assert "pre_signed" not in fin["description"]
    assert "preSigned" not in fin["description"]
    assert "pre_signed_author_attestation" not in fin["parameters"]["properties"]


def test_finalize_description_notes_external_signer_followup(provider):
    fin = next(s for s in provider.get_tool_schemas()
               if s["name"] == "dkg_knowledge_asset_finalize")
    assert "tracked follow-up" in fin["description"]


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
        "publisher_node_identity_id_override": 12,
    }))
    call = provider._client.calls[-1]
    assert call[0] == "publish"
    # override normalized to a decimal string on the wire (daemon regex /^\d+$/)
    assert call[4] == {
        "publishEpochs": 3,
        "publisherNodeIdentityIdOverride": "12",
    }
    assert out["ual"] == "did:dkg:1/0xabc/5"


def test_publish_handler_accepts_numeric_string_forms(provider):
    provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka",
        "publish_epochs": "5", "publisher_node_identity_id_override": "0",
    })
    assert provider._client.calls[-1][4] == {
        "publishEpochs": 5, "publisherNodeIdentityIdOverride": "0",
    }


def test_publish_handler_omits_empty_options(provider):
    provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka",
    })
    assert provider._client.calls[-1][4] is None


# -- C: numeric validation — present-but-invalid -> tool error, nothing on wire

def test_publish_handler_rejects_invalid_publish_epochs(provider):
    for bad in [0, -1, "x", 0x100000000]:
        before = len(provider._client.calls)
        out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
            "context_graph_id": "cg1", "name": "ka", "publish_epochs": bad,
        }))
        assert "publish_epochs" in out["error"], (bad, out)
        # invalid value never reached the wire
        assert len(provider._client.calls) == before, bad


def test_publish_handler_rejects_negative_override(provider):
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka", "publisher_node_identity_id_override": -1,
    }))
    assert "publisher_node_identity_id_override" in out["error"]


def test_finalize_handler_rejects_invalid_scheme_version(provider):
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_finalize", {
        "context_graph_id": "cg1", "name": "ka", "scheme_version": 0,
    }))
    assert "scheme_version" in out["error"]


# -- G3: non-integral numerics must be rejected, never silently truncated

def test_publish_handler_rejects_non_integral_float_epochs(provider):
    before = len(provider._client.calls)
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka", "publish_epochs": 1.9,
    }))
    assert "publish_epochs" in out["error"]          # NOT silently truncated to 1
    assert len(provider._client.calls) == before     # nothing on the wire


def test_publish_handler_accepts_integral_float_epochs(provider):
    provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka", "publish_epochs": 2.0,
    })
    assert provider._client.calls[-1][4] == {"publishEpochs": 2}


def test_validate_int_arg_rejects_fractional_and_truncation(plugin_module):
    v = plugin_module._validate_int_arg
    # fractional float and fractional string are rejected, not truncated
    assert v(1.9, "x", minimum=1)[0] is None and v(1.9, "x", minimum=1)[1]
    assert v("1.9", "x", minimum=1)[0] is None and v("1.9", "x", minimum=1)[1]
    # integral forms accepted
    assert v(2.0, "x", minimum=1) == (2, None)
    assert v(3, "x", minimum=1) == (3, None)
    assert v("4", "x", minimum=1) == (4, None)
    # bool / non-numeric rejected; absent omitted
    assert v(True, "x", minimum=1)[1]
    assert v([], "x", minimum=1)[1]
    assert v(None, "x", minimum=1) == (None, None)


# -- #2805: a present blank/whitespace string is invalid, not omitted ---------

def test_validate_int_arg_rejects_blank_string(plugin_module):
    v = plugin_module._validate_int_arg
    # present but blank/whitespace -> error (NOT silently omitted as a default)
    assert v("", "x", minimum=1)[0] is None and v("", "x", minimum=1)[1]
    assert v("   ", "x", minimum=1)[0] is None and v("   ", "x", minimum=1)[1]
    assert v("\t", "x", minimum=1)[1]
    # truly absent still omits without error
    assert v(None, "x", minimum=1) == (None, None)


def test_publish_handler_rejects_blank_epochs_and_override(provider):
    for blank in ["", "   "]:
        before = len(provider._client.calls)
        out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
            "context_graph_id": "cg1", "name": "ka", "publish_epochs": blank,
        }))
        assert "publish_epochs" in out["error"], (blank, out)
        assert len(provider._client.calls) == before, blank
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka", "publisher_node_identity_id_override": "  ",
    }))
    assert "publisher_node_identity_id_override" in out["error"]


def test_finalize_handler_rejects_blank_scheme_version(provider):
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_finalize", {
        "context_graph_id": "cg1", "name": "ka", "scheme_version": "",
    }))
    assert "scheme_version" in out["error"]


# -- D: clear-after dropped from the per-asset publish tool

def test_publish_schema_has_no_clear_after(provider):
    pub = next(s for s in provider.get_tool_schemas()
               if s["name"] == "dkg_knowledge_asset_publish")
    assert "clear_shared_memory_after" not in pub["parameters"]["properties"]
    assert "clear_after" not in pub["parameters"]["properties"]


def test_publish_handler_ignores_clear_after_arg(provider):
    # an agent that still sends it must not put it on the wire
    provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka", "clear_shared_memory_after": True,
    })
    opts = provider._client.calls[-1][4]
    assert opts is None or "clearSharedMemoryAfter" not in opts


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
