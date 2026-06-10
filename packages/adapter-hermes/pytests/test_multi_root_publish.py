"""Unit tests for the one-root-per-call SWM publish loop (P0 multi-root 409 fix).

The legacy ``/api/shared-memory/publish`` bridge (Fork-2) is single-root-only:
a selection that resolves to >1 root is rejected with
``409 MULTI_ROOT_PUBLISH_NOT_ATOMIC`` (memory.ts:1864-1872). ``client.publish``
must partition an explicit root list into one publish call per root, with
``clearAfter=False`` on all but the last (CONTRACT §3).
"""

from __future__ import annotations


def test_multi_root_loops_one_call_per_root(recording_client):
    client = recording_client
    result = client.publish("cg:test", selection=["a", "b", "c"], clear_after=True)

    assert result["success"] is True
    assert result["rootEntities"] == ["a", "b", "c"]
    # exactly one publish call per root, in order
    assert [body["selection"] for _, body in client.posts] == [["a"], ["b"], ["c"]]
    # clearAfter False on all but the last call
    assert [body["clearAfter"] for _, body in client.posts] == [False, False, True]
    # each call hits the legacy bridge
    assert {path for path, _ in client.posts} == {"/api/shared-memory/publish"}


def test_single_root_list_collapses_to_one_call(recording_client):
    client = recording_client
    result = client.publish("cg:test", selection=["only"], clear_after=True)

    assert len(client.posts) == 1
    path, body = client.posts[0]
    assert path == "/api/shared-memory/publish"
    assert body["selection"] == ["only"]
    assert body["clearAfter"] is True
    assert "success" in result or "echoed" in result


def test_selection_all_passes_through_untouched(recording_client):
    client = recording_client
    client.publish("cg:test", selection="all", clear_after=True)

    assert len(client.posts) == 1
    _, body = client.posts[0]
    # "all" is forwarded as-is so the daemon resolves the roots server-side
    assert body["selection"] == "all"
    assert body["clearAfter"] is True


def test_empty_selection_list_is_structured_error_no_call(recording_client):
    client = recording_client
    result = client.publish("cg:test", selection=[], clear_after=True)

    assert result["success"] is False
    assert "No root entities" in result["error"]
    assert client.posts == []


def test_loop_stops_on_first_failure_and_surfaces_409(recording_client):
    client = recording_client

    def responder(path, body):
        # second root fails the way _post surfaces a 409 body
        if body["selection"][0] == "b":
            return {
                "success": False,
                "error": "MULTI_ROOT_PUBLISH_NOT_ATOMIC",
                "code": "MULTI_ROOT_PUBLISH_NOT_ATOMIC",
            }
        return {"kaId": "ka-" + body["selection"][0], "status": "confirmed"}

    client.responder = responder
    result = client.publish("cg:test", selection=["a", "b", "c"], clear_after=True)

    assert result["success"] is False
    assert result["failedRoot"] == "b"
    # the 409 body is surfaced, not raised
    assert result["code"] == "MULTI_ROOT_PUBLISH_NOT_ATOMIC"
    # 'a' published; loop stopped before 'c'
    assert [entry["rootEntity"] for entry in result["published"]] == ["a"]
    assert [body["selection"] for _, body in client.posts] == [["a"], ["b"]]


def test_partial_failure_reports_explicit_transparency(recording_client):
    # G1: a partial multi-root failure must EXPLICITLY report which roots were
    # published on-chain (TRAC spent), which failed, and which were not attempted.
    client = recording_client

    def responder(path, body):
        if body["selection"][0] == "c":
            return {"success": False, "error": "boom"}
        return {"kaId": "ka-" + body["selection"][0], "status": "confirmed"}

    client.responder = responder
    result = client.publish("cg:test", selection=["a", "b", "c", "d"], clear_after=True)

    assert result["success"] is False
    assert result["partial"] is True
    assert result["publishedRoots"] == ["a", "b"]   # minted on-chain, TRAC spent
    assert result["failedRoot"] == "c"
    assert result["notAttemptedRoots"] == ["d"]
    # plain-language guidance about irreversibility + don't-retry-the-whole-set
    assert "TRAC spent" in result["message"]
    assert "irreversible" in result["message"]
    # only a, b, c were attempted — never d
    assert [body["selection"] for _, body in client.posts] == [["a"], ["b"], ["c"]]


