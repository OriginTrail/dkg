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
import hashlib
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
        "daemon_url": "http://127.0.0.1:9200",
        "context_graph": "hermes-memory",
        "agent_name": "",
        "publish_tool": "request-only",
        "allow_direct_publish": False,
    }

    config_path = get_hermes_home() / "dkg.json"
    if config_path.exists():
        try:
            file_cfg = json.loads(config_path.read_text(encoding="utf-8"))
            config.update({k: v for k, v in file_cfg.items()
                           if v is not None and v != ""})
            publish_guard = file_cfg.get("publish_guard")
            if isinstance(publish_guard, dict):
                exposure = publish_guard.get("defaultToolExposure") or publish_guard.get("default_tool_exposure")
                if exposure is not None:
                    config["publish_tool"] = exposure
                if publish_guard.get("allowDirectPublish") is not None:
                    config["allow_direct_publish"] = publish_guard.get("allowDirectPublish")
                elif publish_guard.get("allow_direct_publish") is not None:
                    config["allow_direct_publish"] = publish_guard.get("allow_direct_publish")
        except Exception:
            pass

    for env_name, config_key in (
        ("DKG_DAEMON_URL", "daemon_url"),
        ("DKG_CONTEXT_GRAPH", "context_graph"),
        ("DKG_AGENT_NAME", "agent_name"),
        ("DKG_PUBLISH_TOOL", "publish_tool"),
    ):
        env_value = os.environ.get(env_name)
        if env_value is not None and env_value != "":
            config[config_key] = env_value

    direct_publish_env = os.environ.get("DKG_ALLOW_DIRECT_PUBLISH")
    if direct_publish_env is not None and direct_publish_env != "":
        config["allow_direct_publish"] = direct_publish_env.lower() in ("1", "true", "yes")

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


def _stable_scope_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="ignore")).hexdigest()[:12]


def _session_segment(value: str) -> str:
    cleaned = []
    for char in value.strip():
        cleaned.append(char.lower() if char.isalnum() or char in "._-" else "-")
    segment = "-".join(part for part in "".join(cleaned).split("-") if part)
    return segment or _stable_scope_hash(value)


def _scoped_session_id(raw_session_id: str, config: Optional[dict] = None) -> str:
    """Scope Hermes session IDs by profile/home before DKG persistence."""
    session_id = str(raw_session_id or "default")
    if session_id.startswith("hermes:dkg:") or session_id.startswith("hermes:dkg-ui:"):
        return session_id

    from hermes_constants import get_hermes_home

    hermes_home = str(get_hermes_home())
    profile_name = ""
    if config:
        profile_name = str(config.get("profile_name") or "").strip()
    if not profile_name:
        profile_name = Path(hermes_home).name or "default"

    scope = f"profile-{_session_segment(profile_name)}:home-{_stable_scope_hash(hermes_home)}"
    return f"hermes:dkg:{scope}:{session_id}"


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
        "Publish knowledge to Verified Memory — chain-anchored, permanent, costs TRAC. "
        "Two modes:\n"
        "1. With quads: publish structured RDF triples directly (precise graph construction)\n"
        "2. Without quads: publish everything in Shared Working Memory\n\n"
        "Object values starting with http://, https://, urn:, or did: are treated as "
        "URIs. Everything else becomes a string literal automatically.\n"
        "Always call dkg_wallet_balances first to verify sufficient TRAC."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph": {
                "type": "string",
                "description": "Context Graph to publish to (default: current project).",
            },
            "quads": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "subject": {"type": "string", "description": "Subject URI (e.g. 'https://example.org/finding/001')"},
                        "predicate": {"type": "string", "description": "Predicate URI (e.g. 'https://schema.org/name')"},
                        "object": {"type": "string", "description": "Object — URI or literal (e.g. 'Warfarin interaction' or 'https://schema.org/MedicalEntity')"},
                    },
                    "required": ["subject", "predicate", "object"],
                },
                "description": "Array of RDF triples to publish. If omitted, publishes entire SWM.",
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

