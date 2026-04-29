"""HTTP client for the DKG V10 daemon API.

Thin wrapper around requests that talks to the daemon at localhost:9200.
All methods catch exceptions and return {success: False, error: "..."} —
no exceptions leak to the agent.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_DEFAULT_URL = "http://127.0.0.1:9200"
_TIMEOUT = 5  # seconds


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


def _resolve_dkg_home() -> Path:
    """Resolve the DKG data directory: $DKG_HOME > ~/.dkg."""
    env = os.environ.get("DKG_HOME")
    if env:
        return Path(env)
    return Path.home() / ".dkg"


def _load_auth_token() -> Optional[str]:
    """Try to load auth token from $DKG_HOME/auth.token (or ~/.dkg/auth.token)."""
    token_path = _resolve_dkg_home() / "auth.token"
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

    def __init__(self, base_url: str = _DEFAULT_URL, timeout: int = _TIMEOUT):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._token = _load_auth_token()
        self._session = None  # lazy
        self._agent_address: Optional[str] = None
        self._agent_identity_loaded = False

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
            self._agent_identity_loaded = True
            identity = self.agent_identity()
            agent_address = identity.get("agentAddress") if isinstance(identity, dict) else None
            if isinstance(agent_address, str) and agent_address:
                self._agent_address = agent_address
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
    ) -> Dict[str, Any]:
        """POST /api/query — run SPARQL on local triple store."""
        payload: Dict[str, Any] = {"sparql": sparql}
        if context_graph_id:
            payload["contextGraphId"] = context_graph_id
        if view:
            payload["view"] = view
        if assertion_name:
            payload["assertionName"] = assertion_name
        if agent_address:
            payload["agentAddress"] = agent_address
        if sub_graph_name:
            payload["subGraphName"] = sub_graph_name
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
        return self._post("/api/assertion/create", payload)

    def write_assertion(self, assertion_name: str, context_graph_id: str, quads: List[Dict[str, str]],
                        sub_graph_name: Optional[str] = None) -> Dict[str, Any]:
        """POST /api/assertion/{name}/write — write quads to the assertion graph."""
        payload: Dict[str, Any] = {
            "contextGraphId": context_graph_id,
            "quads": quads,
        }
        if sub_graph_name:
            payload["subGraphName"] = sub_graph_name
        return self._post(f"/api/assertion/{assertion_name}/write", payload)

    def query_assertion(self, assertion_name: str, context_graph_id: str, sparql: str = "") -> Dict[str, Any]:
        """Query an assertion scope.

        Without SPARQL, returns full assertion quads from
        ``/api/assertion/{name}/query``. With SPARQL, uses the scoped
        ``/api/query`` view path so filtering happens server-side.
        """
        if sparql and sparql.strip():
            return self.query(
                sparql,
                context_graph_id,
                view="working-memory",
                assertion_name=assertion_name,
                agent_address=self._resolve_agent_address(),
            )
        return self._post(f"/api/assertion/{assertion_name}/query", {
            "contextGraphId": context_graph_id,
        })

    def promote_assertion(self, assertion_name: str, context_graph_id: str) -> Dict[str, Any]:
        """POST /api/assertion/{name}/promote — promote assertion to SWM."""
        return self._post(f"/api/assertion/{assertion_name}/promote", {
            "contextGraphId": context_graph_id,
        })

    # -- Shared Working Memory -------------------------------------------------

    def share(self, context_graph_id: str, quads: List[Dict[str, str]]) -> Dict[str, Any]:
        """POST /api/shared-memory/write — write quads to SWM (team-visible)."""
        return self._post("/api/shared-memory/write", {
            "contextGraphId": context_graph_id,
            "quads": quads,
        })

    def publish(self, context_graph_id: str) -> Dict[str, Any]:
        """POST /api/shared-memory/publish — publish SWM to Verified Memory (costs TRAC)."""
        return self._post("/api/shared-memory/publish", {
            "contextGraphId": context_graph_id,
        })

    # -- Context Graphs --------------------------------------------------------

    def list_context_graphs(self) -> Dict[str, Any]:
        """GET /api/context-graph/list — list subscribed context graphs."""
        return self._get("/api/context-graph/list")

    def create_context_graph(self, name: str, description: str = "", cg_id: Optional[str] = None) -> Dict[str, Any]:
        """POST /api/context-graph/create — create a new context graph.
        Daemon requires both `id` and `name`; auto-generates id from name if not given."""
        if not cg_id:
            import time, random
            slug = name.lower().replace(" ", "-")
            slug = "".join(c for c in slug if c.isalnum() or c == "-")[:40]
            rand = random.randint(0, 0xFFFF)
            cg_id = f"cg:{slug}-{int(time.time()):x}{rand:04x}"
        return self._post("/api/context-graph/create", {
            "id": cg_id,
            "name": name,
            "description": description,
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