def test_full_success_marks_partial_false(recording_client):
    client = recording_client
    result = client.publish("cg:test", selection=["a", "b"], clear_after=True)
    assert result["success"] is True
    assert result["partial"] is False


def test_multi_root_207_child_flips_aggregate_partial(recording_client):
    # FIX Q (#1079:764): a per-root child can be a 207 (minted but CG-bind failed
    # — contextGraphError present) which passes _client_result_failed. The
    # aggregate must NOT hard-code partial:False; it flags partial + warning.
    client = recording_client

    def responder(path, body):
        root = body["selection"][0]
        if root == "b":
            return {"kaId": "ka-b", "status": "confirmed", "contextGraphError": "bind timed out"}
        return {"kaId": "ka-" + root, "status": "confirmed"}

    client.responder = responder
    result = client.publish("cg:test", selection=["a", "b", "c"], clear_after=False)
    # all roots minted -> success, but flagged partial because of the bind failure
    assert result["success"] is True
    assert result["partial"] is True
    assert "bind timed out" in result["warning"]
    assert "b" in result["warning"]
    assert "do NOT re-publish" in result["warning"]
    assert len(result["published"]) == 3


def test_multi_root_no_207_child_partial_false(recording_client):
    client = recording_client
    client.responder = lambda path, body: {
        "kaId": "ka-" + body["selection"][0], "status": "confirmed",
    }
    result = client.publish("cg:test", selection=["a", "b"], clear_after=False)
    assert result["partial"] is False
    assert "warning" not in result


def test_context_graph_id_is_normalized(recording_client):
    client = recording_client
    client.publish("did:dkg:context-graph:cg1", selection=["a", "b"], clear_after=True)

    assert all(body["contextGraphId"] == "cg1" for _, body in client.posts)


# -- F: dedupe the per-root publish list preserving first-seen order --------

def test_duplicate_roots_dedup_preserving_order(recording_client):
    client = recording_client
    result = client.publish("cg:test", selection=["a", "b", "a", "c", "b"], clear_after=True)

    # N DISTINCT calls, one per unique root, in first-seen order — not N-with-repeats
    assert result["rootEntities"] == ["a", "b", "c"]
    assert [body["selection"] for _, body in client.posts] == [["a"], ["b"], ["c"]]
    # clearAfter still only true on the final (last unique) call
    assert [body["clearAfter"] for _, body in client.posts] == [False, False, True]


def test_all_duplicate_roots_collapse_to_single_call(recording_client):
    client = recording_client
    client.publish("cg:test", selection=["z", "z", "z"], clear_after=True)

    assert len(client.posts) == 1
    _, body = client.posts[0]
    assert body["selection"] == ["z"]
    assert body["clearAfter"] is True


# -- dkg_publish (one-shot) uses the ATOMIC assertionName fork --------------
# (Fast-follow: parity with OpenClaw + MCP. The selection/loop/dedup above is
#  still used by the explicit CG-wide dkg_shared_memory_publish tool.)

import json


class _AssertionNameProbe:
    """Fake client recording the assertionName-fork one-shot publish."""

    def __init__(self):
        self.publish_quads_call = None

    def publish_quads(self, context_graph_id, quads, sub_graph_name=None):
        self.publish_quads_call = {
            "contextGraphId": context_graph_id,
            "quads": quads,
            "subGraphName": sub_graph_name,
        }
        return {"kaId": "ka", "ual": "did:dkg:1/0xabc/5", "status": "confirmed"}


def _publish_provider(plugin_module):
    p = plugin_module.DKGMemoryProvider()
    p._offline = False
    p._config = {"publish_tool": "direct", "allow_direct_publish": True}
    p._client = _AssertionNameProbe()
    return p


def test_handle_publish_routes_to_assertionname_fork(plugin_module):
    p = _publish_provider(plugin_module)
    out = json.loads(p.handle_tool_call("dkg_publish", {
        "context_graph_id": "cg:test",
        "quads": [{"subject": "urn:root:solo", "predicate": "urn:p", "object": "one"}],
    }))
    # one atomic publish_quads call — no per-root selection/loop
    assert p._client.publish_quads_call["contextGraphId"] == "cg:test"
    assert out["ual"] == "did:dkg:1/0xabc/5"
    assert out["quadsPublished"] == 1