DKG_WALLET_SCHEMA = {
    "name": "dkg_wallet_balances",
    "description": (
        "Check TRAC and ETH balances for the node's operational wallets. "
        "Call this BEFORE using dkg_publish to verify you have enough TRAC "
        "to cover publishing costs. Returns per-wallet balances and chain info."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

DKG_FIND_AGENTS_SCHEMA = {
    "name": "dkg_find_agents",
    "description": (
        "Discover other DKG agents on the network. Returns agent names, peer IDs, "
        "frameworks, and available skills. Use this to find collaborators, check "
        "who's online, or locate agents with specific capabilities before sending "
        "messages or invoking skills."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "framework": {
                "type": "string",
                "description": "Filter by framework (e.g. 'OpenClaw', 'hermes-agent', 'ElizaOS').",
            },
            "skill_type": {
                "type": "string",
                "description": "Filter by skill URI to find agents offering a specific capability.",
            },
        },
        "required": [],
    },
}

DKG_SEND_MESSAGE_SCHEMA = {
    "name": "dkg_send_message",
    "description": (
        "Send an encrypted P2P message to another DKG agent by peer ID or name. "
        "Both agents must be online. Use dkg_find_agents first to discover peer IDs. "
        "Messages are end-to-end encrypted and routed through the DKG network."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "peer_id": {
                "type": "string",
                "description": "Recipient peer ID (starts with 12D3KooW...) or agent name.",
            },
            "text": {
                "type": "string",
                "description": "Message text to send.",
            },
        },
        "required": ["peer_id", "text"],
    },
}

DKG_READ_MESSAGES_SCHEMA = {
    "name": "dkg_read_messages",
    "description": (
        "Read P2P messages from other DKG agents. Returns both sent and received "
        "messages. Filter by peer to see conversation with a specific agent."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "peer": {
                "type": "string",
                "description": "Filter by peer ID or agent name (optional).",
            },
            "limit": {
                "type": "integer",
                "description": "Max messages to return (default: 50).",
            },
        },
        "required": [],
    },
}

DKG_INVOKE_SKILL_SCHEMA = {
    "name": "dkg_invoke_skill",
    "description": (
        "Invoke a skill on a remote DKG agent. The remote agent executes the "
        "skill and returns the result. Use dkg_find_agents with skill_type first "
        "to discover which agents offer the skill you need."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "peer_id": {
                "type": "string",
                "description": "Target agent peer ID or name.",
            },
            "skill_uri": {
                "type": "string",
                "description": "Skill URI to invoke (e.g. 'ImageAnalysis').",
            },
            "input": {
                "type": "string",
                "description": "Input data for the skill as text.",
            },
        },
        "required": ["peer_id", "skill_uri", "input"],
    },
}

DKG_SUBSCRIBE_SCHEMA = {
    "name": "dkg_subscribe",
    "description": (
        "Subscribe to a Context Graph to receive its data and updates from the "
        "network. After subscribing, the node syncs data from peers in the "
        "background. Use dkg_status to check sync progress."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {
                "type": "string",
                "description": "Context Graph ID to subscribe to (e.g. 'pharma-research').",
            },
        },
        "required": ["context_graph_id"],
    },
}

