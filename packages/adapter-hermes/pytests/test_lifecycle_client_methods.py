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


# -- per-route timeout classes ------------------------------------------------
#
# The fake transport answers after ``latency`` seconds and applies requests'
# timeout semantics without sleeping: a read deadline shorter than the latency
# raises ReadTimeout, a connect deadline shorter than ``connect_latency`` raises
# ConnectTimeout. The client runs with a 1 s read class and a 10 s long class.

class _FakeResponse:
    def __init__(self, body):
        self._body = body

    def raise_for_status(self):
        pass

    def json(self):
        return self._body


class _SlowDaemon:
    def __init__(self, latency, connect_latency=0.0):
        self.latency = latency
        self.connect_latency = connect_latency
        self.headers = {}
        self.timeouts = []

    def post(self, url, data=None, files=None, headers=None, timeout=None):
        import requests

        self.timeouts.append(timeout)
        connect, read = timeout if isinstance(timeout, tuple) else (timeout, timeout)
        if self.connect_latency > connect:
            raise requests.exceptions.ConnectTimeout("connect timed out")
        if self.latency > read:
            raise requests.exceptions.ReadTimeout("read timed out")
        return _FakeResponse({"kaId": "7", "status": "confirmed"})


def _client_with(client_module, daemon, **kwargs):
    client = client_module.DKGClient(timeout=1, long_mutation_timeout=10, **kwargs)
    client._session = daemon
    return client


def test_publish_outlasting_read_timeout_is_not_reported_as_failed(client_module):
    daemon = _SlowDaemon(latency=5)
    client = _client_with(client_module, daemon)
    result = client.publish_finalized_assertion("my-ka", "cg1")
    assert result == {"kaId": "7", "status": "confirmed"}
    assert not client_module._client_result_failed(result)
    # Connecting keeps the read deadline; only the wait for the answer is long.
    assert daemon.timeouts == [(1, 10)]


def test_quick_post_still_fails_at_read_timeout(client_module):
    # Negative control: the same latency on a quick mutation is a real timeout.
    daemon = _SlowDaemon(latency=5)
    client = _client_with(client_module, daemon)
    result = client.write_assertion("my-ka", "cg1", [{"subject": "urn:s", "predicate": "urn:p", "object": "urn:o"}])
    assert result["success"] is False
    assert daemon.timeouts == [1]


@pytest.mark.parametrize("call", [
    lambda c: c.publish_finalized_assertion("my-ka", "cg1"),
    lambda c: c.promote_assertion("my-ka", "cg1"),
    lambda c: c.create_assertion("cg1", "my-ka", quads=[{"subject": "urn:s", "predicate": "urn:p", "object": "urn:o"}], also_share_swm=True),
])
def test_long_mutation_past_its_deadline_reports_outcome_unknown(client_module, call):
    daemon = _SlowDaemon(latency=60)
    client = _client_with(client_module, daemon)
    result = call(client)
    assert result["outcomeUnknown"] is True
    assert "dkg_knowledge_asset_history" in result["warning"]
    assert not client_module._client_result_failed(result)


def test_create_without_share_stays_in_read_class(client_module):
    daemon = _SlowDaemon(latency=0)
    client = _client_with(client_module, daemon)
    client.create_assertion("cg1", "my-ka", quads=[{"subject": "urn:s", "predicate": "urn:p", "object": "urn:o"}])
    assert daemon.timeouts == [1]


def test_long_mutation_that_never_connected_is_a_failure(client_module):
    # ConnectTimeout: the request never reached the daemon, so the outcome is known.
    daemon = _SlowDaemon(latency=0, connect_latency=5)
    client = _client_with(client_module, daemon)
    result = client.publish_finalized_assertion("my-ka", "cg1")
    assert result["success"] is False
    assert "outcomeUnknown" not in result


def test_import_file_uses_long_class_and_reports_outcome_unknown(client_module, tmp_path, monkeypatch):
    import requests

    source = tmp_path / "notes.md"
    source.write_text("# Notes", encoding="utf-8")
    daemon = _SlowDaemon(latency=5)
    monkeypatch.setattr(requests, "post", daemon.post)
    client = _client_with(client_module, daemon, import_roots=[str(tmp_path)])

    assert client.import_assertion_file("my-ka", "cg1", str(source)) == {"kaId": "7", "status": "confirmed"}
    assert daemon.timeouts == [(1, 10)]

    daemon.latency = 60
    result = client.import_assertion_file("my-ka", "cg1", str(source))
    assert result["outcomeUnknown"] is True
    assert "/api/knowledge-assets/my-ka/wm/import-file" in result["warning"]