def test_handle_publish_multi_subject_one_atomic_call(plugin_module):
    p = _publish_provider(plugin_module)
    out = json.loads(p.handle_tool_call("dkg_publish", {
        "context_graph_id": "cg:test",
        "quads": [
            {"subject": "urn:root:1", "predicate": "urn:p", "object": "x"},
            {"subject": "urn:root:2", "predicate": "urn:p", "object": "y"},
        ],
    }))
    # multi-subject publishes atomically in ONE call — no 409, no over-scope
    assert len(p._client.publish_quads_call["quads"]) == 2
    assert out["ual"] == "did:dkg:1/0xabc/5"


def test_handle_publish_result_has_no_per_root_shape(plugin_module):
    p = _publish_provider(plugin_module)
    out = json.loads(p.handle_tool_call("dkg_publish", {
        "context_graph_id": "cg:test",
        "quads": [{"subject": "urn:r", "predicate": "urn:p", "object": "o"}],
    }))
    # the obsolete selection-fork result fields are gone
    for key in ("rootEntities", "partial", "publishedRoots",
                "failedRoot", "notAttemptedRoots"):
        assert key not in out, key


def test_dkg_publish_description_atomic_mint_two_step(plugin_module):
    # FIX L (#1084:324): the ATOMIC claim is scoped to the on-chain MINT
    # (multi-root-safe); the whole helper is a TWO-STEP create-then-publish that
    # can partially fail — it must NOT be called "one ATOMIC operation".
    p = _publish_provider(plugin_module)
    desc = next(s for s in p.get_tool_schemas() if s["name"] == "dkg_publish")["description"]
    assert "atomic" in desc.lower()
    assert "one ATOMIC operation" not in desc
    assert "TWO-STEP" in desc or "two-step" in desc.lower()
    assert "partially fail" in desc.lower()
    assert "multi-root-safe" in desc
    assert "NON-ATOMIC" not in desc
    assert "per-root" not in desc.lower()


# -- client.publish_quads payload shaping (assertionName fork) ---------------

def test_publish_quads_two_calls_create_then_publish_by_name(recording_client):
    client = recording_client

    def responder(path, body):
        if path == "/api/knowledge-assets":
            # the create route returns merkleRoot (a hex string), not a seal object
            return {"assertionUri": "urn:a", "merkleRoot": "0xr"}
        return {"kaId": "ka", "ual": "did:dkg:1/0xabc/5", "status": "confirmed"}

    client.responder = responder
    result = client.publish_quads("did:dkg:context-graph:cg", [
        {"subject": "urn:s1", "predicate": "urn:p", "object": "x", "graph": "urn:g"},
        {"subject": "urn:s2", "predicate": "urn:p", "object": "y"},
    ])
    paths = [p for p, _ in client.posts]
    assert paths == ["/api/knowledge-assets", "/api/shared-memory/publish"]
    create_body = client.posts[0][1]
    assert create_body["contextGraphId"] == "cg"
    assert create_body["promote"] is True
    assert create_body["name"].startswith("hermes-publish-")
    # graph stripped on the create quads (CONTRACT §0 invariant 2)
    assert all(set(q.keys()) == {"subject", "predicate", "object"} for q in create_body["quads"])
    publish_body = client.posts[1][1]
    # assertionName fork — name only, NO selection
    assert publish_body == {"contextGraphId": "cg", "assertionName": create_body["name"]}
    assert "selection" not in publish_body
    # merged result surfaces ual/assertionUri/merkleRoot/assertionName
    assert result["ual"] == "did:dkg:1/0xabc/5"
    assert result["assertionUri"] == "urn:a"
    assert result["merkleRoot"] == "0xr"
    assert "seal" not in result  # FIX J: the always-None seal is gone
    assert result["assertionName"] == create_body["name"]


