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
        # Override to test §G register_if_needed branches; default success.
        self.register_response = {"registered": "cg", "onChainId": "1"}
        # Override to test the vm/publish 207 partial path; None = default 200.
        self.publish_response = None

    def register_context_graph(self, context_graph_id, access_policy=None):
        self.calls.append(("register", context_graph_id, access_policy))
        return self.register_response

    def finalize_assertion(self, name, cg, sub_graph_name=None,
                           author_agent_address=None, scheme_version=None,
                           layer=None):
        # #1116: accept the new `layer` kwarg ("wm"|"swm") the handler now forwards.
        self.calls.append(("finalize", name, cg, sub_graph_name,
                           author_agent_address, scheme_version, layer))
        return {"merkleRoot": "0xroot", "authorAddress": author_agent_address or "0xdefault"}

    def publish_finalized_assertion(self, name, cg, sub_graph_name=None, options=None):
        self.calls.append(("publish", name, cg, sub_graph_name, options))
        if self.publish_response is not None:
            return self.publish_response
        return {"kaId": "ka1", "ual": "did:dkg:1/0xabc/5", "txHash": "0xtx", "status": "confirmed"}

    def pull_from(self, name, cg, layer, on_conflict=None, sub_graph_name=None):
        self.calls.append(("pull", name, cg, layer, on_conflict, sub_graph_name))
        return {"wmDraft": "open", "seededFrom": {"layer": layer}}

    def promote_assertion(self, name, cg, entities, sub_graph_name=None,
                          skip_seal=None):
        # #1116: accept the new `skip_seal` kwarg the handler now forwards.
        self.calls.append(("share", name, cg, entities, sub_graph_name, skip_seal))
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


def test_share_description_marks_unsealed_swm_read_only(provider):
    # #1116 — a full share now SEALS BY DEFAULT (publish-ready). skip_seal=true
    # is retained only for compatibility and creates read-only SWM content; a
    # default share that cannot seal fails CLOSED (409, WM preserved). Finalize
    # stays the explicit WM path for custom options.
    share = next(s for s in provider.get_tool_schemas()
                 if s["name"] == "dkg_knowledge_asset_share")
    desc = share["description"]
    assert "SEALS BY DEFAULT" in desc
    assert "skip_seal=true" in desc
    assert "retained only for compatibility" in desc
    assert "legacy SWM writes are read-only" in desc
    assert "fails CLOSED" in desc and "409" in desc
    assert "dkg_knowledge_asset_finalize EXPLICITLY first" in desc
    assert "layer=\"swm\" works after" not in desc
    # custom finalize options note is preserved
    assert "author_agent_address" in desc and "scheme_version" in desc


def test_publish_description_ual_middle_segment_is_contract_not_author(provider):
    # Codex #1077:346 — the daemon builds the UAL as
    # did:dkg:<chainId>/<kasAddress>/<id> where the middle segment is the
    # KnowledgeAssets (KAV10) CONTRACT address (update-handler.ts:208/361), NOT
    # the author. The description must not state <author> there, and must keep the
    # separate authorAddress response field accurate (the seal author).
    pub = next(s for s in provider.get_tool_schemas()
               if s["name"] == "dkg_knowledge_asset_publish")
    desc = pub["description"]
    assert "did:dkg:<chainId>/<knowledgeAssetsContractAddress>/<id>" in desc
    assert "<chainId>/<author>/" not in desc
    assert "KnowledgeAssets (KAV10) contract address, NOT the author" in desc
    # the authorAddress response field is still described as the (different) seal author
    assert "authorAddress" in desc and "seal author" in desc


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


def test_share_entities_array_is_stripped_before_promote(provider):
    # FIX K (#1079:2157): each entity is validated with .strip() but the
    # UNSTRIPPED list was forwarded — " urn:a " must reach the daemon stripped.
    provider.handle_tool_call("dkg_knowledge_asset_share", {
        "context_graph_id": "cg1", "name": "ka",
        "entities": [" urn:a ", "urn:b\t", "  urn:c"],
    })
    assert provider._client.calls[-1][3] == ["urn:a", "urn:b", "urn:c"]


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


# -- Codex #1079:750: override preserved as a decimal string (bigint precision)

