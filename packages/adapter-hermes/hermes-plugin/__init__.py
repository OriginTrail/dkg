"""DKG memory plugin — MemoryProvider interface.

Uses DKG V10 Working Memory assertions as the PRIMARY persistent store
for all agent knowledge (facts, user profile, decisions, findings).
SQLite conversation history is kept as a non-graph backup.

When the daemon is unreachable, falls back to a local cache file
($HERMES_HOME/dkg_cache.json) and queues writes for sync on reconnect.

Config via $HERMES_HOME/dkg.json:
  daemon_url     — DKG daemon URL (default: http://127.0.0.1:9200)
  context_graph  — Context Graph name (default: hermes-memory)
  agent_name     — Agent identity (default: from hermes config)
"""

from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider
from tools.registry import tool_error

logger = logging.getLogger(__name__)

# Entry delimiter matching built-in memory format
_ENTRY_SEP = "\n\xA7\n"  # §


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def _load_config() -> dict:
    """Load config from $HERMES_HOME/dkg.json with env var overrides."""
    from hermes_constants import get_hermes_home

    config = {
        "daemon_url": os.environ.get("DKG_DAEMON_URL", "http://127.0.0.1:9200"),
        "context_graph": os.environ.get("DKG_CONTEXT_GRAPH", "hermes-memory"),
        "agent_name": os.environ.get("DKG_AGENT_NAME", ""),
    }

    config_path = get_hermes_home() / "dkg.json"
    if config_path.exists():
        try:
            file_cfg = json.loads(config_path.read_text(encoding="utf-8"))
            config.update({k: v for k, v in file_cfg.items()
                           if v is not None and v != ""})
        except Exception:
            pass

    return config


def _cache_path(agent_name: str = "") -> Path:
    from hermes_constants import get_hermes_home
    suffix = f"_{agent_name}" if agent_name else ""
    return get_hermes_home() / f"dkg_cache{suffix}.json"


def _load_cache(agent_name: str = "") -> dict:
    """Load offline cache scoped to agent."""
    cp = _cache_path(agent_name)
    if cp.exists():
        try:
            return json.loads(cp.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"memory": [], "user": [], "queued_writes": []}


def _save_cache(cache: dict, agent_name: str = "") -> None:
    """Write offline cache atomically, scoped to agent."""
    cp = _cache_path(agent_name)
    tmp = cp.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(cache, indent=2), encoding="utf-8")
        tmp.replace(cp)
    except Exception as e:
        logger.warning(f"[dkg] Failed to save cache: {e}")


# ---------------------------------------------------------------------------
# Tool schemas
# ---------------------------------------------------------------------------

DKG_MEMORY_SCHEMA = {
    "name": "dkg_memory",
    "description": (
        "Store persistent facts in your DKG knowledge graph. These persist "
        "across sessions and can be shared with other agents.\n\n"
        "Actions: add (new fact), replace (update existing), remove (delete).\n"
        "Targets: memory (agent notes) or user (user profile)."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["add", "replace", "remove"],
                "description": "What to do.",
            },
            "target": {
                "type": "string",
                "enum": ["memory", "user"],
                "description": "Which store (default: memory).",
            },
            "content": {
                "type": "string",
                "description": "The fact to store (add/replace) or identify (remove).",
            },
            "old_text": {
                "type": "string",
                "description": "For replace/remove: substring identifying the entry to change.",
            },
        },
        "required": ["action", "content"],
    },
}

DKG_QUERY_SCHEMA = {
    "name": "dkg_query",
    "description": (
        "Query the DKG knowledge graph using SPARQL. Returns structured "
        "results from your Working Memory, Shared Memory, or the full "
        "Context Graph."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "sparql": {
                "type": "string",
                "description": "SPARQL query string.",
            },
            "context_graph": {
                "type": "string",
                "description": "Context Graph to query (default: current project).",
            },
        },
        "required": ["sparql"],
    },
}

DKG_SHARE_SCHEMA = {
    "name": "dkg_share",
    "description": (
        "Share knowledge to Shared Working Memory — visible to all team "
        "members and agents in the Context Graph. Free, gossip-replicated."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": "Knowledge to share with the team.",
            },
            "context_graph": {
                "type": "string",
                "description": "Target Context Graph (default: current project).",
            },
        },
        "required": ["content"],
    },
}

DKG_PUBLISH_SCHEMA = {
    "name": "dkg_publish",
    "description": (
        "Publish Shared Working Memory to Verified Memory — chain-anchored, "
        "permanent, costs TRAC. Only use when knowledge is ready for "
        "permanent record."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph": {
                "type": "string",
                "description": "Context Graph to publish from (default: current project).",
            },
        },
        "required": [],
    },
}

