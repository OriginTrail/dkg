"""Exercise requests itself against a loopback HTTP server, without a DKG daemon."""

import json
import threading
from collections import deque
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest
import requests


@pytest.fixture
def daemon():
    responses = deque()
    received = []

    class Handler(BaseHTTPRequestHandler):
        def respond(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            received.append(SimpleNamespace(method=self.command, path=self.path,
                                            headers=self.headers, body=body))
            status, content_type, payload = responses.popleft() if responses else (
                500, "text/plain", b"Unexpected extra request")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = respond
        do_POST = respond

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    worker.start()

    def reply(body, status=200, content_type="application/json"):
        payload = json.dumps(body).encode() if content_type == "application/json" else body.encode()
        responses.append((status, content_type, payload))

    try:
        yield SimpleNamespace(url=f"http://127.0.0.1:{server.server_port}", requests=received, reply=reply)
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)
        assert not worker.is_alive(), "test HTTP server failed to stop"


@pytest.fixture
def client(client_module, daemon, tmp_path, monkeypatch):
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    monkeypatch.setenv("no_proxy", "127.0.0.1")
    monkeypatch.delenv("DKG_API_TOKEN", raising=False)
    monkeypatch.delenv("DKG_AUTH_TOKEN", raising=False)
    home = tmp_path / "home"
    home.mkdir()
    (home / "auth.token").write_text("# generated fixture\n\n fixture-token \nignored-second-line\n")
    value = client_module.DKGClient(base_url=daemon.url + "/", dkg_home=str(home),
                                    import_roots=[str(tmp_path)], timeout=2)
    # Loopback tests must not inherit a developer's HTTP proxy settings.
    value._get_session().trust_env = False
    try:
        yield value
    finally:
        value.close()


def test_authenticated_json_query_preserves_scope_and_explicit_zero_trust(client, daemon):
    daemon.reply({"bindings": [{"label": "café"}]})
    result = client.query('SELECT ?label WHERE { ?s ?p "café" }', " did:dkg:context-graph:team ",
                          view="working-memory", assertion_name="notes", agent_address="peer-1",
                          sub_graph_name="research", verified_graph="urn:verified", min_trust=0)
    assert result == {"bindings": [{"label": "café"}]}
    assert len(daemon.requests) == 1
    request = daemon.requests[0]
    assert (request.method, request.path) == ("POST", "/api/query")
    assert request.headers["Authorization"] == "Bearer fixture-token"
    assert request.headers["Content-Type"] == "application/json"
    assert json.loads(request.body) == {
        "sparql": 'SELECT ?label WHERE { ?s ?p "café" }', "contextGraphId": "team",
        "view": "working-memory", "assertionName": "notes", "agentAddress": "peer-1",
        "subGraphName": "research", "verifiedGraph": "urn:verified", "minTrust": 0,
    }


def test_encoded_asset_name_and_publish_options_reach_the_wire(client, daemon):
    daemon.reply({"status": "confirmed", "kaId": "7"})
    result = client.publish_finalized_assertion("notes/one ?#é", "team", sub_graph_name="docs",
                                               options={"publishEpochs": 2, "clearSharedMemoryAfter": False})
    assert result == {"status": "confirmed", "kaId": "7"}
    request, = daemon.requests
    assert request.path == "/api/knowledge-assets/notes%2Fone%20%3F%23%C3%A9/vm/publish"
    assert json.loads(request.body) == {"contextGraphId": "team", "subGraphName": "docs",
                                        "options": {"publishEpochs": 2, "clearSharedMemoryAfter": False}}


@pytest.mark.parametrize("body,content_type,expected", [
    ({"error": "Denied Bearer fixture-token", "code": "DENIED", "retryable": False}, "application/json",
     {"success": False, "error": "Denied Bearer [REDACTED]", "code": "DENIED", "retryable": False}),
    ({"message": "draft already sealed", "code": "SEALED"}, "application/json",
     {"success": False, "message": "draft already sealed", "error": "draft already sealed", "code": "SEALED"}),
    ("proxy rejected fixture-token and Bearer another-secret", "text/plain",
     {"success": False, "error": "proxy rejected [REDACTED] and Bearer [REDACTED]"}),
    (["invalid envelope"], "application/json", {"success": False, "error": '["invalid envelope"]'}),
])
def test_http_rejections_preserve_diagnostics_without_throwing(client, daemon, body, content_type, expected):
    daemon.reply(body, status=409, content_type=content_type)
    assert client.publish_finalized_assertion("notes", "team") == expected
    assert len(daemon.requests) == 1  # A definite rejection is never automatically retried.


