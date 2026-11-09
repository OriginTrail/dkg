"""Identity refresh, optional fields, and local configuration failures."""
import builtins
from pathlib import Path
from unittest.mock import Mock

import pytest


@pytest.mark.parametrize("identity,status,expected", [
    ({"agentAddress": "0xagent", "peerId": "peer"}, {}, "0xagent"),
    ({"peerId": "peer"}, {}, "peer"),
    ({}, {"peerId": "fallback"}, "fallback"),
    ([], [], None),
    ({"agentAddress": 1, "peerId": 2}, {"peerId": 3}, None),
])
def test_identity_prefers_agent_then_peer_then_status(client_module, hermes_host, monkeypatch, identity, status, expected):
    client = client_module.DKGClient()
    get = Mock(side_effect=[identity, status] if not isinstance(identity, dict) or not identity.get("peerId") or not isinstance(identity.get("peerId"), str) else [identity])
    monkeypatch.setattr(client, "_get", get)
    assert client._resolve_agent_address() == expected
    assert get.call_args_list[0].args == ("/api/agent/identity",)
    if expected == "0xagent":
        get.reset_mock()
        assert client._resolve_agent_address() == expected
        get.assert_not_called()


def test_peer_fallback_is_refreshed_when_agent_identity_becomes_available(client_module, hermes_host, monkeypatch):
    client = client_module.DKGClient()
    get = Mock(side_effect=[{"peerId": "peer"}, {"agentAddress": "0xagent"}])
    monkeypatch.setattr(client, "_get", get)
    assert client._resolve_agent_address() == "peer"
    assert client._resolve_agent_address() == "0xagent"
    assert get.call_count == 2


def test_import_roots_normalize_expand_and_skip_invalid_paths(client_module, hermes_host, monkeypatch, tmp_path):
    monkeypatch.setenv("DKG_HERMES_IMPORT_ROOTS", "~/docs: :/tmp/../tmp")
    client = client_module.DKGClient()
    assert client._import_roots == [(Path.home() / "docs").resolve(), Path("/tmp").resolve()]
    resolve = Path.resolve
    def fail_one(path, **kwargs):
        if str(path) == "/bad":
            raise OSError("cannot resolve")
        return resolve(path, **kwargs)
    monkeypatch.setattr(Path, "resolve", fail_one)
    assert client_module._parse_import_roots("/bad::/good") == [Path("/good").resolve()]
    explicit = client_module.DKGClient(import_roots=["", " /explicit "])
    assert len(explicit._import_roots) == 1


def test_auth_token_empty_unreadable_and_default_home(client_module, hermes_host, tmp_path, monkeypatch):
    monkeypatch.delenv("DKG_HOME")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    assert client_module._resolve_dkg_home() == tmp_path / ".dkg"
    home = tmp_path / "node"
    home.mkdir()
    token = home / "auth.token"
    token.write_text("# comments only\n \n")
    assert client_module._load_auth_token(str(home)) is None
    token.write_bytes(b"\xff")
    assert client_module._load_auth_token(str(home)) is None
    client = client_module.DKGClient(dkg_home=str(home))
    assert "Authorization" not in client._get_session().headers
    monkeypatch.setattr(client._session, "close", Mock(side_effect=OSError("close failure")))
    client.close()
    assert client._session is None


@pytest.mark.parametrize("text,expected", [
    ("bearerWITHOUTSPACE", "bearerWITHOUTSPACE"), ("Bearer @missing", "Bearer @missing"),
    ("BEARER\tsecret Bearer two", "BEARER [REDACTED] Bearer [REDACTED]"),
    ("Bearer ", "Bearer "), ("", ""),
])
def test_redaction_handles_malformed_and_multiple_authorization_values(client_module, text, expected):
    assert client_module.redact_text(text) == expected


