"""HTTP client for the DKG V10 daemon API.

Thin wrapper around requests that talks to the daemon at localhost:9200.
All methods catch exceptions and return {success: False, error: "..."} —
no exceptions leak to the agent.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

_DEFAULT_URL = "http://127.0.0.1:9200"
_TIMEOUT = 5  # seconds


def _load_auth_token() -> Optional[str]:
    """Try to load auth token from ~/.dkg/auth.token."""
    token_path = Path.home() / ".dkg" / "auth.token"
    if not token_path.exists():
        return None
    try:
        lines = token_path.read_text(encoding="utf-8").strip().splitlines()
        # Filter comment lines (may contain em dashes or other UTF-8)
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
            return {"success": False, "error": str(e)}

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
            return {"success": False, "error": str(e)}

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

    # -- Adapter registration --------------------------------------------------

    def register_adapter(self, adapter_id: str = "hermes", framework: str = "hermes-agent") -> Dict[str, Any]:
        """POST /api/register-adapter — tell daemon we're here."""
        return self._post("/api/register-adapter", {
            "id": adapter_id,
            "framework": framework,
        })

    # -- SPARQL query ----------------------------------------------------------

    def query(self, sparql: str, context_graph_id: Optional[str] = None) -> Dict[str, Any]:
        """POST /api/query — run SPARQL on local triple store."""
        payload: Dict[str, Any] = {"sparql": sparql}
        if context_graph_id:
            payload["contextGraphId"] = context_graph_id
        return self._post("/api/query", payload)

    # -- Assertions (Working Memory) -------------------------------------------

    def create_assertion(self, context_graph_id: str, agent_name: str, name: str = "hermes-memory") -> Dict[str, Any]:
        """POST /api/assertion/create — create a WM assertion for this agent."""
        return self._post("/api/assertion/create", {
            "contextGraphId": context_graph_id,
            "agent": agent_name,
            "name": name,
        })

    def write_assertion(self, assertion_id: str, content: str, content_type: str = "text/plain") -> Dict[str, Any]:
        """POST /api/assertion/{id}/write — write content to assertion."""
        return self._post(f"/api/assertion/{assertion_id}/write", {
            "content": content,
            "contentType": content_type,
        })

    def query_assertion(self, assertion_id: str, sparql: str) -> Dict[str, Any]:
        """POST /api/assertion/{id}/query — SPARQL within assertion scope."""
        return self._post(f"/api/assertion/{assertion_id}/query", {"sparql": sparql})

    def promote_assertion(self, assertion_id: str) -> Dict[str, Any]:
        """POST /api/assertion/{id}/promote — promote assertion to Verified Memory."""
        return self._post(f"/api/assertion/{assertion_id}/promote", {})

    # -- Shared Working Memory -------------------------------------------------

    def share(self, context_graph_id: str, content: str) -> Dict[str, Any]:
        """POST /api/shared-memory/write — write to SWM (team-visible)."""
        return self._post("/api/shared-memory/write", {
            "contextGraphId": context_graph_id,
            "content": content,
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

    def create_context_graph(self, name: str, description: str = "") -> Dict[str, Any]:
        """POST /api/context-graph/create — create a new context graph."""
        return self._post("/api/context-graph/create", {
            "name": name,
            "description": description,
        })

    # -- Hermes-specific routes (served by adapter-hermes on daemon) -----------

    def store_turn(self, session_id: str, user_content: str, assistant_content: str, agent_name: str = "") -> Dict[str, Any]:
        """POST /api/hermes/session-turn — persist turn + trigger entity extraction."""
        payload: Dict[str, Any] = {
            "sessionId": session_id,
            "user": user_content,
            "assistant": assistant_content,
        }
        if agent_name:
            payload["agentName"] = agent_name
        return self._post("/api/hermes/session-turn", payload)

    def end_session(self, session_id: str, turn_count: int = 0) -> Dict[str, Any]:
        """POST /api/hermes/session-end — finalize session."""
        return self._post("/api/hermes/session-end", {
            "sessionId": session_id,
            "turnCount": turn_count,
        })

    # -- Cleanup ---------------------------------------------------------------

    def close(self):
        """Close the HTTP session."""
        if self._session:
            try:
                self._session.close()
            except Exception:
                pass
            self._session = None