def test_publish_override_digit_string_preserved_verbatim(provider):
    big = "123456789012345678901234567890"  # >> 2**53, would lose precision as a number
    provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka",
        "publisher_node_identity_id_override": big,
    })
    assert provider._client.calls[-1][4] == {"publisherNodeIdentityIdOverride": big}


def test_publish_override_int_normalized_to_string(provider):
    provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka", "publisher_node_identity_id_override": 12,
    })
    assert provider._client.calls[-1][4] == {"publisherNodeIdentityIdOverride": "12"}


def test_publish_override_rejects_non_digit_and_blank(provider):
    for bad in ["12x", "1.5", "-5", "  ", ""]:
        before = len(provider._client.calls)
        out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
            "context_graph_id": "cg1", "name": "ka",
            "publisher_node_identity_id_override": bad,
        }))
        assert "publisher_node_identity_id_override" in out["error"], (bad, out)
        assert len(provider._client.calls) == before, bad  # nothing on the wire


def test_publish_override_schema_is_digit_string(provider):
    pub = next(s for s in provider.get_tool_schemas()
               if s["name"] == "dkg_knowledge_asset_publish")
    ov = pub["parameters"]["properties"]["publisher_node_identity_id_override"]
    assert ov["type"] == "string"
    assert ov["pattern"] == "^[0-9]+$"


def test_validate_decimal_string_arg_preserves_bigint(plugin_module):
    v = plugin_module._validate_decimal_string_arg
    big = "999999999999999999999999"
    assert v(big, "x") == (big, None)
    assert v(None, "x") == (None, None)
    assert v(0, "x") == ("0", None)
    assert v(-1, "x")[1]
    assert v("1.0", "x")[1]
    assert v("", "x")[1]


def test_query_description_warns_about_post_share_emptying(provider):
    q = next(s for s in provider.get_tool_schemas()
             if s["name"] == "dkg_knowledge_asset_query")
    desc = q["description"]
    assert "WORKING MEMORY DRAFT" in desc
    assert "returns 0" in desc
    assert "shared-working-memory" in desc


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


# -- §G: register_if_needed on the per-KA publish ---------------------------

def _kinds(provider):
    return [c[0] for c in provider._client.calls]


def test_publish_schema_has_register_if_needed(provider):
    pub = next(s for s in provider.get_tool_schemas()
               if s["name"] == "dkg_knowledge_asset_publish")
    props = pub["parameters"]["properties"]
    assert props["register_if_needed"]["type"] == "boolean"
    assert "access_policy" in props


def test_publish_register_if_needed_fresh_cg_registers_then_publishes(provider):
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka", "register_if_needed": True,
    }))
    # register call happens BEFORE publish
    assert _kinds(provider) == ["register", "publish"]
    assert out["status"] == "confirmed"
    assert out["registration"] == {"registered": "cg", "onChainId": "1"}


def test_publish_default_does_not_register(provider):
    json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka",
    }))
    assert _kinds(provider) == ["publish"]
    assert "register" not in _kinds(provider)


def test_publish_register_already_registered_short_circuits(provider):
    provider._client.register_response = {
        "success": False, "error": "Context graph already registered on-chain",
    }
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka", "register_if_needed": True,
    }))
    # "already registered" is treated as success → publish still runs
    assert _kinds(provider) == ["register", "publish"]
    assert out["status"] == "confirmed"
    # FIX H (#1084:1810): the already-registered short-circuit must NOT leave the
    # raw {success:false} on result["registration"] — normalize to a success shape.
    assert out["registration"] == {"alreadyRegistered": True}
    assert out["registration"].get("success") is not False


def test_publish_register_hard_failure_does_not_publish(provider):
    provider._client.register_response = {
        "success": False, "error": "wallet has insufficient gas",
    }
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka", "register_if_needed": True,
    }))
    # register failed (not the idempotent short-circuit) → publish NOT attempted
    assert _kinds(provider) == ["register"]
    assert "publish" not in _kinds(provider)
    assert out["success"] is False
    assert "insufficient gas" in out["error"]


def test_publish_register_if_needed_must_be_boolean(provider):
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka", "register_if_needed": "yes",
    }))
    assert "register_if_needed must be a boolean" in out["error"]
    assert _kinds(provider) == []  # nothing called


