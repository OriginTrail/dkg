"""Unit tests for the new knowledge-asset lifecycle client methods.

Covers payload shaping for ``finalize_assertion``, ``publish_finalized_assertion``,
and ``pull_from`` (CONTRACT §1 stages 3/5 + the pull-from side verb). No live
daemon — only the request body / path the client builds is asserted.
"""

from __future__ import annotations

import pytest


# -- finalize_assertion -----------------------------------------------------

def test_finalize_threads_author_and_scheme(recording_client):
    client = recording_client
    client.finalize_assertion(
        "my-ka",
        "did:dkg:context-graph:cg1",
        author_agent_address="0xAbC",
        scheme_version=1,
    )
    path, body = client.posts[-1]
    assert path == "/api/knowledge-assets/my-ka/wm/finalize"
    assert body == {
        "contextGraphId": "cg1",
        "authorAgentAddress": "0xAbC",
        "schemeVersion": 1,
    }


def test_finalize_minimal_omits_optional_fields(recording_client):
    client = recording_client
    client.finalize_assertion("k", "cg1")
    _, body = client.posts[-1]
    assert body == {"contextGraphId": "cg1"}


def test_finalize_never_sends_pre_signed_attestation(recording_client):
    client = recording_client
    client.finalize_assertion("k", "cg1", author_agent_address="0xabc")
    _, body = client.posts[-1]
    # Hermes relies on node-side signing — no client-side EIP-712.
    assert "preSignedAuthorAttestation" not in body


def test_finalize_url_encodes_name(recording_client):
    client = recording_client
    client.finalize_assertion("a b", "cg1")
    path, _ = client.posts[-1]
    assert path == "/api/knowledge-assets/a%20b/wm/finalize"


def test_finalize_rejects_layer_swm_before_http(recording_client):
    client = recording_client
    before = len(client.posts)
    with pytest.raises(ValueError, match="read-only"):
        client.finalize_assertion("k", "cg1", layer="swm")
    assert len(client.posts) == before


def test_finalize_omits_layer_when_none(recording_client):
    client = recording_client
    client.finalize_assertion("k", "cg1")
    _, body = client.posts[-1]
    assert "layer" not in body


def test_finalize_accepts_wm_but_omits_layer_from_wire(recording_client):
    client = recording_client
    client.finalize_assertion("k", "cg1", layer="wm")
    _, body = client.posts[-1]
    assert body == {"contextGraphId": "cg1"}


def test_finalize_rejects_non_wm_layer_before_http(recording_client):
    client = recording_client
    before = len(client.posts)
    with pytest.raises(ValueError, match="Working Memory"):
        client.finalize_assertion("k", "cg1", layer="vm")
    assert len(client.posts) == before


# -- promote_assertion (swm/share) ------------------------------------------

def test_promote_rejects_skip_seal_before_http(recording_client):
    client = recording_client
    before = len(client.posts)
    with pytest.raises(ValueError, match="always sealed"):
        client.promote_assertion("k", "cg1", None, skip_seal=True)
    assert len(client.posts) == before


def test_promote_omits_skip_seal_when_none(recording_client):
    client = recording_client
    client.promote_assertion("k", "cg1", None)
    _, body = client.posts[-1]
    assert body == {"contextGraphId": "cg1"}
    assert "skipSeal" not in body
    assert "entities" not in body


def test_promote_accepts_legacy_all_but_serializes_no_scope_fields(recording_client):
    client = recording_client
    client.promote_assertion("k", "cg1", "all", skip_seal=False)
    _, body = client.posts[-1]
    assert body == {"contextGraphId": "cg1"}


def test_promote_rejects_root_selection_before_http(recording_client):
    client = recording_client
    before = len(client.posts)
    with pytest.raises(ValueError, match="shared atomically"):
        client.promote_assertion("k", "cg1", ["urn:a"])
    assert len(client.posts) == before


def test_promote_rejects_malformed_legacy_values_before_http(recording_client):
    client = recording_client
    before = len(client.posts)
    with pytest.raises(ValueError, match="shared atomically"):
        client.promote_assertion("k", "cg1", "urn:not-all")
    with pytest.raises(TypeError, match="false or omitted"):
        client.promote_assertion("k", "cg1", None, skip_seal="yes")
    assert len(client.posts) == before


# -- publish_finalized_assertion --------------------------------------------

def test_publish_nests_options_and_omits_author_selection(recording_client):
    client = recording_client
    client.publish_finalized_assertion(
        "my-ka",
        "cg1",
        options={"publishEpochs": 2, "clearSharedMemoryAfter": True},
    )
    path, body = client.posts[-1]
    assert path == "/api/knowledge-assets/my-ka/vm/publish"
    assert body == {
        "contextGraphId": "cg1",
        "options": {"publishEpochs": 2, "clearSharedMemoryAfter": True},
    }
    # the daemon rejects these on vm/publish — never send them
    assert "authorAgentAddress" not in body
    assert "selection" not in body
    assert "assertionName" not in body


def test_publish_without_options_omits_options_key(recording_client):
    client = recording_client
    client.publish_finalized_assertion("k", "cg1", options=None)
    _, body = client.posts[-1]
    assert body == {"contextGraphId": "cg1"}


def test_publish_empty_options_dict_is_dropped(recording_client):
    client = recording_client
    client.publish_finalized_assertion("k", "cg1", options={})
    _, body = client.posts[-1]
    assert "options" not in body


def test_publish_forwards_sub_graph_name(recording_client):
    client = recording_client
    client.publish_finalized_assertion("k", "cg1", sub_graph_name="sub")
    _, body = client.posts[-1]
    assert body["subGraphName"] == "sub"


# -- pull_from --------------------------------------------------------------

def test_pull_from_requires_layer_in_body(recording_client):
    client = recording_client
    client.pull_from("my-ka", "cg1", "swm", on_conflict="replace")
    path, body = client.posts[-1]
    assert path == "/api/knowledge-assets/my-ka/wm/pull-from"
    assert body == {"contextGraphId": "cg1", "layer": "swm", "onConflict": "replace"}


def test_pull_from_minimal_omits_on_conflict(recording_client):
    client = recording_client
    client.pull_from("k", "cg1", "vm")
    _, body = client.posts[-1]
    assert body == {"contextGraphId": "cg1", "layer": "vm"}