def test_publish_quads_unique_name_per_call(recording_client):
    client = recording_client
    client.responder = lambda path, body: (
        {"assertionUri": "u"} if path == "/api/knowledge-assets" else {"status": "confirmed"}
    )
    client.publish_quads("cg", [{"subject": "urn:s", "predicate": "urn:p", "object": "o"}])
    n1 = client.posts[0][1]["name"]
    client.posts.clear()
    client.publish_quads("cg", [{"subject": "urn:s", "predicate": "urn:p", "object": "o"}])
    n2 = client.posts[0][1]["name"]
    assert n1 != n2


def test_publish_quads_create_failure_short_circuits(recording_client):
    # FIX W (#1084:743): the create HARD-failure must surface the assertionName so a
    # created-but-lost-response is recoverable by name (mirrors the share/publish
    # failure branches) — NOT return the raw error verbatim, which drops the name.
    client = recording_client
    client.responder = lambda path, body: (
        {"success": False, "error": "boom"} if path == "/api/knowledge-assets" else {"status": "confirmed"}
    )
    result = client.publish_quads("cg", [{"subject": "urn:s", "predicate": "urn:p", "object": "o"}])
    assert result["success"] is False
    assert result["assertionName"].startswith("hermes-publish-")
    # the original daemon error stays visible, wrapped in recover-by-name guidance
    assert "boom" in result["error"]
    assert result["assertionName"] in result["error"]
    assert "before recreating" in result["error"]
    # publish was never attempted
    assert [p for p, _ in client.posts] == ["/api/knowledge-assets"]


def test_publish_quads_create_failure_carries_sub_graph_name(recording_client):
    # FIX W: recovery by name needs the sub-graph the create targeted.
    client = recording_client
    client.responder = lambda path, body: (
        {"success": False, "error": "boom"} if path == "/api/knowledge-assets" else {"status": "confirmed"}
    )
    result = client.publish_quads(
        "cg", [{"subject": "urn:s", "predicate": "urn:p", "object": "o"}],
        sub_graph_name="evidence",
    )
    assert result["subGraphName"] == "evidence"
    assert "sub-graph 'evidence'" in result["error"]


# -- FIX A (#1084:714): create 207 with errors[] (share failed) -> no publish -

def test_publish_quads_create_207_errors_does_not_publish(recording_client):
    client = recording_client
    client.responder = lambda path, body: (
        {
            "created": True, "assertionUri": "urn:a", "merkleRoot": "0xr",
            "status": "wm-sealed",
            "errors": [{"phase": "swm-share", "error": "gossip timeout"}],
        }
        if path == "/api/knowledge-assets" else {"kaId": "k", "ual": "u", "status": "confirmed"}
    )
    result = client.publish_quads("cg", _Q)
    # the assertion was sealed but NOT shared -> must NOT publish
    assert [p for p, _ in client.posts] == ["/api/knowledge-assets"]
    assert result["success"] is False
    # assertionName + recovery context surfaced
    assert result["assertionName"].startswith("hermes-publish-")
    assert result["assertionUri"] == "urn:a"
    # FIX J (#1084:733): carry merkleRoot (the create proof), not the always-None seal
    assert result["merkleRoot"] == "0xr"
    assert "seal" not in result
    assert "swm-share" in result["error"]
    assert "NOT shared" in result["error"]
    assert "recreate" in result["error"].lower()
    # FIX F (#1084:742): point to dkg_knowledge_asset_share + _publish, NOT
    # dkg_shared_memory_publish (which can't retry by name).
    assert "dkg_knowledge_asset_share" in result["error"]
    assert "dkg_knowledge_asset_publish" in result["error"]
    assert "dkg_shared_memory_publish" not in result["error"]


def test_publish_quads_create_empty_errors_publishes(recording_client):
    client = recording_client
    client.responder = lambda path, body: (
        {"created": True, "assertionUri": "urn:a", "errors": []}
        if path == "/api/knowledge-assets" else {"kaId": "k", "ual": "u", "status": "confirmed"}
    )
    result = client.publish_quads("cg", _Q)
    assert [p for p, _ in client.posts] == ["/api/knowledge-assets", "/api/shared-memory/publish"]
    assert result["ual"] == "u"


# -- FIX B (#1084:723): publish fails after create+share -> keep assertionName -