@pytest.mark.parametrize("method", ["status", "query"])
def test_invalid_json_success_response_is_a_failure_result(client, daemon, method):
    daemon.reply("not JSON", content_type="text/plain")
    result = client.status() if method == "status" else client.query("ASK {}")
    assert result["success"] is False
    assert result["error"]
    assert "outcomeUnknown" not in result
    assert len(daemon.requests) == 1


@pytest.mark.parametrize("body,expected", [({"peerId": "peer-1"}, True), ({"ok": True}, True), ({}, False)])
def test_health_uses_the_actual_status_response(client, daemon, body, expected):
    daemon.reply(body)
    assert client.health_check() is expected
    assert [(r.method, r.path) for r in daemon.requests] == [("GET", "/api/status")]


def test_get_http_rejection_is_not_returned_as_a_success_body(client, daemon):
    daemon.reply({"peerId": "should-not-be-used"}, status=503)
    result = client.status()
    assert result["success"] is False
    assert "503" in result["error"]
    assert "peerId" not in result


@pytest.mark.parametrize("extension,mime", [("md", "text/markdown"), ("ttl", "text/turtle"),
                                            ("jsonld", "application/ld+json"), ("unknownext", "application/octet-stream")])
def test_file_upload_sends_real_multipart_with_exact_bytes_and_scope(client, daemon, tmp_path, extension, mime):
    source = tmp_path / f"notes.{extension}"
    content = b"\x00\x01\xff UTF-8: caf\xc3\xa9\r\n"
    source.write_bytes(content)
    daemon.reply({"extraction": {"status": "completed", "tripleCount": 4}})
    assert client.import_assertion_file("a/b", "did:dkg:context-graph:team", str(source),
                                        ontology_ref="urn:ontology", sub_graph_name="docs") == {
        "extraction": {"status": "completed", "tripleCount": 4}}
    request, = daemon.requests
    assert request.path == "/api/knowledge-assets/a%2Fb/wm/import-file"
    assert request.headers["Authorization"] == "Bearer fixture-token"
    assert request.headers["Content-Type"].startswith("multipart/form-data; boundary=")
    message = BytesParser(policy=policy.default).parsebytes(
        f"Content-Type: {request.headers['Content-Type']}\r\nMIME-Version: 1.0\r\n\r\n".encode() + request.body)
    parts = {part.get_param("name", header="content-disposition"): part for part in message.iter_parts()}
    assert set(parts) == {"contextGraphId", "ontologyRef", "subGraphName", "file"}
    assert {name: parts[name].get_payload(decode=True).decode() for name in parts if name != "file"} == {
        "contextGraphId": "team", "ontologyRef": "urn:ontology", "subGraphName": "docs"}
    assert parts["file"].get_filename() == source.name
    assert parts["file"].get_content_type() == mime
    assert parts["file"].get_payload(decode=True) == content


def test_close_releases_session_and_allows_authenticated_reuse(client, daemon, monkeypatch):
    session = client._get_session()
    calls = []
    original_close = session.close

    def close():
        calls.append("closed")
        original_close()

    monkeypatch.setattr(session, "close", close)
    client.close()
    client.close()
    assert calls == ["closed"]
    assert client._session is None
    daemon.reply({"peerId": "peer-2"})
    replacement = client._get_session()
    replacement.trust_env = False
    assert replacement is not session
    assert client.status() == {"peerId": "peer-2"}
    assert daemon.requests[0].headers["Authorization"] == "Bearer fixture-token"


def test_transport_failure_redacts_the_configured_token(client, monkeypatch):
    def fail(*_args, **_kwargs):
        raise requests.exceptions.ConnectionError("could not connect using fixture-token")

    monkeypatch.setattr(client._get_session(), "get", fail)
    assert client.status() == {"success": False, "error": "could not connect using [REDACTED]"}


def test_health_malformed_body_returns_false(client, daemon):
    daemon.reply("bad JSON", content_type="text/plain")
    assert client.health_check() is False


@pytest.mark.parametrize("body,content_type", [({}, "application/json"), ("", "text/plain")])
def test_empty_http_error_body_remains_a_definite_failure(client, daemon, body, content_type):
    daemon.reply(body, status=503, content_type=content_type)
    result = client.query("ASK {}")
    assert result["success"] is False
    assert "outcomeUnknown" not in result
    if content_type == "text/plain":
        assert "503" in result["error"]
