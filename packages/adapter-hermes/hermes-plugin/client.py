"""HTTP client for the DKG V10 daemon API.

Thin wrapper around requests that talks to the daemon at localhost:9200.
All methods catch exceptions and return {success: False, error: "..."} —
no exceptions leak to the agent.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import quote, urlencode

logger = logging.getLogger(__name__)

_DEFAULT_URL = "http://127.0.0.1:9200"
_TIMEOUT = 5  # seconds
_MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024
_CG_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
_BLOCKED_IMPORT_NAMES = {
    ".env",
    ".env.local",
    ".env.production",
    ".git-credentials",
    ".gitconfig",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "credentials",
    "auth.token",
    "agent-keystore.json",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
    "wallet.json",
}
_BLOCKED_IMPORT_DIRS = {
    ".aws",
    ".azure",
    ".dkg",
    ".gnupg",
    ".gcloud",
    ".kube",
    ".ssh",
}


def _parse_import_roots(value: Optional[str]) -> List[Path]:
    if not value:
        return []
    roots: List[Path] = []
    for raw in value.split(os.pathsep):
        item = raw.strip()
        if not item:
            continue
        try:
            root = Path(item).expanduser().resolve(strict=False)
        except Exception:
            continue
        roots.append(root)
    return roots


def _import_roots_env() -> Optional[str]:
    return (
        os.environ.get("DKG_HERMES_IMPORT_ROOTS")
        or os.environ.get("HERMES_DKG_IMPORT_ROOTS")
        or os.environ.get("DKG_IMPORT_ROOTS")
    )


def _path_is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def redact_text(value: str, token: Optional[str] = None) -> str:
    """Remove bearer tokens from text safe to show in logs/errors."""
    redacted = _redact_bearer_tokens(value)
    if token:
        redacted = redacted.replace(token, "[REDACTED]")
    return redacted


def _redact_bearer_tokens(value: str) -> str:
    lower = value.lower()
    parts = []
    cursor = 0
    while cursor < len(value):
        found = lower.find("bearer", cursor)
        if found < 0:
            parts.append(value[cursor:])
            break
        parts.append(value[cursor:found])
        parts.append(value[found:found + len("bearer")])
        next_index = found + len("bearer")
        whitespace_start = next_index
        while next_index < len(value) and value[next_index] in "\t\n\v\f\r ":
            next_index += 1
        if next_index == whitespace_start:
            cursor = next_index
            continue
        token_start = next_index
        while next_index < len(value) and _is_bearer_token_char(value[next_index]):
            next_index += 1
        if next_index == token_start:
            parts.append(value[whitespace_start:next_index])
        else:
            parts.append(" [REDACTED]")
        cursor = next_index
    return "".join(parts)


def _is_bearer_token_char(char: str) -> bool:
    return char.isascii() and (char.isalnum() or char in "._~+/=-")


def _looks_already_exists(message: Any) -> bool:
    lower = str(message or "").lower()
    return "already exists" in lower or "already exist" in lower or "already registered" in lower


def _is_blocked_import_path(path: Path) -> bool:
    name = path.name.lower()
    if name in _BLOCKED_IMPORT_NAMES:
        return True
    if "credential" in name or "keystore" in name or "secret" in name or "wallet" in name:
        return True
    parts = {part.lower() for part in path.parts}
    return bool(parts & _BLOCKED_IMPORT_DIRS)


def _slugify_context_graph_id(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def _resolve_dkg_home(dkg_home: Optional[str] = None) -> Path:
    """Resolve the DKG data directory: explicit config > $DKG_HOME > ~/.dkg."""
    if dkg_home:
        return Path(dkg_home).expanduser()
    env = os.environ.get("DKG_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".dkg"


def _load_auth_token(dkg_home: Optional[str] = None) -> Optional[str]:
    """Try to load auth token from explicit DKG home, $DKG_HOME, or ~/.dkg."""
    env_token = (os.environ.get("DKG_API_TOKEN") or os.environ.get("DKG_AUTH_TOKEN") or "").strip()
    if env_token:
        return env_token
    token_path = _resolve_dkg_home(dkg_home) / "auth.token"
    if not token_path.exists():
        return None
    try:
        lines = token_path.read_text(encoding="utf-8").strip().splitlines()
        token_lines = [l.strip() for l in lines if l.strip() and not l.strip().startswith("#")]
        return token_lines[0] if token_lines else None
    except Exception:
        return None


class DKGClient:
    """HTTP client for DKG V10 daemon."""

    def __init__(self, base_url: str = _DEFAULT_URL, timeout: int = _TIMEOUT,
                 import_roots: Optional[List[str]] = None,
                 dkg_home: Optional[str] = None):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._dkg_home = dkg_home
        self._token = _load_auth_token(dkg_home)
        self._session = None  # lazy
        self._agent_address: Optional[str] = None
        self._peer_id: Optional[str] = None
        self._agent_identity_loaded = False
        root_values = import_roots if import_roots is not None else _parse_import_roots(
            _import_roots_env()
        )
        self._import_roots = [
            Path(root).expanduser().resolve(strict=False)
            for root in root_values
            if str(root).strip()
        ]

    def _get_session(self):
        if self._session is None:
            import requests
            self._session = requests.Session()
            if self._token:
                self._session.headers["Authorization"] = f"Bearer {self._token}"
            self._session.headers["Content-Type"] = "application/json"
        return self._session

    def _get(self, path: str) -> Dict[str, Any]:
        try:
            r = self._get_session().get(f"{self.base_url}{path}", timeout=self.timeout)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            return {"success": False, "error": redact_text(str(e), self._token)}

    def _post(self, path: str, data: Dict[str, Any] = None) -> Dict[str, Any]:
        try:
            r = self._get_session().post(
                f"{self.base_url}{path}",
                data=json.dumps(data or {}),
                timeout=self.timeout,
            )
            r.raise_for_status()
            return r.json()
        except Exception as e:
            response = getattr(e, "response", None)
            if response is not None:
                try:
                    body = response.json()
                    if isinstance(body, dict):
                        body = dict(body)
                        body.setdefault("success", False)
                        if body.get("error") is not None:
                            body["error"] = redact_text(str(body.get("error")), self._token)
                        elif body.get("message") is not None:
                            body["error"] = redact_text(str(body.get("message")), self._token)
                        return body
                except Exception:
                    pass
                response_text = getattr(response, "text", "")
                if response_text:
                    return {"success": False, "error": redact_text(str(response_text), self._token)}
            return {"success": False, "error": redact_text(str(e), self._token)}

    # -- Health ----------------------------------------------------------------

    def health_check(self) -> bool:
        """Quick reachability check. No exceptions."""
        try:
            r = self._get_session().get(f"{self.base_url}/api/status", timeout=2)
            data = r.json()
            return bool(data.get("peerId") or data.get("ok"))
        except Exception:
            return False

    def status(self) -> Dict[str, Any]:
        """GET /api/status — node info, peers, sync."""
        return self._get("/api/status")

    def agent_identity(self) -> Dict[str, Any]:
        """GET /api/agent/identity — current local-agent identity."""
        return self._get("/api/agent/identity")

    def _resolve_agent_address(self) -> Optional[str]:
        if not self._agent_identity_loaded:
            identity = self.agent_identity()
            agent_address = identity.get("agentAddress") if isinstance(identity, dict) else None
            if isinstance(agent_address, str) and agent_address:
                self._agent_address = agent_address
            peer_id = identity.get("peerId") if isinstance(identity, dict) else None
            if isinstance(peer_id, str) and peer_id:
                self._peer_id = peer_id
            if not self._agent_address and not self._peer_id:
                status = self.status()
                status_peer_id = status.get("peerId") if isinstance(status, dict) else None
                if isinstance(status_peer_id, str) and status_peer_id:
                    self._peer_id = status_peer_id
            if self._agent_address:
                self._agent_identity_loaded = True
        if not self._agent_address and self._peer_id:
            return self._peer_id
        return self._agent_address

    # -- SPARQL query ----------------------------------------------------------

    def query(
        self,
        sparql: str,
        context_graph_id: Optional[str] = None,
        *,
        view: Optional[str] = None,
        assertion_name: Optional[str] = None,
        agent_address: Optional[str] = None,
        sub_graph_name: Optional[str] = None,
        verified_graph: Optional[str] = None,
        graph_suffix: Optional[str] = None,
        min_trust: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """POST /api/query — run SPARQL on local triple store."""
        payload: Dict[str, Any] = {"sparql": sparql}
        if context_graph_id:
            payload["contextGraphId"] = context_graph_id
        if graph_suffix:
            payload["graphSuffix"] = graph_suffix
        if view:
            payload["view"] = view
        if assertion_name:
            payload["assertionName"] = assertion_name
        if agent_address:
            payload["agentAddress"] = agent_address
        if sub_graph_name:
            payload["subGraphName"] = sub_graph_name
        if verified_graph:
            payload["verifiedGraph"] = verified_graph
        if min_trust is not None:
            payload["minTrust"] = min_trust
        return self._post("/api/query", payload)

    # -- Assertions (Working Memory) -------------------------------------------

    def create_assertion(self, context_graph_id: str, name: str, sub_graph_name: Optional[str] = None) -> Dict[str, Any]:
        """POST /api/assertion/create — create a WM assertion. Returns { assertionUri }."""
        payload: Dict[str, Any] = {
            "contextGraphId": context_graph_id,
            "name": name,
        }
        if sub_graph_name:
            payload["subGraphName"] = sub_graph_name
        result = self._post("/api/assertion/create", payload)
        if isinstance(result, dict) and result.get("success") is False and _looks_already_exists(result.get("error")):
            return {
                "success": True,
                "alreadyExists": True,
                "contextGraphId": context_graph_id,
                "name": name,
            }
        return result

    def write_assertion(self, assertion_name: str, context_graph_id: str, quads: List[Dict[str, str]],
                        sub_graph_name: Optional[str] = None) -> Dict[str, Any]:
        """POST /api/assertion/{name}/write — write quads to the assertion graph."""
        payload: Dict[str, Any] = {
            "contextGraphId": context_graph_id,
            "quads": quads,
        }
        if sub_graph_name:
            payload["subGraphName"] = sub_graph_name
        return self._post(f"/api/assertion/{quote(assertion_name, safe='')}/write", payload)

    def query_assertion(self, assertion_name: str, context_graph_id: str, sparql: str = "",
                        sub_graph_name: Optional[str] = None) -> Dict[str, Any]:
        """Query an assertion scope.

        Returns assertion quads from ``/api/assertion/{name}/query``. When
        SPARQL is supplied, pass it as a hint for daemons that support
        assertion-local filtering; callers must tolerate full-assertion results
        from current daemons.
        """
        payload: Dict[str, Any] = {
            "contextGraphId": context_graph_id,
        }
        if sub_graph_name:
            payload["subGraphName"] = sub_graph_name
        if sparql and sparql.strip():
            payload["sparql"] = sparql
        return self._post(f"/api/assertion/{quote(assertion_name, safe='')}/query", payload)

    def resolve_import_artifact(
        self,
        context_graph_id: str,
        assertion_uri: Optional[str] = None,
        assertion_name: Optional[str] = None,
        file_hash: Optional[str] = None,
        sub_graph_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Resolve deterministic metadata for a completed imported attachment/assertion."""
        payload: Dict[str, Any] = {"contextGraphId": context_graph_id}
        if assertion_uri:
            payload["assertionUri"] = assertion_uri
        if assertion_name:
            payload["assertionName"] = assertion_name
        if file_hash:
            payload["fileHash"] = file_hash
        if sub_graph_name:
            payload["subGraphName"] = sub_graph_name
        return self._post("/api/assertion/import-artifact/resolve", payload)

    def read_import_artifact_markdown(
        self,
        context_graph_id: str,
        assertion_uri: Optional[str] = None,
        assertion_name: Optional[str] = None,
        file_hash: Optional[str] = None,
        sub_graph_name: Optional[str] = None,
        max_bytes: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Read Markdown for a completed imported attachment via daemon content-addressed storage."""
        payload: Dict[str, Any] = {"contextGraphId": context_graph_id}
        if assertion_uri:
            payload["assertionUri"] = assertion_uri
        if assertion_name:
            payload["assertionName"] = assertion_name
        if file_hash:
            payload["fileHash"] = file_hash
        if sub_graph_name:
            payload["subGraphName"] = sub_graph_name
        if max_bytes is not None:
            payload["maxBytes"] = max_bytes
        return self._post("/api/assertion/import-artifact/read-markdown", payload)

    def write_semantic_enrichment(
        self,
        context_graph_id: str,
        semantic_quads: List[Dict[str, str]],
        assertion_uri: Optional[str] = None,
        assertion_name: Optional[str] = None,
        file_hash: Optional[str] = None,
        generation_method: Optional[str] = None,
        agent_identity: Optional[str] = None,
        generated_at: Optional[str] = None,
        sub_graph_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Append model-derived triples to a completed imported assertion with provenance."""
        payload: Dict[str, Any] = {
            "contextGraphId": context_graph_id,
            "semanticQuads": semantic_quads,
        }
        if assertion_uri:
            payload["assertionUri"] = assertion_uri
        if assertion_name:
            payload["assertionName"] = assertion_name
        if file_hash:
            payload["fileHash"] = file_hash
        if generation_method:
            payload["generationMethod"] = generation_method
        if agent_identity:
            payload["agentIdentity"] = agent_identity
        if generated_at:
            payload["generatedAt"] = generated_at
        if sub_graph_name:
            payload["subGraphName"] = sub_graph_name
        return self._post("/api/assertion/semantic-enrichment/write", payload)

    def promote_assertion(self, assertion_name: str, context_graph_id: str,
                          entities: Optional[Any] = None,
                          sub_graph_name: Optional[str] = None) -> Dict[str, Any]:
        """POST /api/assertion/{name}/promote — promote assertion to SWM."""
        payload: Dict[str, Any] = {
            "contextGraphId": context_graph_id,
        }
        if entities is not None:
            payload["entities"] = entities
        if sub_graph_name:
            payload["subGraphName"] = sub_graph_name
        return self._post(f"/api/assertion/{quote(assertion_name, safe='')}/promote", payload)

    def discard_assertion(self, assertion_name: str, context_graph_id: str,
                          sub_graph_name: Optional[str] = None) -> Dict[str, Any]:
        """POST /api/assertion/{name}/discard — discard a WM assertion."""
        payload: Dict[str, Any] = {"contextGraphId": context_graph_id}
        if sub_graph_name:
            payload["subGraphName"] = sub_graph_name
        return self._post(f"/api/assertion/{quote(assertion_name, safe='')}/discard", payload)

    def assertion_history(self, assertion_name: str, context_graph_id: str,
                          agent_address: Optional[str] = None,
                          sub_graph_name: Optional[str] = None) -> Dict[str, Any]:
        """GET /api/assertion/{name}/history — read assertion lifecycle metadata."""
        params: Dict[str, str] = {"contextGraphId": context_graph_id}
        if agent_address:
            params["agentAddress"] = agent_address
        if sub_graph_name:
            params["subGraphName"] = sub_graph_name
        return self._get(f"/api/assertion/{quote(assertion_name, safe='')}/history?{urlencode(params)}")

    def import_assertion_file(
        self,
        assertion_name: str,
        context_graph_id: str,
        file_path: str,
        content_type: Optional[str] = None,
        ontology_ref: Optional[str] = None,
        sub_graph_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /api/assertion/{name}/import-file — upload a local document."""
        try:
            try:
                path = Path(file_path).expanduser().resolve(strict=True)
            except Exception:
                return {"success": False, "error": f"File not found: {file_path}"}
            if not path.is_file():
                return {"success": False, "error": f"File not found: {file_path}"}
            if not self._import_path_allowed(path):
                return {
                    "success": False,
                    "error": (
                        "File imports are restricted to configured safe roots. "
                        "Set DKG_HERMES_IMPORT_ROOTS or adapter import_roots to an approved directory."
                    ),
                }
            if _is_blocked_import_path(path):
                return {"success": False, "error": "Refusing to import credentials, wallet, or DKG private state files."}
            if path.stat().st_size > _MAX_IMPORT_FILE_BYTES:
                return {"success": False, "error": "File is too large to import through the Hermes DKG tool."}
            guessed_type = content_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
            data = {"contextGraphId": context_graph_id}
            if ontology_ref:
                data["ontologyRef"] = ontology_ref
            if sub_graph_name:
                data["subGraphName"] = sub_graph_name
            headers = {"Accept": "application/json"}
            if self._token:
                headers["Authorization"] = f"Bearer {self._token}"
            with path.open("rb") as fh:
                files = {"file": (path.name, fh, guessed_type)}
                import requests
                r = requests.post(
                    f"{self.base_url}/api/assertion/{quote(assertion_name, safe='')}/import-file",
                    data=data,
                    files=files,
                    headers=headers,
                    timeout=self.timeout,
                )
            r.raise_for_status()
            return r.json()
        except Exception as e:
            return {"success": False, "error": redact_text(str(e), self._token)}

    def _import_path_allowed(self, path: Path) -> bool:
        if not self._import_roots:
            return False
        return any(_path_is_relative_to(path, root) for root in self._import_roots)

    # -- Shared Working Memory -------------------------------------------------

    def share(self, context_graph_id: str, quads: List[Dict[str, str]],
              sub_graph_name: Optional[str] = None) -> Dict[str, Any]:
        """POST /api/shared-memory/write — write quads to SWM (team-visible)."""
        payload: Dict[str, Any] = {
            "contextGraphId": context_graph_id,
            "quads": quads,
        }
        if sub_graph_name:
            payload["subGraphName"] = sub_graph_name
        return self._post("/api/shared-memory/write", payload)

    def publish(self, context_graph_id: str, selection: Any = "all",
                clear_after: bool = True,
                sub_graph_name: Optional[str] = None) -> Dict[str, Any]:
        """POST /api/shared-memory/publish — publish SWM to Verified Memory (costs TRAC)."""
        payload: Dict[str, Any] = {
            "contextGraphId": context_graph_id,
            "selection": selection,
            "clearAfter": clear_after,
        }
        if sub_graph_name:
            payload["subGraphName"] = sub_graph_name
        return self._post("/api/shared-memory/publish", payload)

    # -- Context Graphs --------------------------------------------------------

    def list_context_graphs(self) -> Dict[str, Any]:
        """GET /api/context-graph/list — list subscribed context graphs."""
        return self._get("/api/context-graph/list")

    def create_context_graph(
        self,
        name: str,
        description: str = "",
        cg_id: Optional[str] = None,
        *,
        access_policy: Optional[int] = None,
        allowed_agents: Optional[list] = None,
    ) -> Dict[str, Any]:
        """POST /api/context-graph/create — create a new context graph.
        Daemon requires both `id` and `name`; auto-generates id from name if not given.

        `access_policy` and `allowed_agents` are forwarded to the daemon when
        provided. Pass `access_policy=1` for a curated/private CG; `None` lets
        the daemon resolve to its default (open). `allowed_agents` populates
        the allowlist atomically with creation.
        """
        if not cg_id:
            cg_id = _slugify_context_graph_id(name)
        if not _CG_ID_RE.match(cg_id):
            return {"success": False, "error": "Context graph id must be a lowercase slug using letters, numbers, and hyphens."}
        # Round 3 — `bool` is a subclass of `int` in Python, so plain
        # `isinstance(access_policy, int)` accepts `True` / `False` and the
        # body would carry JSON `true` / `false`. The daemon route at
        # `packages/cli/src/daemon/routes/context-graph.ts:455` checks
        # `typeof accessPolicy === 'number'`, which excludes JSON booleans —
        # the field would be silently dropped and the CG would resolve to
        # the daemon's default (public), the opposite of a programmatic
        # caller's intent. Use `type(... ) is int` to exclude bool, and
        # additionally restrict to the meaningful values {0, 1} since
        # other ints would be rejected by the agent layer anyway
        # (`LOCAL_ACCESS_OPEN = 0` / `LOCAL_ACCESS_CURATED = 1`).
        if access_policy is not None:
            if type(access_policy) is not int or access_policy not in (0, 1):
                return {
                    "success": False,
                    "error": (
                        "access_policy must be 0 (open) or 1 (curated). "
                        f"Got: {type(access_policy).__name__}={access_policy!r}."
                    ),
                }
        body: Dict[str, Any] = {
            "id": cg_id,
            "name": name,
            "description": description,
        }
        if access_policy is not None:
            body["accessPolicy"] = access_policy
        if isinstance(allowed_agents, list) and allowed_agents:
            body["allowedAgents"] = allowed_agents
        return self._post("/api/context-graph/create", body)

    def register_context_graph(self, context_graph_id: str, access_policy: Optional[int] = None) -> Dict[str, Any]:
        """POST /api/context-graph/register — register a local CG on-chain."""
        payload: Dict[str, Any] = {"id": context_graph_id}
        if access_policy is not None:
            payload["accessPolicy"] = access_policy
        return self._post("/api/context-graph/register", payload)

    def subscribe(self, context_graph_id: str, include_shared_memory: Optional[bool] = None) -> Dict[str, Any]:
        """POST /api/context-graph/subscribe — subscribe to a context graph."""
        payload: Dict[str, Any] = {"contextGraphId": context_graph_id}
        if include_shared_memory is not None:
            payload["includeSharedMemory"] = include_shared_memory
        return self._post("/api/context-graph/subscribe", payload)

    # -- Sub-graphs ------------------------------------------------------------

    def create_sub_graph(self, context_graph_id: str, sub_graph_name: str) -> Dict[str, Any]:
        """POST /api/sub-graph/create — create a named sub-graph."""
        return self._post("/api/sub-graph/create", {
            "contextGraphId": context_graph_id,
            "subGraphName": sub_graph_name,
        })

    def list_sub_graphs(self, context_graph_id: str) -> Dict[str, Any]:
        """GET /api/sub-graph/list — list named sub-graphs for a CG."""
        return self._get(f"/api/sub-graph/list?{urlencode({'contextGraphId': context_graph_id})}")

    # -- Context graph participants -------------------------------------------

    def invite_to_context_graph(self, context_graph_id: str, peer_id: str) -> Dict[str, Any]:
        return self._post("/api/context-graph/invite", {
            "contextGraphId": context_graph_id,
            "peerId": peer_id,
        })

    def add_participant(self, context_graph_id: str, agent_address: str) -> Dict[str, Any]:
        return self._post(f"/api/context-graph/{quote(context_graph_id, safe='')}/add-participant", {
            "agentAddress": agent_address,
        })

    def remove_participant(self, context_graph_id: str, agent_address: str) -> Dict[str, Any]:
        return self._post(f"/api/context-graph/{quote(context_graph_id, safe='')}/remove-participant", {
            "agentAddress": agent_address,
        })

    def list_participants(self, context_graph_id: str) -> Dict[str, Any]:
        return self._get(f"/api/context-graph/{quote(context_graph_id, safe='')}/participants")

    def list_join_requests(self, context_graph_id: str) -> Dict[str, Any]:
        return self._get(f"/api/context-graph/{quote(context_graph_id, safe='')}/join-requests")

    def approve_join_request(self, context_graph_id: str, agent_address: str) -> Dict[str, Any]:
        return self._post(f"/api/context-graph/{quote(context_graph_id, safe='')}/approve-join", {
            "agentAddress": agent_address,
        })

    def reject_join_request(self, context_graph_id: str, agent_address: str) -> Dict[str, Any]:
        return self._post(f"/api/context-graph/{quote(context_graph_id, safe='')}/reject-join", {
            "agentAddress": agent_address,
        })

    # -- Hermes-specific routes (served by adapter-hermes on daemon) -----------

    def store_turn(
        self,
        session_id: str,
        user_content: str,
        assistant_content: str,
        agent_name: str = "",
        turn_id: str = "",
        idempotency_key: str = "",
    ) -> Dict[str, Any]:
        """POST /api/hermes-channel/persist-turn — persist turn + trigger entity extraction."""
        fallback_key = idempotency_key or turn_id or f"{session_id}:{uuid.uuid4()}"
        payload: Dict[str, Any] = {
            "sessionId": session_id,
            "turnId": turn_id or fallback_key,
            "idempotencyKey": fallback_key,
            "userMessage": user_content,
            "assistantReply": assistant_content,
            "source": "hermes-provider",
        }
        if agent_name:
            payload["agentName"] = agent_name
        return self._post("/api/hermes-channel/persist-turn", payload)

    # -- Cleanup ---------------------------------------------------------------

    def close(self):
        """Close the HTTP session."""
        if self._session:
            try:
                self._session.close()
            except Exception:
                pass
            self._session = None