def test_publish_register_access_policy_validated_and_forwarded(provider):
    bad = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka",
        "register_if_needed": True, "access_policy": 5,
    }))
    assert "access_policy" in bad["error"]
    # bad access_policy must NOT reach the register call
    assert provider._client.calls == []

    provider._client.calls.clear()
    provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka",
        "register_if_needed": True, "access_policy": 1,
    })
    assert provider._client.calls[0] == ("register", "cg1", 1)


# -- Phase A (#1079): access_policy bool-rejection (bool is an int subclass) --

@pytest.mark.parametrize("bad", [True, False])
def test_publish_register_rejects_bool_access_policy(provider, bad):
    # True/False would slip past a bare `not in (0, 1)` check (True==1, False==0).
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka",
        "register_if_needed": True, "access_policy": bad,
    }))
    assert "access_policy" in out["error"]
    assert provider._client.calls == []  # register never attempted


def test_validate_access_policy_helper_is_bool_safe(plugin_module):
    v = plugin_module._validate_access_policy
    assert v(None) is None
    assert v(0) is None and v(1) is None
    assert v(True) is not None and v(False) is not None
    assert v(2) is not None and v(-1) is not None and v("1") is not None


# -- FIX S (#1084:1792): access_policy requires register_if_needed -------------

def test_per_ka_publish_rejects_access_policy_without_register(provider):
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka", "access_policy": 1,
    }))
    assert "access_policy requires register_if_needed" in out["error"]
    # nothing was published / registered
    assert provider._client.calls == []


def test_per_ka_publish_allows_access_policy_with_register(provider):
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka",
        "register_if_needed": True, "access_policy": 1,
    }))
    assert "access_policy requires register_if_needed" not in out.get("error", "")
    assert provider._client.calls[0] == ("register", "cg1", 1)


def test_access_policy_descriptions_note_register_dependency(provider):
    sch = next(s for s in provider.get_tool_schemas() if s["name"] == "dkg_knowledge_asset_publish")
    desc = sch["parameters"]["properties"]["access_policy"]["description"]
    assert "REQUIRES register_if_needed" in desc


# -- FIX X (#1076:2396 / Option A): explicit-register publishPolicy caveat ------
# The explicit register route uses the daemon's DEFAULT publishPolicy and does not
# preserve a stored custom publishPolicy (daemon-side rehydration = dkg#1085). The
# caveat lives on the explicit-register-exposed canonical publish tool
# (dkg_knowledge_asset_publish).

def test_per_ka_publish_register_desc_carries_publish_policy_caveat(provider):
    sch = next(s for s in provider.get_tool_schemas()
               if s["name"] == "dkg_knowledge_asset_publish")
    desc = sch["parameters"]["properties"]["register_if_needed"]["description"]
    assert "DEFAULT publishPolicy" in desc
    assert "does NOT preserve" in desc
    assert "Read access is unaffected" in desc
    assert "dkg#1085" in desc


def test_access_policy_requires_register_helper(plugin_module):
    f = plugin_module._access_policy_requires_register_error
    assert f({"access_policy": 1}) is not None  # present without register -> error
    assert f({"access_policy": 1, "register_if_needed": True}) is None
    assert f({"register_if_needed": True}) is None  # no access_policy -> ok
    assert f({}) is None
    # register_if_needed falsey (not True) still rejects a present access_policy
    assert f({"access_policy": 0, "register_if_needed": False}) is not None


# -- Phase A (#1079): vm/publish 207 partial surfacing ----------------------