def test_publish_quads_publish_failure_merges_assertion_name(recording_client):
    client = recording_client
    client.responder = lambda path, body: (
        {"assertionUri": "urn:a", "merkleRoot": "0xr", "swmShared": True}
        if path == "/api/knowledge-assets"
        else {"success": False, "error": "chain revert: insufficient TRAC"}
    )
    result = client.publish_quads("cg", _Q)
    assert [p for p, _ in client.posts] == ["/api/knowledge-assets", "/api/shared-memory/publish"]
    assert result["success"] is False
    # the random name is kept (don't recreate — retry by name)
    assert result["assertionName"].startswith("hermes-publish-")
    assert result["assertionUri"] == "urn:a"
    # FIX J (#1084:733): carry merkleRoot, not the always-None seal
    assert result["merkleRoot"] == "0xr"
    assert "seal" not in result
    assert "insufficient TRAC" in result["error"]
    assert "shared to SWM" in result["error"]
    assert "Retry the publish" in result["error"]
    assert "recreate" in result["error"].lower()
    # FIX F (#1084:742): retry-by-name points to dkg_knowledge_asset_publish only.
    assert "dkg_knowledge_asset_publish" in result["error"]
    assert "dkg_shared_memory_publish" not in result["error"]


# -- FIX O (#1084:730): recovery payloads carry subGraphName + mention it -------

def test_publish_quads_create_207_carries_sub_graph_name(recording_client):
    client = recording_client
    client.responder = lambda path, body: (
        {"created": True, "assertionUri": "urn:a", "merkleRoot": "0xr",
         "errors": [{"phase": "swm-share", "error": "x"}]}
        if path == "/api/knowledge-assets" else {"status": "confirmed"}
    )
    result = client.publish_quads("cg", _Q, sub_graph_name="notes")
    assert result["subGraphName"] == "notes"
    assert "sub-graph 'notes'" in result["error"]
    assert "sub_graph_name" in result["error"]  # guidance mentions it for recovery


def test_publish_quads_publish_fail_carries_sub_graph_name(recording_client):
    client = recording_client
    client.responder = lambda path, body: (
        {"assertionUri": "urn:a", "merkleRoot": "0xr", "swmShared": True}
        if path == "/api/knowledge-assets"
        else {"success": False, "error": "chain revert"}
    )
    result = client.publish_quads("cg", _Q, sub_graph_name="notes")
    assert result["subGraphName"] == "notes"
    assert "sub-graph 'notes'" in result["error"]
    assert "sub_graph_name" in result["error"]


def test_publish_quads_recovery_omits_sub_graph_name_when_absent(recording_client):
    client = recording_client
    client.responder = lambda path, body: (
        {"created": True, "errors": [{"phase": "swm-share", "error": "x"}]}
        if path == "/api/knowledge-assets" else {"status": "confirmed"}
    )
    result = client.publish_quads("cg", _Q)
    assert "subGraphName" not in result
    assert "sub-graph" not in result["error"]


# -- FIX R (#1084:787): publish_quads annotates a 207 at the client ------------

def test_publish_quads_annotates_207_partial_at_client(recording_client):
    client = recording_client
    client.responder = lambda path, body: (
        {"assertionUri": "urn:a", "merkleRoot": "0xr"}
        if path == "/api/knowledge-assets"
        else {"kaId": "k", "ual": "u", "status": "confirmed", "contextGraphError": "bind failed"}
    )
    # the client itself (no handler wrap) returns the partial-annotated result
    result = client.publish_quads("cg", _Q)
    assert result["partial"] is True
    assert "Partial publish" in result["warning"]
    assert "bind failed" in result["warning"]
    assert result["ual"] == "u"
    assert result["assertionName"].startswith("hermes-publish-")


def test_publish_quads_clean_200_not_partial(recording_client):
    client = recording_client
    client.responder = lambda path, body: (
        {"assertionUri": "urn:a", "merkleRoot": "0xr"}
        if path == "/api/knowledge-assets"
        else {"kaId": "k", "ual": "u", "status": "confirmed"}
    )
    result = client.publish_quads("cg", _Q)
    assert "partial" not in result
    assert "warning" not in result


def test_annotate_207_partial_client_helper(client_module):
    f = client_module._annotate_207_partial
    r = f({"ual": "u", "contextGraphError": "boom"})
    assert r["partial"] is True and "boom" in r["warning"] and r["ual"] == "u"
    assert "retry the publish" not in r["warning"].lower()
    assert "partial" not in f({"ual": "u"})
    assert "partial" not in f({"ual": "u", "contextGraphError": ""})
    assert f("x") == "x"


