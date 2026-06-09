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


def test_publish_epochs_threaded_per_call(recording_client):
    client = recording_client
    client.publish("cg:test", selection=["a", "b"], clear_after=False, publish_epochs=4)

    assert all(body.get("publishEpochs") == 4 for _, body in client.posts)


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
