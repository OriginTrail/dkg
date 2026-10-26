"""Import policy and file ownership checks using actual temporary filesystem paths."""

from unittest.mock import Mock

import pytest
import requests


@pytest.fixture
def isolated_env(monkeypatch):
    for name in ["DKG_API_TOKEN", "DKG_AUTH_TOKEN", "DKG_HERMES_IMPORT_ROOTS",
                 "HERMES_DKG_IMPORT_ROOTS", "DKG_IMPORT_ROOTS"]:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def safe_client(client_module, tmp_path, isolated_env):
    root = tmp_path / "safe"
    root.mkdir()
    client = client_module.DKGClient(import_roots=[str(root)], dkg_home=str(tmp_path / "home"))
    try:
        yield client, root
    finally:
        client.close()


@pytest.fixture
def forbidden_upload(monkeypatch):
    upload = Mock(side_effect=AssertionError("Rejected file reached the HTTP boundary"))
    monkeypatch.setattr(requests, "post", upload)
    return upload


@pytest.mark.parametrize("relative", [".env", ".ENV.local", "id_rsa", "wallet.json", "my-credentials.txt",
                                      "agent-keystore.json", "service-secret.txt", ".ssh/notes.txt", ".dkg/notes.txt"])
def test_sensitive_files_are_blocked_even_inside_an_allowed_root(safe_client, relative, forbidden_upload):
    client, root = safe_client
    source = root / relative
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"fixture")
    result = client.import_assertion_file("notes", "team", str(source))
    assert result == {"success": False, "error": "Refusing to import credentials, wallet, or DKG private state files."}
    forbidden_upload.assert_not_called()


@pytest.mark.parametrize("kind", ["missing", "directory", "outside", "sibling-prefix", "symlink-escape"])
def test_rejected_paths_never_reach_transport(safe_client, tmp_path, kind, forbidden_upload):
    client, root = safe_client
    if kind == "missing":
        source = root / "missing.txt"
    elif kind == "directory":
        source = root
    else:
        outside = tmp_path / ("safe-other" if kind == "sibling-prefix" else "outside") / "notes.txt"
        outside.parent.mkdir()
        outside.write_text("private fixture")
        source = outside
        if kind == "symlink-escape":
            source = root / "link.txt"
            source.symlink_to(outside)
    result = client.import_assertion_file("notes", "team", str(source))
    assert result["success"] is False
    assert ("File not found" if kind in ("missing", "directory") else "restricted to configured safe roots") in result["error"]
    forbidden_upload.assert_not_called()


def test_no_import_roots_is_deny_by_default(client_module, tmp_path, isolated_env, forbidden_upload):
    source = tmp_path / "notes.txt"
    source.write_text("safe text")
    client = client_module.DKGClient(import_roots=[], dkg_home=str(tmp_path / "home"))
    try:
        result = client.import_assertion_file("notes", "team", str(source))
        assert result["success"] is False
        assert "restricted to configured safe roots" in result["error"]
        forbidden_upload.assert_not_called()
    finally:
        client.close()


@pytest.mark.parametrize("size,allowed", [(8, True), (9, False)])
def test_import_size_limit_is_inclusive_and_files_close_after_upload(safe_client, client_module, monkeypatch, size, allowed):
    client, root = safe_client
    monkeypatch.setattr(client_module, "_MAX_IMPORT_FILE_BYTES", 8)
    source = root / "notes.md"
    source.write_bytes(b"x" * size)
    handles = []

    def post(url, **kwargs):
        name, handle, content_type = kwargs["files"]["file"]
        handles.append(handle)
        assert not handle.closed
        assert handle.read() == b"x" * size
        assert (name, content_type) == ("notes.md", "text/plain")
        assert kwargs["timeout"] == (30, 240)
        response = requests.Response()
        response.status_code = 200
        response._content = b'{"imported": true}'
        return response

    upload = Mock(side_effect=post)
    monkeypatch.setattr(requests, "post", upload)
    result = client.import_assertion_file("notes", "team", str(source), content_type="text/plain")
    if allowed:
        assert result == {"imported": True}
        upload.assert_called_once()
        assert handles[0].closed
    else:
        assert result == {"success": False, "error": "File is too large to import through the Hermes DKG tool."}
        upload.assert_not_called()


@pytest.mark.parametrize("exception,outcome_unknown", [
    (requests.exceptions.ReadTimeout, True),
    (requests.exceptions.ConnectTimeout, False),
    (requests.exceptions.ConnectionError, False),
])
def test_failed_upload_closes_file_and_distinguishes_unknown_outcomes(safe_client, monkeypatch, exception, outcome_unknown):
    client, root = safe_client
    source = root / "notes.txt"
    source.write_text("notes")
    client._token = "fixture-token"
    handles = []

    def fail(_url, **kwargs):
        handles.append(kwargs["files"]["file"][1])
        raise exception("transport failure using fixture-token")

    upload = Mock(side_effect=fail)
    monkeypatch.setattr(requests, "post", upload)
    result = client.import_assertion_file("notes", "team", str(source))
    upload.assert_called_once()
    assert handles[0].closed
    if outcome_unknown:
        assert result["outcomeUnknown"] is True
        assert "success" not in result and "error" not in result
        assert "Check dkg_knowledge_asset_history" in result["warning"]
        assert "before retrying" in result["warning"]
    else:
        assert result == {"success": False, "error": "transport failure using [REDACTED]"}


@pytest.mark.parametrize("primary,alias,expected", [(" primary ", "alias", "primary"), (None, " alias ", "alias"), (None, None, "file-token")])
def test_auth_precedence_and_token_file_comments(client_module, tmp_path, monkeypatch, isolated_env, primary, alias, expected):
    (tmp_path / "auth.token").write_text("# token metadata\n\n file-token \nignored\n")
    if primary is not None:
        monkeypatch.setenv("DKG_API_TOKEN", primary)
    if alias is not None:
        monkeypatch.setenv("DKG_AUTH_TOKEN", alias)
    client = client_module.DKGClient(dkg_home=str(tmp_path))
    try:
        assert client._get_session().headers["Authorization"] == f"Bearer {expected}"
    finally:
        client.close()


def test_missing_token_does_not_invent_an_authorization_header(client_module, tmp_path, isolated_env):
    client = client_module.DKGClient(dkg_home=str(tmp_path))
    try:
        assert "Authorization" not in client._get_session().headers
    finally:
        client.close()