# -- Phase B (fast-follow): register_if_needed on the one-shot dkg_publish ----
# The atomic assertionName fork does NOT auto-register the CG (LU-6 is selection-
# fork only), so dkg_publish gets its own register lever (mirrors §G).

_Q = [{"subject": "urn:s", "predicate": "urn:p", "object": "o"}]


class _RegisterProbe:
    """Fake client recording register + publish_quads for dkg_publish."""

    def __init__(self, register_response, publish_response=None):
        self.calls = []
        self.register_response = register_response
        self.publish_response = publish_response or {
            "kaId": "ka", "ual": "did:dkg:1/0xabc/5", "status": "confirmed",
        }

    def register_context_graph(self, context_graph_id, access_policy=None):
        self.calls.append(("register", context_graph_id, access_policy))
        return self.register_response

    def publish_quads(self, context_graph_id, quads, sub_graph_name=None):
        self.calls.append(("publish", context_graph_id, len(quads)))
        return self.publish_response


def _register_provider(plugin_module, register_response, publish_response=None):
    p = plugin_module.DKGMemoryProvider()
    p._offline = False
    p._config = {"publish_tool": "direct", "allow_direct_publish": True}
    p._client = _RegisterProbe(register_response, publish_response)
    return p


def _kinds(p):
    return [c[0] for c in p._client.calls]


def test_publish_register_if_needed_fresh_cg(plugin_module):
    p = _register_provider(plugin_module, {"registered": "cg", "onChainId": "42"})
    out = json.loads(p.handle_tool_call("dkg_publish", {
        "context_graph_id": "cg", "quads": _Q, "register_if_needed": True,
    }))
    assert _kinds(p) == ["register", "publish"]  # register BEFORE publish
    assert out["registration"] == {"registered": "cg", "onChainId": "42"}
    assert out["ual"] == "did:dkg:1/0xabc/5"


def test_publish_default_no_register(plugin_module):
    p = _register_provider(plugin_module, {"registered": "cg"})
    out = json.loads(p.handle_tool_call("dkg_publish", {
        "context_graph_id": "cg", "quads": _Q,
    }))
    assert _kinds(p) == ["publish"]
    assert "registration" not in out


def test_publish_register_already_registered_short_circuits(plugin_module):
    p = _register_provider(plugin_module, {
        "success": False, "error": "Context graph already registered on-chain",
    })
    out = json.loads(p.handle_tool_call("dkg_publish", {
        "context_graph_id": "cg", "quads": _Q, "register_if_needed": True,
    }))
    assert _kinds(p) == ["register", "publish"]
    assert out["ual"] == "did:dkg:1/0xabc/5"
    # FIX H (#1084:1810): the already-registered short-circuit normalizes the
    # registration to a success shape — NOT the raw {success:false}.
    assert out["registration"] == {"alreadyRegistered": True}
    assert out["registration"].get("success") is not False


# -- FIX E (#1077:1115): dkg_publish 207 contextGraphError -> partial/warning --

def test_publish_207_context_graph_error_surfaces_partial(plugin_module):
    p = _register_provider(plugin_module, {"registered": "cg"}, publish_response={
        "kaId": "ka", "ual": "did:dkg:1/0xabc/5", "status": "confirmed",
        "assertionName": "hermes-publish-x", "contextGraphError": "cg bind timed out",
    })
    out = json.loads(p.handle_tool_call("dkg_publish", {
        "context_graph_id": "cg", "quads": _Q,
    }))
    assert out["partial"] is True
    assert "Partial publish" in out["warning"]
    assert "cg bind timed out" in out["warning"]
    # minted-on-chain identifiers stay visible
    assert out["ual"] == "did:dkg:1/0xabc/5"
    assert out["kaId"] == "ka"
    assert out["assertionName"] == "hermes-publish-x"


def test_publish_clean_200_not_marked_partial(plugin_module):
    p = _register_provider(plugin_module, {"registered": "cg"})
    out = json.loads(p.handle_tool_call("dkg_publish", {
        "context_graph_id": "cg", "quads": _Q,
    }))
    assert "partial" not in out
    assert "warning" not in out