DKG_CREATE_CONTEXT_GRAPH_SCHEMA = {
    "name": "dkg_context_graph_create",
    "description": (
        "Create a new Context Graph — a bounded knowledge space for a project "
        "or team. Context Graphs organize knowledge into Working Memory, "
        "Shared Memory, and Verified Memory layers. Use dkg_status first to "
        "check if the Context Graph already exists."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Human-readable name (e.g. 'Pharma Drug Interactions').",
            },
            "description": {
                "type": "string",
                "description": "What this Context Graph is for.",
            },
        },
        "required": ["name"],
    },
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
        self._session_id = _scoped_session_id(session_id, self._config)
        self._agent_name = (
            self._config.get("agent_name")
            or kwargs.get("agent_identity", "")
            or "hermes"
        )
        self._cache = _load_cache(self._agent_name)
        self._context_graph = self._config.get("context_graph", "hermes-memory")

        # Create HTTP client
        from .client import DKGClient
        self._client = DKGClient(
            base_url=self._config.get("daemon_url", "http://127.0.0.1:9200")
        )

        # Check daemon health
        if not self._client.health_check():
            logger.warning("[dkg] Daemon unreachable — starting in offline mode")
            self._offline = True
            return

        # Create or resolve assertion for this agent's Working Memory
        result = self._client.create_assertion(
            self._context_graph, self._agent_name,
        )
        assertion_uri = result.get("assertionUri")
        if assertion_uri:
            self._assertion_id = self._agent_name
            logger.info(f"[dkg] Assertion ready: {assertion_uri}")
        elif result.get("success") is False:
            logger.warning(f"[dkg] Assertion creation failed: {result.get('error')} — using direct query")

        # Flush any queued writes from previous offline session
        self._flush_queued_writes()

        # Backlog import: if DKG assertion is empty and local MEMORY.md/USER.md
        # exist, import them so the agent doesn't start with blank memory.
        self._backlog_import_if_needed(kwargs.get("hermes_home", ""))

    def system_prompt_block(self) -> str:
        """Recall facts from DKG assertion for system prompt injection."""
        facts = self._recall_facts()
        if not facts:
            return (
                "DKG memory is connected but empty. Use dkg_memory to store facts, "
                "dkg_query to search, and dkg_share to share with team. "
                "Direct Verified Memory publish is guarded by the operator."
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
            "DKG TOOLS — Your node is connected to a Decentralized Knowledge Graph.\n"
            "\n"
            "MEMORY WORKFLOW:\n"
            "  dkg_memory — Store/update/remove persistent facts (your primary memory)\n"
            "  dkg_query — Search knowledge via SPARQL (fast, local)\n"
            "\n"
            "COLLABORATION WORKFLOW:\n"
            "  dkg_share — Share findings to Shared Working Memory (team-visible, free)\n"
            "  Direct Verified Memory publish is guarded and not a default model tool\n"
            "  dkg_wallet_balances — Check TRAC balance BEFORE publishing\n"
            "\n"
            "NETWORK & DISCOVERY:\n"
            "  dkg_find_agents — Discover other agents on the network\n"
            "  dkg_send_message — Send encrypted P2P message to another agent\n"
            "  dkg_read_messages — Read messages from other agents\n"
            "  dkg_invoke_skill — Call a remote agent's skill\n"
            "\n"
            "PROJECT MANAGEMENT:\n"
            "  dkg_context_graph_create — Create a new project/knowledge space\n"
            "  dkg_subscribe — Join an existing project on the network\n"
            "  dkg_status — Node health, peers, context graphs\n"
            "\n"
            "TRUST FLOW: Working Memory (local, free) → SHARE → Shared Memory "
            "(team, free) → PUBLISH → Verified Memory (chain, TRAC cost, permanent).\n"
            "Knowledge gains trust as it moves through layers. Only publish when "
            "findings are verified and ready for permanent record."
        )

        return "\n\n".join(blocks)

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        schemas = [
            DKG_MEMORY_SCHEMA,
            DKG_QUERY_SCHEMA,
            DKG_SHARE_SCHEMA,
            DKG_STATUS_SCHEMA,
            DKG_WALLET_SCHEMA,
            DKG_FIND_AGENTS_SCHEMA,
            DKG_SEND_MESSAGE_SCHEMA,
            DKG_READ_MESSAGES_SCHEMA,
            DKG_INVOKE_SKILL_SCHEMA,
            DKG_SUBSCRIBE_SCHEMA,
            DKG_CREATE_CONTEXT_GRAPH_SCHEMA,
        ]
        if self._direct_publish_allowed():
            schemas.insert(3, DKG_PUBLISH_SCHEMA)
        return schemas

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        handlers = {
            "dkg_memory": self._handle_memory,
            "dkg_query": self._handle_query,
            "dkg_share": self._handle_share,
            "dkg_publish": self._handle_publish,
            "dkg_status": self._handle_status,
            "dkg_wallet_balances": self._handle_wallet,
            "dkg_find_agents": self._handle_find_agents,
            "dkg_send_message": self._handle_send_message,
            "dkg_read_messages": self._handle_read_messages,
            "dkg_invoke_skill": self._handle_invoke_skill,
            "dkg_subscribe": self._handle_subscribe,
            "dkg_context_graph_create": self._handle_create_cg,
        }
        handler = handlers.get(tool_name)
        if handler:
            return handler(args)
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
                result = self._client.query_assertion(self._assertion_id, self._context_graph, sparql)
            else:
                result = self._client.query(sparql, self._context_graph)
            bindings = _extract_query_bindings(result)
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
        effective_session_id = _scoped_session_id(session_id or self._session_id, self._config)
        turn_sequence = self._next_turn_sequence(effective_session_id)
        turn_id = self._build_turn_id(effective_session_id, turn_sequence, user_content, assistant_content)
        idempotency_key = f"hermes:{turn_id}"
        if self._offline or not self._client:
            # Queue for later sync
            self._queue_turn(effective_session_id, turn_id, idempotency_key, user_content, assistant_content)
            return

        # Fire-and-forget in background thread
        agent_name = self._agent_name
        def _sync():
            try:
                result = self._client.store_turn(
                    effective_session_id,
                    user_content[:2000],
                    assistant_content[:2000],
                    agent_name=agent_name,
                    turn_id=turn_id,
                    idempotency_key=idempotency_key,
                )
                if _client_result_failed(result):
                    self._queue_turn(effective_session_id, turn_id, idempotency_key, user_content, assistant_content)
            except Exception as e:
                logger.debug(f"[dkg] sync_turn failed: {e}")
                self._queue_turn(effective_session_id, turn_id, idempotency_key, user_content, assistant_content)

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
        owned_values = dict(values)
        owned_values.setdefault("managedBy", "@origintrail-official/dkg-adapter-hermes")
        config_path.write_text(json.dumps(owned_values, indent=2) + "\n", encoding="utf-8")

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

        write_queued = False
        if not self._write_memory_target_to_assertion(target):
            write_queued = True
            self._cache.setdefault("queued_writes", []).append({
                "type": "memory",
                "action": action,
                "target": target,
                "content": content,
                "old_text": old_text,
            })
            _save_cache(self._cache, self._agent_name)

        count = len(entries)
        return json.dumps({
            "success": True,
            "action": action,
            "target": target,
            "entries": count,
            "store": "dkg" if not self._offline else "local_cache",
            "queued": write_queued,
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
        quads = [{
            "subject": f"urn:hermes:{self._agent_name}:shared",
            "predicate": "urn:hermes:sharedContent",
            "object": content,
        }]
        result = self._client.share(cg, quads)
        return json.dumps(result)

    def _handle_publish(self, args: Dict[str, Any]) -> str:
        if not self._direct_publish_allowed():
            return tool_error(
                "Direct DKG publish is disabled by the adapter publish guard. "
                "Use an operator-reviewed publish request or enable DKG_ALLOW_DIRECT_PUBLISH explicitly."
            )
        if self._offline:
            return tool_error("DKG daemon is offline. Cannot publish to chain.")
        cg = args.get("context_graph", self._context_graph)
        raw_quads = args.get("quads")

        if raw_quads and isinstance(raw_quads, list) and len(raw_quads) > 0:
            # Structured quad publishing — build daemon-format quads with URI auto-detect
            quads = []
            for q in raw_quads:
                obj_val = str(q.get("object", ""))
                # URIs pass through; everything else becomes a quoted literal
                if _is_uri(obj_val):
                    obj_out = obj_val
                else:
                    obj_out = '"' + obj_val.replace("\\", "\\\\").replace('"', '\\"') + '"'
                quads.append({
                    "subject": str(q.get("subject", "")),
                    "predicate": str(q.get("predicate", "")),
                    "object": obj_out,
                    "graph": str(q.get("graph", "")),
                })
            share_result = self._client.share(cg, quads)
            if share_result.get("success") is False:
                return json.dumps(share_result)
            result = self._client.publish(cg)
            result["quadsPublished"] = len(quads)
            return json.dumps(result)
        else:
            # Publish entire SWM
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

    # -- Handlers: network & discovery -----------------------------------------

    def _handle_wallet(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline.")
        return json.dumps(self._client._get("/api/wallets/balances"))

    def _handle_find_agents(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline. Cannot discover agents.")
        params = {}
        if args.get("framework"):
            params["framework"] = args["framework"]
        if args.get("skill_type"):
            params["skill_type"] = args["skill_type"]
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        path = f"/api/agents?{qs}" if qs else "/api/agents"
        return json.dumps(self._client._get(path))

    def _handle_send_message(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline. Cannot send messages.")
        peer_id = args.get("peer_id", "")
        text = args.get("text", "")
        if not peer_id or not text:
            return tool_error("Both peer_id and text are required.")
        return json.dumps(self._client._post("/api/chat", {
            "peerId": peer_id,
            "text": text,
        }))

    def _handle_read_messages(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline. Cannot read messages.")
        params = {}
        if args.get("peer"):
            params["peer"] = args["peer"]
        if args.get("limit"):
            params["limit"] = str(args["limit"])
        qs = "&".join(f"{k}={v}" for k, v in params.items())
        path = f"/api/messages?{qs}" if qs else "/api/messages"
        return json.dumps(self._client._get(path))

    def _handle_invoke_skill(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline. Cannot invoke remote skills.")
        peer_id = args.get("peer_id", "")
        skill_uri = args.get("skill_uri", "")
        input_data = args.get("input", "")
        if not peer_id or not skill_uri:
            return tool_error("peer_id and skill_uri are required.")
        return json.dumps(self._client._post("/api/invoke-skill", {
            "peerId": peer_id,
            "skillUri": skill_uri,
            "input": input_data,
        }))

    def _handle_subscribe(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline. Cannot subscribe.")
        cg_id = args.get("context_graph_id", "")
        if not cg_id:
            return tool_error("context_graph_id is required.")
        return json.dumps(self._client._post("/api/context-graph/subscribe", {
            "contextGraphId": cg_id,
        }))

    def _handle_create_cg(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline. Cannot create Context Graph.")
        name = args.get("name", "").strip()
        if not name:
            return tool_error("name is required.")
        description = args.get("description", "")
        result = self._client.create_context_graph(name, description)
        return json.dumps(result)

    # -- Internal: backlog import ----------------------------------------------

    def _backlog_import_if_needed(self, hermes_home: str) -> None:
        """On first activation, import existing MEMORY.md + USER.md into DKG."""
        if self._offline or not self._client:
            return

        # Check if assertion already has content (not first activation)
        existing = self._recall_facts()
        if existing:
            return

        # Look for existing memory files to import
        if not hermes_home:
            return

        memories_dir = Path(hermes_home) / "memories"
        imported = 0

        for filename in ["MEMORY.md", "USER.md"]:
            filepath = memories_dir / filename
            if not filepath.exists():
                continue
            try:
                content = filepath.read_text(encoding="utf-8").strip()
                if not content:
                    continue

                target = "user" if filename == "USER.md" else "memory"
                # Split by § delimiter (same as built-in memory format)
                entries = [e.strip() for e in content.split("\n\xA7\n") if e.strip()]

                for entry in entries:
                    self._handle_memory({
                        "action": "add",
                        "target": target,
                        "content": entry,
                    })
                    imported += 1

                logger.info(f"[dkg] Backlog import: {len(entries)} entries from {filename}")
            except Exception as e:
                logger.warning(f"[dkg] Backlog import failed for {filename}: {e}")

        if imported > 0:
            logger.info(f"[dkg] Backlog import complete: {imported} entries imported from existing memory files")

    # -- Internal: recall facts from DKG or cache ------------------------------

    def _recall_facts(self) -> List[Dict[str, Any]]:
        """Get all persistent facts from DKG assertion or cache."""
        if self._offline or not self._client:
            return self._cache.get("memory", []) + self._cache.get("user", [])

        if not self._assertion_id:
            return self._cache.get("memory", []) + self._cache.get("user", [])

        try:
            result = self._client.query_assertion(self._assertion_id, self._context_graph)
            quads = [
                quad for quad in _extract_quads(result)
                if _quad_predicate(quad) == "urn:hermes:content"
            ]
            if quads:
                facts = []
                for quad in quads:
                    content = _quad_object(quad)
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
        """Flush any writes queued during offline period. Only removes items that succeeded."""
        queued = list(self._cache.get("queued_writes", []))
        if not queued or self._offline:
            return

        logger.info(f"[dkg] Flushing {len(queued)} queued writes from offline period")
        failed: list = []
        for item in queued:
            try:
                if item.get("type") == "turn":
                    result = self._client.store_turn(
                        item["session_id"],
                        item.get("user", ""),
                        item.get("assistant", ""),
                        agent_name=self._agent_name,
                        turn_id=item.get("turn_id", ""),
                        idempotency_key=item.get("idempotency_key", ""),
                    )
                    if _client_result_failed(result):
                        failed.append(item)
                elif item.get("type") == "memory":
                    target = item.get("target", "memory")
                    if not self._write_memory_target_to_assertion(target):
                        failed.append(item)
            except Exception as e:
                logger.debug(f"[dkg] Failed to flush queued write: {e}")
                failed.append(item)

        with self._lock:
            self._cache["queued_writes"] = failed
            _save_cache(self._cache, self._agent_name)

    def _write_memory_target_to_assertion(self, target: str) -> bool:
        if not (self._client and not self._offline and self._assertion_id):
            return False

        entries = list(self._cache.get(target, []))
        quads = []
        for e in entries:
            quads.append({
                "subject": f"urn:hermes:{self._agent_name}:{target}",
                "predicate": "urn:hermes:content",
                "object": f"[{e.get('target', target)}]\n{e['content']}",
            })
        try:
            result = self._client.write_assertion(
                self._assertion_id,
                self._context_graph,
                quads,
            )
            if _client_result_failed(result):
                raise RuntimeError(result.get("error", "DKG assertion write failed"))
            return True
        except Exception as e:
            logger.debug(f"[dkg] Assertion write failed: {e}")
            return False

    def _direct_publish_allowed(self) -> bool:
        allow = self._config.get("allow_direct_publish")
        return (
            allow is True
            or str(allow).lower() in ("1", "true", "yes")
            or str(self._config.get("publish_tool", "")).lower() == "direct"
        )

    def _next_turn_sequence(self, session_id: str) -> int:
        with self._lock:
            raw_sequences = self._cache.setdefault("turn_sequences", {})
            if not isinstance(raw_sequences, dict):
                raw_sequences = {}
                self._cache["turn_sequences"] = raw_sequences
            try:
                current = int(raw_sequences.get(session_id, 0))
            except Exception:
                current = 0
            next_sequence = current + 1
            raw_sequences[session_id] = next_sequence
            self._turn_count = max(self._turn_count, next_sequence)
            _save_cache(self._cache, self._agent_name)
            return next_sequence

    def _build_turn_id(self, session_id: str, turn_sequence: int, user_content: str, assistant_content: str) -> str:
        digest = hashlib.sha256()
        digest.update(session_id.encode("utf-8", errors="ignore"))
        digest.update(b"\0")
        digest.update(str(turn_sequence).encode("ascii"))
        digest.update(b"\0")
        digest.update(user_content[:2000].encode("utf-8", errors="ignore"))
        digest.update(b"\0")
        digest.update(assistant_content[:2000].encode("utf-8", errors="ignore"))
        return f"{session_id}:{turn_sequence}:{digest.hexdigest()[:16]}"

    def _queue_turn(
        self,
        session_id: str,
        turn_id: str,
        idempotency_key: str,
        user_content: str,
        assistant_content: str,
    ) -> None:
        queued = {
            "type": "turn",
            "session_id": session_id,
            "turn_id": turn_id,
            "idempotency_key": idempotency_key,
            "user": user_content[:2000],
            "assistant": assistant_content[:2000],
        }
        with self._lock:
            existing = self._cache.setdefault("queued_writes", [])
            if not any(item.get("type") == "turn" and item.get("idempotency_key") == idempotency_key for item in existing):
                existing.append(queued)
            _save_cache(self._cache, self._agent_name)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_uri(value: str) -> bool:
    """Check if a value looks like a URI."""
    return bool(value) and any(value.startswith(p) for p in ("http://", "https://", "urn:", "did:"))


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


def _client_result_failed(result: Any) -> bool:
    if not isinstance(result, dict):
        return False
    return result.get("success") is False or result.get("ok") is False or bool(result.get("error"))


def _extract_quads(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    query_result = result.get("result", {}) if isinstance(result.get("result"), dict) else {}
    quads = result.get("quads", []) or query_result.get("quads", [])
    return [quad for quad in quads if isinstance(quad, dict)]


def _extract_query_bindings(result: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not isinstance(result, dict):
        return []
    if isinstance(result.get("result"), dict):
        bindings = result["result"].get("bindings", [])
    elif isinstance(result.get("results"), dict):
        bindings = result["results"].get("bindings", [])
    else:
        bindings = result.get("bindings", [])
    return [binding for binding in bindings if isinstance(binding, dict)]


def _quad_subject(quad: Dict[str, Any]) -> str:
    return _term_value(quad.get("subject") or quad.get("s"))


def _quad_predicate(quad: Dict[str, Any]) -> str:
    return _term_value(quad.get("predicate") or quad.get("p"))


def _quad_object(quad: Dict[str, Any]) -> str:
    return _term_value(quad.get("object") or quad.get("o"))


def _term_value(term: Any) -> str:
    if isinstance(term, dict):
        value = term.get("value") or term.get("id") or term.get("term") or ""
    else:
        value = term
    text = str(value or "")
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        text = text[1:-1]
    return text.replace('\\"', '"').replace("\\n", "\n")


# ---------------------------------------------------------------------------
# Plugin registration
# ---------------------------------------------------------------------------

def register(ctx) -> None:
    """Register DKG as a memory provider plugin."""
    ctx.register_memory_provider(DKGMemoryProvider())
