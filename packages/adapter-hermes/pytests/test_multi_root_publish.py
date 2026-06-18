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


# -- dkg_publish (one-shot) uses the direct publish route -------------------
# (Fast-follow: parity with OpenClaw + MCP. The selection/loop/dedup above is
#  still used by the explicit CG-wide dkg_shared_memory_publish tool.)

import json


class _DirectPublishProbe:
    """Fake client recording the direct one-shot publish."""

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
    p._client = _DirectPublishProbe()
    return p


def test_handle_publish_routes_to_direct_publish(plugin_module):
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


def test_dkg_publish_description_direct_publish(plugin_module):
    p = _publish_provider(plugin_module)
    desc = next(s for s in p.get_tool_schemas() if s["name"] == "dkg_publish")["description"]
    assert "direct publish" in desc.lower()
    assert "shared working memory" in desc.lower()
    assert "does not depend" in desc.lower()
    assert "atomic" in desc.lower()
    assert "one ATOMIC operation" not in desc
    assert "TWO-STEP" not in desc
    assert "two-step" not in desc.lower()
    assert "assertionName" not in desc
    assert "multi-root-safe" in desc
    assert "NON-ATOMIC" not in desc
    assert "per-root" not in desc.lower()


# -- client.publish_quads payload shaping (direct publish route) -------------

def test_publish_quads_posts_inline_quads_to_direct_publish(recording_client):
    client = recording_client
    client.responder = lambda path, body: {
        "kaId": "ka", "ual": "did:dkg:1/0xabc/5", "status": "confirmed",
    }
    result = client.publish_quads("did:dkg:context-graph:cg", [
        {"subject": "urn:s1", "predicate": "urn:p", "object": "x", "graph": "urn:g"},
        {"subject": "urn:s2", "predicate": "urn:p", "object": "y"},
    ])
    paths = [p for p, _ in client.posts]
    assert paths == ["/api/knowledge-assets/publish"]
    publish_body = client.posts[0][1]
    assert publish_body["contextGraphId"] == "cg"
    assert publish_body["quads"] == [
        {"subject": "urn:s1", "predicate": "urn:p", "object": "x", "graph": "urn:g"},
        {"subject": "urn:s2", "predicate": "urn:p", "object": "y", "graph": ""},
    ]
    assert "selection" not in publish_body
    assert "name" not in publish_body
    assert result["ual"] == "did:dkg:1/0xabc/5"


def test_publish_quads_forwards_sub_graph_name(recording_client):
    client = recording_client
    client.responder = lambda path, body: {"kaId": "k", "status": "confirmed"}
    result = client.publish_quads("cg", _Q, sub_graph_name="notes")
    assert result["kaId"] == "k"
    assert client.posts[0][1]["subGraphName"] == "notes"


def test_publish_quads_annotates_207_partial_at_client(recording_client):
    client = recording_client
    client.responder = lambda path, body: {
        "kaId": "k", "ual": "u", "status": "confirmed", "contextGraphError": "bind failed",
    }
    # the client itself (no handler wrap) returns the partial-annotated result
    result = client.publish_quads("cg", _Q)
    assert result["partial"] is True
    assert "Partial publish" in result["warning"]
    assert "bind failed" in result["warning"]
    assert result["ual"] == "u"
    assert "assertionName" not in result


def test_publish_quads_clean_200_not_partial(recording_client):
    client = recording_client
    client.responder = lambda path, body: {"kaId": "k", "ual": "u", "status": "confirmed"}
    result = client.publish_quads("cg", _Q)
    assert "partial" not in result
    assert "warning" not in result


def test_publish_quads_direct_failure_has_no_recovery_assertion_name(recording_client):
    client = recording_client
    client.responder = lambda path, body: {"success": False, "error": "NO_DATA_IN_SWM"}
    result = client.publish_quads("cg", _Q)
    assert result["success"] is False
    assert result["error"] == "NO_DATA_IN_SWM"
    assert "assertionName" not in result
    assert [p for p, _ in client.posts] == ["/api/knowledge-assets/publish"]


def test_annotate_207_partial_client_helper(client_module):
    f = client_module._annotate_207_partial
    r = f({"ual": "u", "contextGraphError": "boom"})
    assert r["partial"] is True and "boom" in r["warning"] and r["ual"] == "u"
    assert "retry the publish" not in r["warning"].lower()
    assert "partial" not in f({"ual": "u"})
    assert "partial" not in f({"ual": "u", "contextGraphError": ""})
    assert f("x") == "x"


# -- Phase B (fast-follow): register_if_needed on the one-shot dkg_publish ----
# Direct publish does NOT auto-register the CG, so dkg_publish gets its own
# register lever (mirrors §G).

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
        "contextGraphError": "cg bind timed out",
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
    assert "assertionName" not in out


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