def test_publish_207_partial_surfaces_warning_keeping_ual(provider):
    # HTTP 207: minted on-chain (UAL valid) but the CG-binding failed
    # (contextGraphError present). Must be a PARTIAL/warning, not plain success.
    provider._client.publish_response = {
        "kaId": "ka1", "ual": "did:dkg:1/0xabc/5", "status": "confirmed",
        "contextGraphError": "context-graph binding timed out",
    }
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka",
    }))
    assert out["partial"] is True
    assert "Partial publish" in out["warning"]
    assert "context-graph binding timed out" in out["warning"]
    # the UAL / kaId stay visible — the asset IS on-chain
    assert out["ual"] == "did:dkg:1/0xabc/5"
    assert out["kaId"] == "ka1"
    # FIX I (#1076:3663): the warning must NOT tell the agent to retry the
    # publish (mint succeeded + SWM cleared); it must say don't-re-publish + why
    # + surface to the operator.
    warning = out["warning"]
    assert "retry the publish" not in warning.lower()
    assert "Do NOT re-run publish" in warning
    # The warning now names only the surviving canonical publish (dkg_publish is gone).
    assert "dkg_knowledge_asset_publish" in warning and "VM precondition" in warning
    assert "node operator" in warning


def test_publish_200_clean_success_not_marked_partial(provider):
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka",
    }))
    assert "partial" not in out
    assert "warning" not in out
    assert out["status"] == "confirmed"


def test_publish_empty_context_graph_error_is_not_partial(provider):
    provider._client.publish_response = {
        "ual": "did:dkg:1/0xabc/5", "status": "confirmed", "contextGraphError": "",
    }
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_publish", {
        "context_graph_id": "cg1", "name": "ka",
    }))
    assert "partial" not in out


def test_annotate_vm_publish_partial_helper(plugin_module):
    f = plugin_module._annotate_vm_publish_partial
    r = f({"ual": "u", "contextGraphError": "boom"})
    assert r["partial"] is True and "boom" in r["warning"] and r["ual"] == "u"
    assert "partial" not in f({"ual": "u"})
    assert "partial" not in f({"ual": "u", "contextGraphError": ""})
    assert f("x") == "x"  # non-dict passthrough


def test_annotate_vm_publish_partial_warning_no_retry_guidance(plugin_module):
    # FIX I (#1076:3663): the 207 warning must not advise re-publishing.
    f = plugin_module._annotate_vm_publish_partial
    warning = f({"ual": "u", "contextGraphError": "bind failed"})["warning"]
    assert "retry the publish" not in warning.lower()
    assert "Do NOT re-run publish" in warning
    # Names only the surviving canonical publish; the legacy dkg_publish reference is gone.
    assert "dkg_publish" not in warning
    assert "dkg_knowledge_asset_publish" in warning and "VM precondition" in warning
    assert "node operator" in warning


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


# -- FIX P (#1077:63 parity): create name desc states the real validation ------

def test_create_name_description_aligns_to_validation(provider):
    create = next(s for s in provider.get_tool_schemas()
                  if s["name"] == "dkg_knowledge_asset_create")
    desc = create["parameters"]["properties"]["name"]["description"]
    # no false slug claim; states the real validateAssertionName rule
    assert "lowercase letters, digits, hyphens" not in desc
    assert "/" in desc
    assert "256" in desc
    assert "IRI-unsafe" in desc
    assert "reserved" in desc


# -- #1116 _annotate_share_seal helper (warning branch + recovery surfacing) ---

def test_annotate_share_seal_full_skip_seal_warns_read_only(plugin_module):
    # Legacy SWM is read-only, so direct recovery must not be recommended.
    f = plugin_module._annotate_share_seal
    out = f({"swmShared": True, "publishReady": False}, None)
    assert "NOT publish-ready (sealed:false)" in out["warning"]
    assert "Legacy unsealed SWM content is read-only" in out["warning"]
    assert "preserved Working Memory draft" in out["warning"]
    assert "atomic full share" in out["warning"]
    assert "pull the asset" not in out["warning"]
    assert "pull-from" not in out["warning"]
    assert "NOT sealable" not in out["warning"]
    # "all" is also a full share → same read-only recovery warning.
    out_all = f({"swmShared": True, "publishReady": False}, "all")
    assert "Legacy unsealed SWM content is read-only" in out_all["warning"]


def test_annotate_share_seal_subset_warns_not_sealable(plugin_module):
    # publishReady:false on a SUBSET (non-empty list) → the not-sealable recovery
    # (legacy SWM finalize is read-only).
    f = plugin_module._annotate_share_seal
    out = f({"swmShared": True, "publishReady": False}, ["urn:a"])
    assert "A subset is NOT sealable/publishable" in out["warning"]
    assert 'entities:"all"' in out["warning"]
    assert "Seal it with" not in out["warning"]