DKG_STATUS_SCHEMA = {
    "name": "dkg_status",
    "description": "Check DKG node health, connected peers, and Context Graph status.",
    "parameters": {"type": "object", "properties": {}, "required": []},
}


# ---------------------------------------------------------------------------
# Provider
# ---------------------------------------------------------------------------

class DKGMemoryProvider(MemoryProvider):
    """DKG V10 memory provider — DKG Working Memory as primary store."""

    @property
    def name(self) -> str:
        return "dkg"

    def __init__(self):
        self._client = None
        self._config: dict = {}
        self._cache: dict = {}
        self._context_graph: str = ""
        self._assertion_id: str = ""
        self._session_id: str = ""
        self._agent_name: str = ""
        self._offline: bool = False
        self._lock = threading.Lock()
        self._turn_count: int = 0

    # -- Core lifecycle --------------------------------------------------------

    def is_available(self) -> bool:
        try:
            cfg = _load_config()
            return bool(cfg.get("daemon_url"))
        except Exception:
            return False

    def initialize(self, session_id: str, **kwargs) -> None:
        self._config = _load_config()
        self._session_id = session_id
        self._agent_name = (
            self._config.get("agent_name")
            or kwargs.get("agent_identity", "")
            or "hermes"
        )
        self._cache = _load_cache(self._agent_name)
        self._context_graph = self._config.get("context_graph", "hermes-memory")

        # Create HTTP client
        from plugins.memory.dkg.client import DKGClient
        self._client = DKGClient(
            base_url=self._config.get("daemon_url", "http://127.0.0.1:9200")
        )

        # Check daemon health
        if not self._client.health_check():
            logger.warning("[dkg] Daemon unreachable — starting in offline mode")
            self._offline = True
            return

        # Register adapter with daemon
        result = self._client.register_adapter("hermes", "hermes-agent")
        if result.get("success") is False:
            logger.warning(f"[dkg] Adapter registration failed: {result.get('error')}")

        # Create or resolve assertion for this agent's Working Memory
        result = self._client.create_assertion(
            self._context_graph, self._agent_name, "hermes-memory"
        )
        if result.get("assertionId"):
            self._assertion_id = result["assertionId"]
            logger.info(f"[dkg] Assertion ready: {self._assertion_id}")
        elif result.get("success") is False:
            logger.warning(f"[dkg] Assertion creation failed: {result.get('error')} — using direct query")

        # Flush any queued writes from previous offline session
        self._flush_queued_writes()

    def system_prompt_block(self) -> str:
        """Recall facts from DKG assertion for system prompt injection."""
        facts = self._recall_facts()
        if not facts:
            return (
                "DKG memory is connected but empty. Use dkg_memory to store facts, "
                "dkg_query to search, dkg_share to share with team, dkg_publish "
                "to publish on-chain."
            )

        memory_facts = [f for f in facts if f.get("target") == "memory"]
        user_facts = [f for f in facts if f.get("target") == "user"]

        blocks = []
        if memory_facts:
            entries = _ENTRY_SEP.join(f["content"] for f in memory_facts)
            blocks.append(
                f"{'=' * 50}\n"
                f"MEMORY [DKG Working Memory]\n"
                f"{'=' * 50}\n"
                f"{entries}"
            )
        if user_facts:
            entries = _ENTRY_SEP.join(f["content"] for f in user_facts)
            blocks.append(
                f"{'=' * 50}\n"
                f"USER PROFILE [DKG Working Memory]\n"
                f"{'=' * 50}\n"
                f"{entries}"
            )

        blocks.append(
            "DKG tools available: dkg_memory (store facts), dkg_query (SPARQL), "
            "dkg_share (share with team), dkg_publish (publish on-chain), "
            "dkg_status (node health)."
        )

        return "\n\n".join(blocks)

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            DKG_MEMORY_SCHEMA,
            DKG_QUERY_SCHEMA,
            DKG_SHARE_SCHEMA,
            DKG_PUBLISH_SCHEMA,
            DKG_STATUS_SCHEMA,
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        if tool_name == "dkg_memory":
            return self._handle_memory(args)
        elif tool_name == "dkg_query":
            return self._handle_query(args)
        elif tool_name == "dkg_share":
            return self._handle_share(args)
        elif tool_name == "dkg_publish":
            return self._handle_publish(args)
        elif tool_name == "dkg_status":
            return self._handle_status(args)
        return tool_error(f"Unknown DKG tool: {tool_name}")

    # -- Prefetch --------------------------------------------------------------

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        """Recall relevant context from DKG before each turn."""
        if self._offline or not self._client:
            return ""

        try:
            # Search within this agent's assertion only — prevents cross-agent contamination
            sparql = (
                f"SELECT ?s ?p ?o WHERE {{ "
                f"?s ?p ?o . "
                f"FILTER(ISLITERAL(?o) && CONTAINS(LCASE(STR(?o)), LCASE(\"{_escape_sparql(query)}\")))"
                f"}} LIMIT 10"
            )
            if self._assertion_id:
                result = self._client.query_assertion(self._assertion_id, sparql)
            else:
                result = self._client.query(sparql, self._context_graph)
            bindings = result.get("results", {}).get("bindings", [])
            if not bindings:
                return ""

            lines = []
            for b in bindings[:10]:
                s = b.get("s", {}).get("value", "?")
                p = b.get("p", {}).get("value", "?")
                o = b.get("o", {}).get("value", "?")
                lines.append(f"  {_short(s)} — {_short(p)} — {o}")

            return f"<dkg-context>\nRelevant knowledge from DKG:\n" + "\n".join(lines) + "\n</dkg-context>"
        except Exception as e:
            logger.debug(f"[dkg] Prefetch failed: {e}")
            return ""

    # -- Sync ------------------------------------------------------------------

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        """Send turn to daemon for entity extraction + persistence."""
        self._turn_count += 1
        if self._offline or not self._client:
            # Queue for later sync
            with self._lock:
                self._cache.setdefault("queued_writes", []).append({
                    "type": "turn",
                    "session_id": self._session_id,
                    "user": user_content[:2000],
                    "assistant": assistant_content[:2000],
                })
                _save_cache(self._cache, self._agent_name)
            return

        # Fire-and-forget in background thread
        agent_name = self._agent_name
        def _sync():
            try:
                self._client.store_turn(
                    self._session_id,
                    user_content[:2000],
                    assistant_content[:2000],
                    agent_name=agent_name,
                )
            except Exception as e:
                logger.debug(f"[dkg] sync_turn failed: {e}")

        threading.Thread(target=_sync, daemon=True).start()

    # -- Lifecycle hooks -------------------------------------------------------

    def on_memory_write(self, action: str, target: str, content: str) -> None:
        """Mirror built-in memory writes to DKG assertion."""
        # When user uses the built-in memory tool, mirror the write to DKG
        # so DKG stays as source of truth
        self._handle_memory({
            "action": action,
            "target": target,
            "content": content,
            "old_text": content if action == "remove" else "",
        })

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """Finalize session: flush state to DKG and update local cache."""
        if self._client and not self._offline:
            try:
                self._client.end_session(self._session_id, self._turn_count)
            except Exception as e:
                logger.debug(f"[dkg] end_session failed: {e}")

        # Snapshot current facts to local cache for offline fallback
        facts = self._recall_facts()
        if facts:
            with self._lock:
                self._cache["memory"] = [f for f in facts if f.get("target") == "memory"]
                self._cache["user"] = [f for f in facts if f.get("target") == "user"]
                _save_cache(self._cache, self._agent_name)

    def shutdown(self) -> None:
        """Close HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    # -- Config ----------------------------------------------------------------

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return [
            {
                "key": "daemon_url",
                "label": "DKG Daemon URL",
                "type": "string",
                "default": "http://127.0.0.1:9200",
                "help": "URL of your running DKG V10 node.",
            },
            {
                "key": "context_graph",
                "label": "Context Graph",
                "type": "string",
                "default": "hermes-memory",
                "help": "Name of the Context Graph for agent memory.",
            },
            {
                "key": "agent_name",
                "label": "Agent Name",
                "type": "string",
                "default": "",
                "help": "Agent identity (leave empty to use Hermes profile name).",
            },
        ]

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        config_path = Path(hermes_home) / "dkg.json"
        config_path.write_text(json.dumps(values, indent=2), encoding="utf-8")

    # -- Internal: memory operations -------------------------------------------

    def _handle_memory(self, args: Dict[str, Any]) -> str:
        action = args.get("action", "add")
        target = args.get("target", "memory")
        content = args.get("content", "")
        old_text = args.get("old_text", "")

        if not content:
            return tool_error("Content is required.")

        with self._lock:
            entries = list(self._cache.get(target, []))

            if action == "add":
                entries.append({"target": target, "content": content})
            elif action == "replace":
                found = False
                for i, e in enumerate(entries):
                    if old_text and old_text in e.get("content", ""):
                        entries[i] = {"target": target, "content": content}
                        found = True
                        break
                if not found:
                    entries.append({"target": target, "content": content})
            elif action == "remove":
                entries = [e for e in entries if content not in e.get("content", "")]

            self._cache[target] = entries
            _save_cache(self._cache, self._agent_name)

        # Write to DKG assertion if online
        if self._client and not self._offline:
            all_content = _ENTRY_SEP.join(e["content"] for e in entries)
            try:
                self._client.write_assertion(
                    self._assertion_id or "default",
                    f"[{target}]\n{all_content}",
                )
            except Exception as e:
                logger.debug(f"[dkg] Assertion write failed: {e}")
                self._cache.setdefault("queued_writes", []).append({
                    "type": "memory",
                    "action": action,
                    "target": target,
                    "content": content,
                })
                _save_cache(self._cache, self._agent_name)

        count = len(entries)
        return json.dumps({
            "success": True,
            "action": action,
            "target": target,
            "entries": count,
            "store": "dkg" if not self._offline else "local_cache",
        })

    def _handle_query(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline. Cannot run SPARQL queries.")
        sparql = args.get("sparql", "")
        if not sparql:
            return tool_error("SPARQL query is required.")
        cg = args.get("context_graph", self._context_graph)
        result = self._client.query(sparql, cg)
        return json.dumps(result)

    def _handle_share(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline. Cannot share to team.")
        content = args.get("content", "")
        if not content:
            return tool_error("Content is required.")
        cg = args.get("context_graph", self._context_graph)
        result = self._client.share(cg, content)
        return json.dumps(result)

    def _handle_publish(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline. Cannot publish to chain.")
        cg = args.get("context_graph", self._context_graph)
        result = self._client.publish(cg)
        return json.dumps(result)

    def _handle_status(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return json.dumps({
                "status": "offline",
                "daemon_url": self._config.get("daemon_url"),
                "cached_memory_entries": len(self._cache.get("memory", [])),
                "cached_user_entries": len(self._cache.get("user", [])),
                "queued_writes": len(self._cache.get("queued_writes", [])),
            })

        status = self._client.status()
        cg_list = self._client.list_context_graphs()
        return json.dumps({
            "status": "connected",
            "daemon_url": self._config.get("daemon_url"),
            "node": status,
            "context_graphs": cg_list,
            "assertion_id": self._assertion_id,
            "agent_name": self._agent_name,
            "session_id": self._session_id,
            "turn_count": self._turn_count,
        })

    # -- Internal: recall facts from DKG or cache ------------------------------

    def _recall_facts(self) -> List[Dict[str, Any]]:
        """Get all persistent facts from DKG assertion or cache."""
        if self._offline or not self._client:
            return self._cache.get("memory", []) + self._cache.get("user", [])

        if not self._assertion_id:
            return self._cache.get("memory", []) + self._cache.get("user", [])

        try:
            sparql = "SELECT ?content WHERE { ?s <urn:hermes:content> ?content }"
            result = self._client.query_assertion(self._assertion_id, sparql)
            bindings = result.get("results", {}).get("bindings", [])
            if bindings:
                facts = []
                for b in bindings:
                    content = b.get("content", {}).get("value", "")
                    if content.startswith("[user]"):
                        facts.append({"target": "user", "content": content[6:].strip()})
                    elif content.startswith("[memory]"):
                        facts.append({"target": "memory", "content": content[8:].strip()})
                    else:
                        facts.append({"target": "memory", "content": content})
                return facts
        except Exception as e:
            logger.debug(f"[dkg] Recall from assertion failed: {e}")

        return self._cache.get("memory", []) + self._cache.get("user", [])

    def _flush_queued_writes(self) -> None:
        """Flush any writes queued during offline period."""
        queued = self._cache.get("queued_writes", [])
        if not queued or self._offline:
            return

        logger.info(f"[dkg] Flushing {len(queued)} queued writes from offline period")
        for item in queued:
            try:
                if item.get("type") == "turn":
                    self._client.store_turn(
                        item["session_id"],
                        item.get("user", ""),
                        item.get("assistant", ""),
                    )
                elif item.get("type") == "memory":
                    self._handle_memory({
                        "action": item["action"],
                        "target": item["target"],
                        "content": item["content"],
                    })
            except Exception as e:
                logger.debug(f"[dkg] Failed to flush queued write: {e}")

        with self._lock:
            self._cache["queued_writes"] = []
            _save_cache(self._cache, self._agent_name)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _escape_sparql(text: str) -> str:
    """Escape text for use in SPARQL string literal."""
    return text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def _short(uri: str) -> str:
    """Shorten a URI for display."""
    if "#" in uri:
        return uri.split("#")[-1]
    if "/" in uri:
        return uri.split("/")[-1]
    return uri


# ---------------------------------------------------------------------------
# Plugin registration
# ---------------------------------------------------------------------------

def register(ctx) -> None:
    """Register DKG as a memory provider plugin."""
    ctx.register_memory_provider(DKGMemoryProvider())