def test_unavailable_requests_dependency_is_not_a_read_timeout(client_module, monkeypatch):
    original_import = builtins.__import__
    def without_requests(name, *args, **kwargs):
        if name == "requests.exceptions":
            raise ImportError("requests unavailable")
        return original_import(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", without_requests)
    assert client_module._is_read_timeout(TimeoutError()) is False


@pytest.mark.parametrize("method,kwargs,route", [
    ("resolve_import_artifact", {}, "/api/knowledge-assets/import-artifact/resolve"),
    ("read_import_artifact_markdown", {}, "/api/knowledge-assets/import-artifact/read-markdown"),
    ("write_semantic_enrichment", {"semantic_quads": []}, "/api/knowledge-assets/semantic-enrichment/write"),
])
def test_optional_artifact_fields_are_omitted_not_sent_as_empty(recording_client, method, kwargs, route):
    getattr(recording_client, method)("did:dkg:context-graph:team", **kwargs)
    assert recording_client.posts == [(route, {"contextGraphId": "team", **({"semanticQuads": []} if method == "write_semantic_enrichment" else {})})]


@pytest.mark.parametrize("method,args,kwargs,route,body", [
    ("create_assertion", ("team", "asset"), {"sub_graph_name": "sub"}, "/api/knowledge-assets", {"contextGraphId": "team", "name": "asset", "subGraphName": "sub"}),
    ("promote_assertion", ("asset", "team"), {"entities": "some"}, None, None),
    ("finalize_assertion", ("asset", "team"), {"layer": "vm"}, None, None),
    ("discard_assertion", ("asset", "team"), {}, "/api/knowledge-assets/asset/wm/discard", {"contextGraphId": "team"}),
    ("register_context_graph", ("team",), {}, "/api/context-graph/register", {"id": "team"}),
])
def test_client_defaults_and_invalid_legacy_modes(recording_client, method, args, kwargs, route, body):
    if route is None:
        with pytest.raises(ValueError):
            getattr(recording_client, method)(*args, **kwargs)
        assert recording_client.posts == []
    else:
        getattr(recording_client, method)(*args, **kwargs)
        assert recording_client.posts == [(route, body)]


def test_existing_asset_create_is_idempotent_but_other_rejections_survive(recording_client):
    recording_client.responder = lambda *_: {"success": False, "error": "already registered"}
    assert recording_client.create_assertion("did:dkg:context-graph:team", "asset") == {"success": True, "alreadyExists": True, "contextGraphId": "team", "name": "asset"}
    recording_client.responder = lambda *_: {"success": False, "error": "permission denied"}
    assert recording_client.create_assertion("team", "asset") == {"success": False, "error": "permission denied"}


@pytest.mark.parametrize("kwargs,error", [({"name": "!!!"}, "lowercase slug"), ({"name": "Valid", "access_policy": True}, "access_policy"), ({"name": "Valid", "access_policy": 3}, "access_policy")])
def test_invalid_context_graph_configuration_never_reaches_daemon(recording_client, kwargs, error):
    assert error in recording_client.create_context_graph(**kwargs)["error"]
    assert recording_client.posts == []


def test_store_turn_defaults_to_unique_id_but_honors_callers_idempotency(recording_client):
    recording_client.store_turn("session", "user", "assistant")
    recording_client.store_turn("session", "user", "assistant")
    first, second = [body for _, body in recording_client.posts]
    assert first["turnId"].startswith("session:") and first["turnId"] == first["idempotencyKey"]
    assert first["turnId"] != second["turnId"]
    assert "agentName" not in first
    recording_client.store_turn("session", "user", "assistant", turn_id="turn")
    assert recording_client.posts[-1][1]["idempotencyKey"] == "turn"
    recording_client.store_turn("session", "user", "assistant", turn_id="turn", idempotency_key="key", agent_name="alice")
    assert recording_client.posts[-1][1] == {"sessionId": "session", "turnId": "turn", "idempotencyKey": "key", "userMessage": "user", "assistantReply": "assistant", "source": "hermes-provider", "agentName": "alice"}


def test_lifecycle_optional_scope_and_registration_policy(recording_client, monkeypatch):
    recording_client.promote_assertion("asset", "team", sub_graph_name="sub")
    recording_client.finalize_assertion("asset", "team", sub_graph_name="sub")
    recording_client.register_context_graph("team", access_policy=0)
    assert recording_client.posts == [
        ("/api/knowledge-assets/asset/swm/share", {"contextGraphId": "team", "subGraphName": "sub"}),
        ("/api/knowledge-assets/asset/wm/finalize", {"contextGraphId": "team", "subGraphName": "sub"}),
        ("/api/context-graph/register", {"id": "team", "accessPolicy": 0}),
    ]
    get = Mock(return_value={"history": []})
    monkeypatch.setattr(recording_client, "_get", get)
    assert recording_client.assertion_history("asset", "team") == {"history": []}
    get.assert_called_once_with("/api/knowledge-assets/asset?contextGraphId=team")