def test_create_swm_share_error_flags_207_share_failure(plugin_module):
    # 207 + errors:[{phase:"swm-share"}] (create+seal OK, opt-in share failed) → the
    # tool-error tail, so the create handler reports an error instead of publish-ready.
    f = plugin_module._create_swm_share_error
    msg = f({"status": "wm-sealed", "sealed": True,
             "errors": [{"phase": "swm-share", "error": "write rejected"}]}, True)
    assert msg is not None
    assert "Shared Working Memory share FAILED" in msg
    assert "write rejected" in msg
    assert "NOT publish-ready" in msg
    assert "dkg_knowledge_asset_share" in msg
    # publishReady:false (no explicit error entry) also flags.
    assert f({"publishReady": False}, True) is not None


def test_create_swm_share_error_none_when_share_ok_or_not_requested(plugin_module):
    f = plugin_module._create_swm_share_error
    # Share succeeded (no errors, publishReady true) → no error.
    assert f({"status": "swm-shared", "sealed": True, "publishReady": True}, True) is None
    # Share not requested → None even if (hypothetically) an errors array is present.
    assert f({"errors": [{"phase": "swm-share", "error": "x"}]}, False) is None
    # An unrelated error phase (not swm-share), publishReady absent → None.
    assert f({"errors": [{"phase": "vm-publish", "error": "x"}]}, True) is None


def test_annotate_share_seal_incomplete_full_promote_warns_no_finalize(plugin_module):
    # sealed:true + publishReady:false → an incomplete FULL promote (not every
    # sealed root reached SWM, e.g. foreign-owned roots skipped). The
    # swmShareComplete marker is NOT set, so finalize layer:swm would REJECT — the
    # third warning must NOT recommend it. The `sealed:true` case takes precedence
    # over the entities/subset branch.
    f = plugin_module._annotate_share_seal
    for ent in (None, "all", ["urn:a"]):
        out = f({"swmShared": True, "sealed": True, "publishReady": False}, ent)
        assert "not all roots reached SWM" in out["warning"], ent
        assert "re-share the full asset" in out["warning"], ent
        # NOT the dead-end finalize layer:swm hint, NOT the subset hint.
        assert "recovers + seals" not in out["warning"], ent
        assert "NOT sealable" not in out["warning"], ent


def test_annotate_share_seal_blocked_surfaces_recovery(plugin_module):
    # A 409 UNSEALED_SHARE_BLOCKED body (returned by the client as a dict) →
    # surface the recovery verbatim as {error: recovery}.
    f = plugin_module._annotate_share_seal
    out = f({"code": "UNSEALED_SHARE_BLOCKED", "recovery": "pass skip_seal=true"})
    assert out == {"error": "pass skip_seal=true"}


def test_annotate_share_seal_blocked_without_recovery_passes_through(plugin_module):
    # blocked but no recovery hint → pass the raw body through untouched.
    f = plugin_module._annotate_share_seal
    body = {"code": "UNSEALED_SHARE_BLOCKED"}
    assert f(body) == body


def test_annotate_share_seal_publish_ready_and_non_dict_pass_through(plugin_module):
    f = plugin_module._annotate_share_seal
    # publishReady true → untouched (no warning key).
    ready = {"swmShared": True, "publishReady": True}
    assert f(ready, None) == ready
    assert "warning" not in f(ready, None)
    # non-dict → passthrough.
    assert f("x", None) == "x"


# -- #1116 share handler: skip_seal validation + wire forwarding -----------

def test_share_handler_rejects_non_boolean_skip_seal(provider):
    before = len(provider._client.calls)
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_share", {
        "context_graph_id": "cg1", "name": "ka", "skip_seal": "yes",
    }))
    assert out["error"] == "skip_seal must be a boolean."
    # invalid value never reached the wire
    assert len(provider._client.calls) == before


def test_share_handler_forwards_skip_seal_true_to_client(provider):
    provider.handle_tool_call("dkg_knowledge_asset_share", {
        "context_graph_id": "cg1", "name": "ka", "skip_seal": True,
    })
    # promote_assertion records ("share", name, cg, entities, sub_graph_name, skip_seal)
    assert provider._client.calls[-1][0] == "share"
    assert provider._client.calls[-1][5] is True