def test_publish_register_hard_failure_no_publish(plugin_module):
    p = _register_provider(plugin_module, {"success": False, "error": "insufficient gas"})
    out = json.loads(p.handle_tool_call("dkg_publish", {
        "context_graph_id": "cg", "quads": _Q, "register_if_needed": True,
    }))
    assert _kinds(p) == ["register"]  # publish NOT attempted
    assert out["success"] is False
    assert "insufficient gas" in out["error"]


def test_publish_register_if_needed_bool_and_access_policy_guards(plugin_module):
    p = _register_provider(plugin_module, {"registered": "cg"})
    out = json.loads(p.handle_tool_call("dkg_publish", {
        "context_graph_id": "cg", "quads": _Q, "register_if_needed": "yes",
    }))
    assert "register_if_needed must be a boolean" in out["error"]
    assert p._client.calls == []
    # bool access_policy rejected (Phase-A guard), register not attempted
    for bad in (True, False, 5):
        out = json.loads(p.handle_tool_call("dkg_publish", {
            "context_graph_id": "cg", "quads": _Q,
            "register_if_needed": True, "access_policy": bad,
        }))
        assert "access_policy" in out["error"], bad
        assert p._client.calls == [], bad


def test_publish_register_access_policy_forwarded(plugin_module):
    p = _register_provider(plugin_module, {"registered": "cg"})
    p.handle_tool_call("dkg_publish", {
        "context_graph_id": "cg", "quads": _Q,
        "register_if_needed": True, "access_policy": 1,
    })
    assert p._client.calls[0] == ("register", "cg", 1)


def test_publish_schema_has_register_if_needed(plugin_module):
    p = _register_provider(plugin_module, {"registered": "cg"})
    pub = next(s for s in p.get_tool_schemas() if s["name"] == "dkg_publish")
    props = pub["parameters"]["properties"]
    assert props["register_if_needed"]["type"] == "boolean"
    assert "access_policy" in props


# -- FIX S (#1084:1792): access_policy on dkg_publish requires register_if_needed
# access_policy is only honoured inside the register_if_needed branch, so sending
# it WITHOUT register_if_needed silently dropped the privacy setting — reject it.

def test_publish_rejects_access_policy_without_register(plugin_module):
    p = _register_provider(plugin_module, {"registered": "cg"})
    out = json.loads(p.handle_tool_call("dkg_publish", {
        "context_graph_id": "cg", "quads": _Q, "access_policy": 1,
    }))
    assert "access_policy requires register_if_needed" in out["error"]
    # rejected before any register/publish — the privacy setting is never dropped
    assert p._client.calls == []


def test_publish_allows_access_policy_with_register(plugin_module):
    p = _register_provider(plugin_module, {"registered": "cg"})
    out = json.loads(p.handle_tool_call("dkg_publish", {
        "context_graph_id": "cg", "quads": _Q,
        "register_if_needed": True, "access_policy": 1,
    }))
    assert "access_policy requires register_if_needed" not in out.get("error", "")
    assert p._client.calls[0] == ("register", "cg", 1)


def test_publish_access_policy_description_notes_register_dependency(plugin_module):
    p = _register_provider(plugin_module, {"registered": "cg"})
    pub = next(s for s in p.get_tool_schemas() if s["name"] == "dkg_publish")
    desc = pub["parameters"]["properties"]["access_policy"]["description"]
    assert "REQUIRES register_if_needed" in desc


# -- FIX X (#1076:2396 / Option A): dkg_publish explicit-register publishPolicy caveat
# dkg_publish exposes the explicit register route (no rehydration), so its
# register_if_needed must carry the default-publishPolicy caveat (daemon-side
# rehydration tracked in dkg#1085).

def test_publish_register_desc_carries_publish_policy_caveat(plugin_module):
    p = _register_provider(plugin_module, {"registered": "cg"})
    pub = next(s for s in p.get_tool_schemas() if s["name"] == "dkg_publish")
    desc = pub["parameters"]["properties"]["register_if_needed"]["description"]
    assert "DEFAULT publishPolicy" in desc
    assert "does NOT preserve" in desc
    assert "Read access is unaffected" in desc
    assert "dkg#1085" in desc