# -- #1116 finalize handler: layer validation + wire forwarding ------------

def test_finalize_handler_rejects_invalid_layer(provider):
    before = len(provider._client.calls)
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_finalize", {
        "context_graph_id": "cg1", "name": "ka", "layer": "bogus",
    }))
    assert out["error"] == 'layer must be "wm" or "swm".'
    assert len(provider._client.calls) == before


@pytest.mark.parametrize("bad", [True, False, ["swm"], 1, 0, {"l": "swm"}])
def test_finalize_handler_rejects_non_string_layer(provider, bad):
    # Round-6 reviewer: a PRESENT non-string layer must NOT silently fall through
    # to the default WM seal. The old _first_text() validator coerced any non-string
    # to "" -> treated as omitted -> sealed the default WM layer. Validate
    # args.get("layer") directly: a present non-string ("True"/list/number/dict) is a
    # tool error AND nothing reaches the wire.
    before = len(provider._client.calls)
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_finalize", {
        "context_graph_id": "cg1", "name": "ka", "layer": bad,
    }))
    assert out["error"] == 'layer must be "wm" or "swm".', (bad, out)
    assert len(provider._client.calls) == before, bad  # nothing on the wire


def test_finalize_handler_omitted_layer_defaults_to_none(provider):
    # absent layer key -> default WM seal (layer forwarded as None), no error.
    provider.handle_tool_call("dkg_knowledge_asset_finalize", {
        "context_graph_id": "cg1", "name": "ka",
    })
    assert provider._client.calls[-1][0] == "finalize"
    assert provider._client.calls[-1][6] is None


def test_finalize_handler_forwards_layer_swm_to_client(provider):
    provider.handle_tool_call("dkg_knowledge_asset_finalize", {
        "context_graph_id": "cg1", "name": "ka", "layer": "swm",
    })
    # finalize records ("finalize", name, cg, sub_graph_name, author, scheme_version, layer)
    assert provider._client.calls[-1][0] == "finalize"
    assert provider._client.calls[-1][6] == "swm"


# -- #1116 share handler: publishReady:false warning end-to-end ------------

def test_share_handler_full_skip_seal_warns_read_only_via_annotate(provider):
    # A FULL skip_seal share whose daemon reply is publishReady:false surfaces the
    # read-only recovery warning through the handler (parity with the helper test).
    provider._client.promote_assertion = (  # type: ignore[assignment]
        lambda name, cg, entities, sub_graph_name=None, skip_seal=None: {
            "swmShared": True, "promotedCount": 2, "sealed": False, "publishReady": False,
        }
    )
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_share", {
        "context_graph_id": "cg1", "name": "ka", "skip_seal": True,
    }))
    assert "Legacy unsealed SWM content is read-only" in out["warning"]
    assert "atomic full share" in out["warning"]


def test_share_handler_subset_warns_not_sealable_via_annotate(provider):
    provider._client.promote_assertion = (  # type: ignore[assignment]
        lambda name, cg, entities, sub_graph_name=None, skip_seal=None: {
            "swmShared": True, "promotedCount": 1, "sealed": False, "publishReady": False,
        }
    )
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_share", {
        "context_graph_id": "cg1", "name": "ka", "entities": ["urn:a"],
    }))
    assert "A subset is NOT sealable/publishable" in out["warning"]


def test_share_handler_incomplete_full_promote_warns_via_annotate(provider):
    # A FULL share that sealed but did NOT promote every root → sealed:true +
    # publishReady:false → the incomplete-promote warning (do NOT finalize layer:swm).
    provider._client.promote_assertion = (  # type: ignore[assignment]
        lambda name, cg, entities, sub_graph_name=None, skip_seal=None: {
            "swmShared": True, "promotedCount": 1, "sealed": True, "publishReady": False,
        }
    )
    out = json.loads(provider.handle_tool_call("dkg_knowledge_asset_share", {
        "context_graph_id": "cg1", "name": "ka",
    }))
    assert "not all roots reached SWM" in out["warning"]
    assert "re-share the full asset" in out["warning"]
    assert "recovers + seals" not in out["warning"]
