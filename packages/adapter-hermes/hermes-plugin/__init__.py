"""DKG memory plugin — MemoryProvider interface.

Uses DKG V10 Working Memory assertions as the PRIMARY persistent store
for all agent knowledge (facts, user profile, decisions, findings).
SQLite conversation history is kept as a non-graph backup.

When the daemon is unreachable, falls back to a local cache file
($HERMES_HOME/dkg_cache.json) and queues writes for sync on reconnect.

Config via $HERMES_HOME/dkg.json:
  daemon_url     — DKG daemon URL (default: http://127.0.0.1:9200)
  context_graph  — Context Graph name (default: agent-context)
  agent_name     — Agent identity (default: from hermes config)
"""

from __future__ import annotations

import json
import logging
import os
import hashlib
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

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
        "context_graph": "agent-context",
        "memory_assertion": "memory",
        "agent_name": "",
        "publish_tool": "direct",
        "allow_direct_publish": True,
        "allow_context_graph_admin_tools": True,
        "import_roots": [],
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
            if file_cfg.get("allowContextGraphAdminTools") is not None:
                config["allow_context_graph_admin_tools"] = file_cfg.get("allowContextGraphAdminTools")
            elif file_cfg.get("allow_context_graph_admin_tools") is not None:
                config["allow_context_graph_admin_tools"] = file_cfg.get("allow_context_graph_admin_tools")
        except Exception:
            pass

    for env_name, config_key in (
        ("DKG_DAEMON_URL", "daemon_url"),
        ("DKG_CONTEXT_GRAPH", "context_graph"),
        ("DKG_MEMORY_ASSERTION", "memory_assertion"),
        ("DKG_AGENT_NAME", "agent_name"),
        ("DKG_PUBLISH_TOOL", "publish_tool"),
    ):
        env_value = os.environ.get(env_name)
        if env_value is not None and env_value != "":
            config[config_key] = env_value

    direct_publish_env = os.environ.get("DKG_ALLOW_DIRECT_PUBLISH")
    if direct_publish_env is not None and direct_publish_env != "":
        config["allow_direct_publish"] = direct_publish_env.lower() in ("1", "true", "yes")
    admin_tools_env = os.environ.get("DKG_ALLOW_CONTEXT_GRAPH_ADMIN_TOOLS")
    if admin_tools_env is not None and admin_tools_env != "":
        config["allow_context_graph_admin_tools"] = admin_tools_env.lower() in ("1", "true", "yes")
    import_roots_env = (
        os.environ.get("DKG_HERMES_IMPORT_ROOTS")
        or os.environ.get("HERMES_DKG_IMPORT_ROOTS")
        or os.environ.get("DKG_IMPORT_ROOTS")
    )
    if import_roots_env is not None and import_roots_env != "":
        config["import_roots"] = [root for root in import_roots_env.split(os.pathsep) if root.strip()]
    elif isinstance(config.get("import_roots"), str):
        config["import_roots"] = [root for root in config["import_roots"].split(os.pathsep) if root.strip()]
    elif not isinstance(config.get("import_roots"), list):
        config["import_roots"] = []

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


def _session_segment(value: str, max_length: int = 48) -> str:
    cleaned = []
    for char in value.strip():
        cleaned.append(char.lower() if char.isalnum() or char in "._-" else "-")
    segment = "-".join(part for part in "".join(cleaned).split("-") if part)
    if not segment:
        return _stable_scope_hash(value)
    if len(segment) <= max_length:
        return segment
    suffix = _stable_scope_hash(value)
    prefix = segment[: max(1, max_length - len(suffix) - 1)].rstrip("._-")
    return f"{prefix}-{suffix}"


def _scoped_session_id(raw_session_id: str, config: Optional[dict] = None) -> str:
    """Scope Hermes session IDs by profile/home before DKG persistence."""
    session_id = str(raw_session_id or "default")
    if session_id.startswith("hermes:dkg:") or session_id.startswith("hermes:dkg-ui:"):
        return session_id
    if len(session_id) > 48:
        session_id = _session_segment(session_id, 48)

    from hermes_constants import get_hermes_home

    hermes_home = str(get_hermes_home())
    profile_name = ""
    if config:
        profile_name = str(config.get("profile_name") or "").strip()
    if not profile_name:
        profile_name = Path(hermes_home).name or "default"

    scope = f"profile-{_session_segment(profile_name, 32)}:home-{_stable_scope_hash(hermes_home)}"
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
        "Query the DKG knowledge graph using SPARQL. Pass view to select "
        "Working Memory, Shared Working Memory, or Verified Memory."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "sparql": {
                "type": "string",
                "description": "SPARQL query string.",
            },
            "context_graph_id": {
                "type": "string",
                "description": "Context graph ID. Required when view is set.",
            },
            "view": {
                "type": "string",
                "description": (
                    "Optional layer: working-memory, shared-working-memory, or verified-memory. "
                    "When supplied, context_graph_id is required."
                ),
            },
            "agent_address": {
                "type": "string",
                "description": "Optional Working Memory owner address. Defaults to this node when view is working-memory.",
            },
            "assertion_name": {
                "type": "string",
                "description": "Optional assertion name scope.",
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
            "context_graph_id": {
                "type": "string",
                "description": "Target Context Graph ID.",
            },
            "sub_graph_name": {
                "type": "string",
                "description": "Optional sub-graph scope.",
            },
        },
        "required": ["content", "context_graph_id"],
    },
}

DKG_PUBLISH_SCHEMA = {
    "name": "dkg_publish",
    "description": (
        "One-shot write + publish helper: write supplied quads to Shared Working Memory, "
        "then publish SWM to Verified Memory. Chain-anchored, permanent, costs TRAC. "
        "Object values starting with http://, https://, urn:, or did: are treated as "
        "URIs. Everything else becomes a string literal automatically.\n"
        "Always call dkg_wallet_balances first to verify sufficient TRAC."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {
                "type": "string",
                "description": "Target context graph ID.",
            },
            "quads": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "subject": {"type": "string", "description": "Subject URI (e.g. 'https://example.org/finding/001')"},
                        "predicate": {"type": "string", "description": "Predicate URI (e.g. 'https://schema.org/name')"},
                        "object": {"type": "string", "description": "Object — URI or literal (e.g. 'Warfarin interaction' or 'https://schema.org/MedicalEntity')"},
                        "graph": {"type": "string", "description": "Optional named graph URI."},
                    },
                    "required": ["subject", "predicate", "object"],
                },
                "description": "Array of RDF triples to write and publish.",
            },
            "sub_graph_name": {"type": "string", "description": "Optional sub-graph scope."},
        },
        "required": ["context_graph_id", "quads"],
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
            "since": {
                "type": "string",
                "description": "Only messages after this Unix-ms timestamp.",
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
            "include_shared_memory": {
                "type": "boolean",
                "description": "When true, request a best-effort Shared Working Memory catch-up during subscription.",
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
        "check if the Context Graph already exists. "
        "Defaults to a curated/private context graph — the creator is "
        "auto-included in the allowlist and can immediately write to working "
        "and shared memory. Pass `public: true` for an open/discoverable "
        "context graph, or `allowed_agents` to invite collaborators "
        "atomically with creation."
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
            "id": {
                "type": "string",
                "description": "Optional context graph ID. Auto-generated from name when omitted.",
            },
            "public": {
                "type": "boolean",
                "description": (
                    "If true, creates an open/discoverable context graph "
                    "(anyone can subscribe and read). Default is false — the "
                    "context graph is curated/private and restricted to "
                    "allowed_agents (the creator is always auto-included)."
                ),
            },
            "allowed_agents": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Optional agent addresses (0x...) to add to the curation "
                    "allowlist at creation time. The creator's own address is "
                    "auto-added regardless. Ignored when public is true."
                ),
            },
        },
        "required": ["name"],
    },
}

DKG_LIST_CONTEXT_GRAPHS_SCHEMA = {
    "name": "dkg_list_context_graphs",
    "description": "List all context graphs known to the node, including subscription and sync state.",
    "parameters": {"type": "object", "properties": {}, "required": []},
}

QUAD_SCHEMA = {
    "type": "object",
    "properties": {
        "subject": {"type": "string", "description": "Subject URI."},
        "predicate": {"type": "string", "description": "Predicate URI."},
        "object": {"type": "string", "description": "Object URI or literal text."},
        "graph": {"type": "string", "description": "Optional graph name."},
    },
    "required": ["subject", "predicate", "object"],
}

DKG_ASSERTION_CREATE_SCHEMA = {
    "name": "dkg_assertion_create",
    "description": "Create a Working Memory assertion in a context graph.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Target context graph ID."},
            "name": {"type": "string", "description": "Assertion name."},
            "sub_graph_name": {"type": "string", "description": "Optional sub-graph name."},
        },
        "required": ["context_graph_id", "name"],
    },
}

DKG_ASSERTION_WRITE_SCHEMA = {
    "name": "dkg_assertion_write",
    "description": "Append quads to an existing Working Memory assertion.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Target context graph ID."},
            "name": {"type": "string", "description": "Assertion name."},
            "quads": {"type": "array", "items": QUAD_SCHEMA, "description": "RDF triples/quads to write."},
            "sub_graph_name": {"type": "string", "description": "Optional sub-graph name."},
        },
        "required": ["context_graph_id", "name", "quads"],
    },
}

DKG_ASSERTION_PROMOTE_SCHEMA = {
    "name": "dkg_assertion_promote",
    "description": "Promote a Working Memory assertion into Shared Working Memory.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Target context graph ID."},
            "name": {"type": "string", "description": "Assertion name."},
            "entities": {"type": "array", "items": {"type": "string"}, "description": "Optional root entity URI list."},
            "sub_graph_name": {"type": "string", "description": "Optional sub-graph name."},
        },
        "required": ["context_graph_id", "name"],
    },
}

DKG_ASSERTION_DISCARD_SCHEMA = {
    "name": "dkg_assertion_discard",
    "description": "Discard a Working Memory assertion without promoting it.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Target context graph ID."},
            "name": {"type": "string", "description": "Assertion name."},
            "sub_graph_name": {"type": "string", "description": "Optional sub-graph name."},
        },
        "required": ["context_graph_id", "name"],
    },
}

DKG_ASSERTION_IMPORT_FILE_SCHEMA = {
    "name": "dkg_assertion_import_file",
    "description": "Upload a local document from an operator-approved import root into a Working Memory assertion and run daemon extraction.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Target context graph ID."},
            "name": {"type": "string", "description": "Assertion name."},
            "file_path": {"type": "string", "description": "Local file path to upload. Must be under DKG_HERMES_IMPORT_ROOTS or adapter import_roots."},
            "content_type": {"type": "string", "description": "Optional MIME type override."},
            "ontology_ref": {"type": "string", "description": "Optional ontology reference."},
            "sub_graph_name": {"type": "string", "description": "Optional sub-graph name."},
        },
        "required": ["context_graph_id", "name", "file_path"],
    },
}

DKG_ASSERTION_QUERY_SCHEMA = {
    "name": "dkg_assertion_query",
    "description": "Dump every quad from one Working Memory assertion. Use dkg_query for SPARQL.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Target context graph ID."},
            "name": {"type": "string", "description": "Assertion name."},
            "sub_graph_name": {"type": "string", "description": "Optional sub-graph name."},
        },
        "required": ["context_graph_id", "name"],
    },
}

DKG_ASSERTION_HISTORY_SCHEMA = {
    "name": "dkg_assertion_history",
    "description": "Read an assertion lifecycle descriptor.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Target context graph ID."},
            "name": {"type": "string", "description": "Assertion name."},
            "agent_address": {"type": "string", "description": "Optional agent address for WM owner."},
            "sub_graph_name": {"type": "string", "description": "Optional sub-graph name."},
        },
        "required": ["context_graph_id", "name"],
    },
}

DKG_SHARED_MEMORY_PUBLISH_SCHEMA = {
    "name": "dkg_shared_memory_publish",
    "description": (
        "Publish existing Shared Working Memory to Verified Memory. "
        "Use after dkg_assertion_promote in the canonical write → promote → publish flow."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Target context graph ID."},
            "root_entities": {"type": "array", "items": {"type": "string"}, "description": "Optional subset of root entity URIs."},
            "clear_after": {"type": "boolean", "description": "Clear published SWM after publish."},
            "sub_graph_name": {"type": "string", "description": "Optional sub-graph name."},
            "register_if_needed": {"type": "boolean", "description": "Register a local CG before publishing."},
            "access_policy": {"type": "integer", "description": "Optional registration access policy: 0 open, 1 private."},
        },
        "required": ["context_graph_id"],
    },
}

DKG_SUB_GRAPH_CREATE_SCHEMA = {
    "name": "dkg_sub_graph_create",
    "description": "Create a named sub-graph inside a context graph.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Target context graph ID."},
            "sub_graph_name": {"type": "string", "description": "Sub-graph name."},
        },
        "required": ["context_graph_id", "sub_graph_name"],
    },
}

DKG_SUB_GRAPH_LIST_SCHEMA = {
    "name": "dkg_sub_graph_list",
    "description": "List sub-graphs in a context graph.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Target context graph ID."},
        },
        "required": ["context_graph_id"],
    },
}

MEMORY_SEARCH_SCHEMA = {
    "name": "memory_search",
    "description": (
        "Search DKG-backed memory by free text across Working Memory, Shared Working Memory, "
        "and Verified Memory. Prefer this over dkg_query for recall."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Free-text search query."},
            "limit": {"type": "integer", "description": "Max results, default 20, capped at 100."},
            "context_graph_id": {"type": "string", "description": "Optional context graph override."},
        },
        "required": ["query"],
    },
}

DKG_CONTEXT_GRAPH_INVITE_SCHEMA = {
    "name": "dkg_context_graph_invite",
    "description": "Invite a peer ID to a context graph.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Context graph ID."},
            "peer_id": {"type": "string", "description": "Peer ID to invite."},
        },
        "required": ["context_graph_id", "peer_id"],
    },
}

DKG_PARTICIPANT_ADD_SCHEMA = {
    "name": "dkg_participant_add",
    "description": "Add an agent address to a context graph allowlist.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Context graph ID."},
            "agent_address": {"type": "string", "description": "Agent address to add."},
        },
        "required": ["context_graph_id", "agent_address"],
    },
}

DKG_PARTICIPANT_REMOVE_SCHEMA = {
    "name": "dkg_participant_remove",
    "description": "Remove an agent address from a context graph allowlist.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Context graph ID."},
            "agent_address": {"type": "string", "description": "Agent address to remove."},
        },
        "required": ["context_graph_id", "agent_address"],
    },
}

DKG_PARTICIPANT_LIST_SCHEMA = {
    "name": "dkg_participant_list",
    "description": "List allowed agent addresses for a context graph.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Context graph ID."},
        },
        "required": ["context_graph_id"],
    },
}

DKG_JOIN_REQUEST_LIST_SCHEMA = {
    "name": "dkg_join_request_list",
    "description": "List pending join requests for a context graph.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Context graph ID."},
        },
        "required": ["context_graph_id"],
    },
}

DKG_JOIN_REQUEST_APPROVE_SCHEMA = {
    "name": "dkg_join_request_approve",
    "description": "Approve a pending context graph join request.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Context graph ID."},
            "agent_address": {"type": "string", "description": "Agent address to approve."},
        },
        "required": ["context_graph_id", "agent_address"],
    },
}

DKG_JOIN_REQUEST_REJECT_SCHEMA = {
    "name": "dkg_join_request_reject",
    "description": "Reject a pending context graph join request.",
    "parameters": {
        "type": "object",
        "properties": {
            "context_graph_id": {"type": "string", "description": "Context graph ID."},
            "agent_address": {"type": "string", "description": "Agent address to reject."},
        },
        "required": ["context_graph_id", "agent_address"],
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
        self._context_graph = self._config.get("context_graph", "agent-context")
        memory_assertion = self._config.get("memory_assertion") or "memory"

        # Create HTTP client
        from .client import DKGClient
        self._client = DKGClient(
            base_url=self._config.get("daemon_url", "http://127.0.0.1:9200"),
            import_roots=self._config.get("import_roots") or None,
            dkg_home=self._config.get("dkg_home") or None,
        )

        # Check daemon health
        if not self._client.health_check():
            logger.warning("[dkg] Daemon unreachable — starting in offline mode")
            self._offline = True
            return

        # Create or resolve assertion for this agent's Working Memory
        result = self._client.create_assertion(
            self._context_graph, memory_assertion,
        )
        assertion_uri = result.get("assertionUri")
        if assertion_uri or result.get("alreadyExists") is True:
            self._assertion_id = memory_assertion
            if assertion_uri:
                logger.info(f"[dkg] Assertion ready: {assertion_uri}")
            else:
                logger.info(f"[dkg] Assertion ready: existing {self._assertion_id}")
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
                "memory_search or dkg_query to search, and dkg_share to share with team. "
                "Verified Memory publish and context-graph collaboration tools are available."
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

        publish_guidance = (
            "  dkg_shared_memory_publish / dkg_publish — Verified Memory publish flows\n"
            if self._direct_publish_allowed()
            else "  Verified Memory publish tools are disabled by operator policy; ask before chain publish\n"
        )
        admin_guidance = (
            "  dkg_context_graph_invite / dkg_participant_* / dkg_join_request_* — Manage project access\n"
            if self._context_graph_admin_tools_allowed()
            else "  dkg_participant_list / dkg_join_request_list — Review project access state\n"
        )

        blocks.append(
            "DKG TOOLS — Your node is connected to a Decentralized Knowledge Graph.\n"
            "\n"
            "MEMORY WORKFLOW:\n"
            "  dkg_memory — Store/update/remove persistent facts (your primary memory)\n"
            "  memory_search — Free-text recall across DKG memory layers\n"
            "  dkg_query — Search knowledge via SPARQL (fast, local)\n"
            "  dkg_assertion_create/write/promote/query/history/discard/import_file — Work with V10 WM assertions\n"
            "\n"
            "COLLABORATION WORKFLOW:\n"
            "  dkg_share — Share findings to Shared Working Memory (team-visible, free)\n"
            f"{publish_guidance}"
            "  dkg_wallet_balances — Check TRAC balance BEFORE publishing\n"
            "\n"
            "NETWORK & DISCOVERY:\n"
            "  dkg_find_agents — Discover other agents on the network\n"
            "  dkg_send_message — Send encrypted P2P message to another agent\n"
            "  dkg_read_messages — Read messages from other agents\n"
            "  dkg_invoke_skill — Call a remote agent's skill\n"
            "\n"
            "PROJECT MANAGEMENT:\n"
            "  dkg_list_context_graphs — List known projects/knowledge spaces\n"
            "  dkg_context_graph_create — Create a new project/knowledge space\n"
            "  dkg_subscribe — Join an existing project on the network\n"
            "  dkg_sub_graph_create/list — Manage project sub-graphs\n"
            f"{admin_guidance}"
            "  dkg_status — Node health, peers, context graphs\n"
            "\n"
            "TRUST FLOW: Working Memory (local, free) → SHARE → Shared Memory "
            "(team, free) → PUBLISH → Verified Memory (chain, TRAC cost, permanent).\n"
            "Knowledge gains trust as it moves through layers. Only publish when "
            "findings are verified and ready for permanent record.\n"
            "\n"
            "PRIVACY MODEL: Context graphs created via dkg_context_graph_create "
            "default to curated/private — only listed agents receive Shared "
            "Memory gossip. The creator is auto-included; invite collaborators "
            "with dkg_participant_add or pass allowed_agents at creation. Use "
            "public:true to opt into a discoverable/open context graph. Working "
            "Memory is per-agent regardless of visibility. Verified Memory "
            "anchors are public on-chain; the underlying private quads stay "
            "local on the publishing node."
        )

        return "\n\n".join(blocks)

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        schemas = [
            DKG_MEMORY_SCHEMA,
            MEMORY_SEARCH_SCHEMA,
            DKG_QUERY_SCHEMA,
            DKG_SHARE_SCHEMA,
            DKG_STATUS_SCHEMA,
            DKG_WALLET_SCHEMA,
            DKG_LIST_CONTEXT_GRAPHS_SCHEMA,
            DKG_FIND_AGENTS_SCHEMA,
            DKG_SEND_MESSAGE_SCHEMA,
            DKG_READ_MESSAGES_SCHEMA,
            DKG_INVOKE_SKILL_SCHEMA,
            DKG_SUBSCRIBE_SCHEMA,
            DKG_CREATE_CONTEXT_GRAPH_SCHEMA,
            DKG_PARTICIPANT_LIST_SCHEMA,
            DKG_JOIN_REQUEST_LIST_SCHEMA,
            DKG_ASSERTION_CREATE_SCHEMA,
            DKG_ASSERTION_WRITE_SCHEMA,
            DKG_ASSERTION_PROMOTE_SCHEMA,
            DKG_ASSERTION_DISCARD_SCHEMA,
            DKG_ASSERTION_IMPORT_FILE_SCHEMA,
            DKG_ASSERTION_QUERY_SCHEMA,
            DKG_ASSERTION_HISTORY_SCHEMA,
            DKG_SUB_GRAPH_CREATE_SCHEMA,
            DKG_SUB_GRAPH_LIST_SCHEMA,
        ]
        if self._direct_publish_allowed():
            publish_index = schemas.index(DKG_STATUS_SCHEMA)
            schemas[publish_index:publish_index] = [
                DKG_PUBLISH_SCHEMA,
                DKG_SHARED_MEMORY_PUBLISH_SCHEMA,
            ]
        if self._context_graph_admin_tools_allowed():
            admin_index = schemas.index(DKG_PARTICIPANT_LIST_SCHEMA)
            schemas[admin_index:admin_index] = [
                DKG_CONTEXT_GRAPH_INVITE_SCHEMA,
                DKG_PARTICIPANT_ADD_SCHEMA,
                DKG_PARTICIPANT_REMOVE_SCHEMA,
                DKG_JOIN_REQUEST_APPROVE_SCHEMA,
                DKG_JOIN_REQUEST_REJECT_SCHEMA,
            ]
        return schemas

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        handlers = {
            "dkg_memory": self._handle_memory,
            "memory_search": self._handle_memory_search,
            "dkg_query": self._handle_query,
            "dkg_share": self._handle_share,
            "dkg_publish": self._handle_publish,
            "dkg_shared_memory_publish": self._handle_shared_memory_publish,
            "dkg_status": self._handle_status,
            "dkg_wallet_balances": self._handle_wallet,
            "dkg_list_context_graphs": self._handle_list_context_graphs,
            "dkg_find_agents": self._handle_find_agents,
            "dkg_send_message": self._handle_send_message,
            "dkg_read_messages": self._handle_read_messages,
            "dkg_invoke_skill": self._handle_invoke_skill,
            "dkg_subscribe": self._handle_subscribe,
            "dkg_context_graph_create": self._handle_create_cg,
            "dkg_context_graph_invite": self._handle_context_graph_invite,
            "dkg_participant_add": self._handle_participant_add,
            "dkg_participant_remove": self._handle_participant_remove,
            "dkg_participant_list": self._handle_participant_list,
            "dkg_join_request_list": self._handle_join_request_list,
            "dkg_join_request_approve": self._handle_join_request_approve,
            "dkg_join_request_reject": self._handle_join_request_reject,
            "dkg_assertion_create": self._handle_assertion_create,
            "dkg_assertion_write": self._handle_assertion_write,
            "dkg_assertion_promote": self._handle_assertion_promote,
            "dkg_assertion_discard": self._handle_assertion_discard,
            "dkg_assertion_import_file": self._handle_assertion_import_file,
            "dkg_assertion_query": self._handle_assertion_query,
            "dkg_assertion_history": self._handle_assertion_history,
            "dkg_sub_graph_create": self._handle_sub_graph_create,
            "dkg_sub_graph_list": self._handle_sub_graph_list,
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
            lines = []
            for b in bindings[:10]:
                s = b.get("s", {}).get("value", "?")
                p = b.get("p", {}).get("value", "?")
                o = b.get("o", {}).get("value", "?")
                lines.append(f"  {_short(s)} — {_short(p)} — {o}")

            if not lines:
                needle = query.lower().strip()
                for quad in _extract_quads(result):
                    if _quad_predicate(quad) != "urn:hermes:content":
                        continue
                    content = _quad_object(quad)
                    if needle and needle not in content.lower():
                        continue
                    lines.append(f"  {_short(_quad_subject(quad))} - {_short(_quad_predicate(quad))} - {content}")
                    if len(lines) >= 10:
                        break
            if not lines:
                return ""

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
                "default": "agent-context",
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
            "store": "dkg" if not self._offline and not write_queued else "local_cache",
            "queued": write_queued,
        })

    def _handle_query(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline. Cannot run SPARQL queries.")
        sparql = args.get("sparql", "")
        if not sparql:
            return tool_error("SPARQL query is required.")
        if args.get("contextGraph_id") is not None or args.get("contextGraphId") is not None:
            return tool_error('"contextGraph_id" is not a supported parameter. Use "context_graph_id".')
        if args.get("include_shared_memory") is not None or args.get("includeSharedMemory") is not None:
            return tool_error(
                '"include_shared_memory" is no longer supported on dkg_query. '
                'Omit "view" for the legacy data-graph path, or use '
                '"view: shared-working-memory" for SWM-only reads.'
            )
        if args.get("context_graph") is not None:
            return tool_error('"context_graph" is not a supported parameter on dkg_query. Use "context_graph_id".')
        cg = _first_text(args, "context_graph_id") or self._context_graph
        view = _first_text(args, "view")
        if view and view not in ("working-memory", "shared-working-memory", "verified-memory"):
            return tool_error('"view" must be one of: working-memory, shared-working-memory, verified-memory.')
        if view and not _first_text(args, "context_graph_id"):
            return tool_error(f'"view: {view}" requires "context_graph_id".')
        if view and _first_text(args, "sub_graph_name"):
            return tool_error('"sub_graph_name" cannot be combined with view-based dkg_query routing.')
        if args.get("agent_address") is not None and not isinstance(args.get("agent_address"), str):
            return tool_error('"agent_address" must be a string.')
        if isinstance(args.get("agent_address"), str) and not args.get("agent_address", "").strip():
            return tool_error('"agent_address" must be a non-empty string.')
        agent_address = _first_text(args, "agent_address")
        if view == "working-memory" and not agent_address:
            agent_address = self._client._resolve_agent_address()
            if not agent_address:
                return tool_error('"view: working-memory" requires agent_address; retry after identity is available.')
        if view == "working-memory" and agent_address:
            agent_address = _normalize_wm_agent_address(agent_address)
        result = self._client.query(
            sparql,
            cg,
            view=view,
            assertion_name=_first_text(args, "assertion_name"),
            agent_address=agent_address,
            sub_graph_name=_first_text(args, "sub_graph_name"),
            verified_graph=_first_text(args, "verified_graph"),
            graph_suffix=_first_text(args, "graph_suffix"),
            min_trust=args.get("min_trust") if "min_trust" in args else None,
        )
        return json.dumps(result)

    def _handle_memory_search(self, args: Dict[str, Any]) -> str:
        query = _first_text(args, "query")
        if len(query) < 2:
            return tool_error("query must be at least 2 characters.")
        limit = _coerce_limit(args.get("limit"), default=20, maximum=100)
        if self._offline or not self._client:
            return json.dumps(_cache_memory_search(query, self._cache, limit))

        keywords = [k for k in query.lower().split() if len(k) >= 2]
        if not keywords:
            return json.dumps({"query": query, "count": 0, "scope": None, "hits": []})

        sparql = _build_memory_search_sparql(keywords, limit)
        agent_address = self._client._resolve_agent_address()
        if "context_graph" in args:
            return tool_error('"context_graph" is not a supported parameter on memory_search. Use "context_graph_id".')
        project_context_graph = _first_text(args, "context_graph_id") or self._context_graph
        context_graphs: List[str] = []
        for cg in ("agent-context", project_context_graph):
            if cg and cg not in context_graphs:
                context_graphs.append(cg)

        hits: List[Dict[str, Any]] = []
        successful_queries = 0
        for cg in context_graphs:
            for view, weight in (
                ("working-memory", 1.0),
                ("shared-working-memory", 1.15),
                ("verified-memory", 1.3),
            ):
                if view == "working-memory" and not agent_address:
                    continue
                result = self._client.query(
                    sparql,
                    cg,
                    view=view,
                    agent_address=agent_address if view == "working-memory" else None,
                )
                if _client_result_failed(result):
                    continue
                successful_queries += 1
                for binding in _extract_query_bindings(result):
                    text = _binding_value(binding.get("text") or binding.get("o"))
                    uri = _binding_value(binding.get("uri") or binding.get("s"))
                    pred = _binding_value(binding.get("pred") or binding.get("p"))
                    if not text:
                        continue
                    score = _keyword_overlap(text, keywords)
                    layer = _memory_search_layer(cg, view)
                    source = "sessions" if cg == "agent-context" else "memory"
                    hits.append({
                        "snippet": text[:500],
                        "layer": layer,
                        "source": source,
                        "score": round(score, 4),
                        "_rank": score * weight,
                        "path": f"dkg://{cg}/{layer}/{_stable_scope_hash(uri or text)}",
                        "predicate": pred,
                    })

        if not hits and successful_queries == 0:
            fallback = _cache_memory_search(query, self._cache, limit)
            fallback["scope"] = project_context_graph if project_context_graph != "agent-context" else None
            return json.dumps(fallback)
        if not hits:
            return json.dumps({
                "query": query,
                "count": 0,
                "scope": project_context_graph if project_context_graph != "agent-context" else None,
                "hits": [],
            })

        trust_order = {
            "agent-context-vm": 3,
            "project-vm": 3,
            "agent-context-swm": 2,
            "project-swm": 2,
            "agent-context-wm": 1,
            "project-wm": 1,
        }
        deduped: Dict[str, Dict[str, Any]] = {}
        for hit in hits:
            key = f"{hit.get('source')}::{hit.get('path')}"
            existing = deduped.get(key)
            if not existing:
                deduped[key] = hit
                continue
            hit_layer = str(hit.get("layer") or "project-wm")
            existing_layer = str(existing.get("layer") or "project-wm")
            if (
                trust_order.get(hit_layer, 1) > trust_order.get(existing_layer, 1)
                or (
                    trust_order.get(hit_layer, 1) == trust_order.get(existing_layer, 1)
                    and float(hit.get("score", 0)) > float(existing.get("score", 0))
                )
            ):
                deduped[key] = hit
        ranked = sorted(deduped.values(), key=lambda h: float(h.get("_rank", 0)), reverse=True)[:limit]
        public_hits = [{k: v for k, v in hit.items() if k != "_rank"} for hit in ranked]
        return json.dumps({
            "query": query,
            "count": len(public_hits),
            "scope": project_context_graph if project_context_graph != "agent-context" else None,
            "hits": public_hits,
        })

    def _handle_share(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline. Cannot share to team.")
        # Type-validate at the runtime boundary. Without this, a malformed MCP
        # call passing `content: {}` or `False` would crash inside _quote_literal
        # with AttributeError on .replace, instead of returning a structured
        # tool_error. Mirrors the OpenClaw boundary checks (PR #413 round 7).
        if "content" not in args or args["content"] is None or args["content"] == "":
            return tool_error("Content is required.")
        if not isinstance(args["content"], str):
            return tool_error('"content" must be a string.')
        if "context_graph" in args:
            return tool_error('"context_graph" is not a supported parameter on dkg_share. Use "context_graph_id".')
        if "context_graph_id" in args and args["context_graph_id"] is not None and not isinstance(args["context_graph_id"], str):
            return tool_error('"context_graph_id" must be a string.')
        sub_graph_name_raw = args.get("sub_graph_name")
        if sub_graph_name_raw is not None and not isinstance(sub_graph_name_raw, str):
            return tool_error('"sub_graph_name" must be a string.')
        content = args["content"]
        # Aligned with OpenClaw: context_graph_id is required (no implicit
        # current-project fallback). Keeps both adapter contracts identical
        # so portable agent code works unchanged across either surface.
        cg = _first_text(args, "context_graph_id")
        if not cg:
            return tool_error("context_graph_id is required.")
        # Mint a unique root entity per share. The publisher upserts SWM by
        # root entity (packages/publisher/src/dkg-publisher.ts:422-429), so
        # a stable subject would mean each share replaces the previous one
        # rather than appending a new fact.
        share_id = f"{int(time.time() * 1000)}-{secrets.token_hex(4)}"
        subject = f"urn:hermes:{self._agent_name}:shared:{share_id}"
        # Wrap content as an N-Triples literal. The storage layer's
        # formatTerm (packages/storage/src/adapters/oxigraph.ts:233-244)
        # treats any object value not starting with `"` as an IRI, so raw
        # text like `hello` would be coerced to `<hello>` — invalid IRI.
        quads = [{
            "subject": subject,
            "predicate": "urn:hermes:sharedContent",
            "object": _quote_literal(content),
        }]
        result = self._client.share(cg, quads, sub_graph_name=_first_text(args, "sub_graph_name"))
        # Only surface the minted subject on a successful write. Hermes'
        # Python client returns failure shapes (`{success: False, error: ...}`,
        # `{ok: False}`, or bare `{error: ...}`) without throwing — see
        # client.py:213 and the canonical detector at _client_result_failed
        # below. Attaching subject/root_entities to a failure would mask it
        # and let chained dkg_shared_memory_publish calls publish a root
        # entity that was never written. Use the canonical helper so this
        # path stays aligned with every other failure check in the module.
        if _client_result_failed(result):
            return json.dumps(result)
        # Surface the minted subject so callers can target THIS share in a
        # follow-up `dkg_shared_memory_publish({ root_entities: [...] })`.
        # Field name is snake_case to match the consuming tool's argument
        # shape (matches OpenClaw's response, PR #413).
        if isinstance(result, dict):
            response = {**result, "subject": subject, "root_entities": [subject]}
        else:
            response = {"raw": result, "subject": subject, "root_entities": [subject]}
        return json.dumps(response)

    def _handle_publish(self, args: Dict[str, Any]) -> str:
        if not self._direct_publish_allowed():
            return tool_error(
                "Direct DKG publish is disabled by the adapter publish guard. "
                "Use an operator-reviewed publish request or enable DKG_ALLOW_DIRECT_PUBLISH explicitly."
            )
        if self._offline:
            return tool_error("DKG daemon is offline. Cannot publish to chain.")
        cg = _first_text(args, "context_graph_id")
        if not cg:
            return tool_error("context_graph_id is required.")
        quads = _normalize_quads(args.get("quads"))
        if not quads:
            return tool_error("quads must contain at least one item with subject, predicate, and object.")
        share_result = self._client.share(cg, quads, sub_graph_name=_first_text(args, "sub_graph_name"))
        if share_result.get("success") is False:
            return json.dumps(share_result)
        roots = _quad_root_entities(quads)
        result = self._client.publish(
            cg,
            selection="all",
            clear_after=True,
            sub_graph_name=_first_text(args, "sub_graph_name"),
        )
        result["quadsPublished"] = len(quads)
        result["rootEntities"] = roots
        return json.dumps(result)

    def _handle_shared_memory_publish(self, args: Dict[str, Any]) -> str:
        if not self._direct_publish_allowed():
            return tool_error(
                "Direct DKG publish is disabled by the adapter publish guard. "
                "Use an operator-reviewed publish request or enable DKG_ALLOW_DIRECT_PUBLISH explicitly."
            )
        if self._offline:
            return tool_error("DKG daemon is offline. Cannot publish to chain.")
        if "context_graph" in args:
            return tool_error('"context_graph" is not a supported parameter on dkg_shared_memory_publish. Use "context_graph_id".')
        cg = _first_text(args, "context_graph_id")
        if not cg:
            return tool_error("context_graph_id is required.")
        root_entities = args.get("root_entities")
        if root_entities is None:
            selection: Any = "all"
        elif isinstance(root_entities, list) and root_entities and all(isinstance(e, str) and e.strip() for e in root_entities):
            selection = [str(e).strip() for e in root_entities]
        else:
            return tool_error("root_entities must be omitted or a non-empty array of strings.")
        clear_after = args.get("clear_after")
        if clear_after is None:
            clear_after = not isinstance(selection, list)
        elif not isinstance(clear_after, bool):
            return tool_error("clear_after must be a boolean.")
        registration = None
        if args.get("register_if_needed") is not None and not isinstance(args.get("register_if_needed"), bool):
            return tool_error("register_if_needed must be a boolean.")
        if args.get("register_if_needed") is True:
            access_policy = args.get("access_policy")
            if access_policy is not None and access_policy not in (0, 1):
                return tool_error("access_policy must be 0 or 1.")
            registration = self._client.register_context_graph(cg, access_policy)
            if _client_result_failed(registration):
                error = str(registration.get("error") or registration.get("message") or "").lower()
                if "already registered" not in error and "already exists" not in error:
                    return json.dumps(registration)
        result = self._client.publish(
            cg,
            selection=selection,
            clear_after=bool(clear_after),
            sub_graph_name=_first_text(args, "sub_graph_name"),
        )
        if registration is not None:
            result["registration"] = registration
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

    def _handle_list_context_graphs(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline.")
        return json.dumps(self._client.list_context_graphs())

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
            "to": peer_id,
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
        if args.get("since"):
            params["since"] = str(args["since"])
        qs = urlencode(params)
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
        include_shared = args.get("include_shared_memory")
        if include_shared is not None and not isinstance(include_shared, bool):
            return tool_error("include_shared_memory must be a boolean.")
        return json.dumps(self._client.subscribe(cg_id, include_shared))

    def _handle_create_cg(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline. Cannot create Context Graph.")
        name = args.get("name", "").strip()
        if not name:
            return tool_error("name is required.")
        description = args.get("description", "")
        # Privacy-by-default: when `public` is omitted or false, the context
        # graph is curated (`accessPolicy: 1`). The agent's createContextGraph
        # flow auto-includes the creator's address in the allowlist (see
        # `packages/agent/src/dkg-agent.ts:3962-3973`), so the creator can
        # immediately read/write the curated CG without a self-invite step.
        #
        # Round 2 — strict type validation: an LLM that emits
        # `public: "yes"` (string) or any non-boolean value should get a
        # clear tool error rather than silently defaulting to false (which
        # would produce the opposite of the agent's intent). Only `True`,
        # `False`, or omitted are accepted.
        raw_public = args.get("public")
        if raw_public is not None and not isinstance(raw_public, bool):
            return tool_error(
                f"\"public\" must be a boolean (true or false). Got: {type(raw_public).__name__}."
            )
        is_public = raw_public is True
        access_policy: Optional[int] = None if is_public else 1
        raw_allowed = args.get("allowed_agents")
        allowed_agents: Optional[list] = None
        if not is_public and raw_allowed is not None:
            # Round 2 — strict validation: every entry must be a non-empty
            # trimmed string that matches the Ethereum address regex.
            # Previously we silently dropped non-string/blank entries,
            # which hides LLM-generated mistakes (e.g. `["0xAlice...", 42]`
            # would create a curated graph without entry 42's owner ever
            # knowing they were excluded). Fail fast instead.
            if not isinstance(raw_allowed, list):
                return tool_error(
                    f"\"allowed_agents\" must be an array of strings. Got: {type(raw_allowed).__name__}."
                )
            eth_addr_re = re.compile(r"^0x[0-9a-fA-F]{40}$")
            cleaned: list = []
            for index, entry in enumerate(raw_allowed):
                if not isinstance(entry, str):
                    return tool_error(
                        f"\"allowed_agents[{index}]\" must be a string. Got: {type(entry).__name__}."
                    )
                trimmed = entry.strip()
                if not trimmed:
                    return tool_error(
                        f"\"allowed_agents[{index}]\" is empty or whitespace-only. "
                        "Each entry must be a 0x-prefixed 40-hex-char Ethereum address."
                    )
                if not eth_addr_re.match(trimmed):
                    return tool_error(
                        f"Invalid Ethereum address in \"allowed_agents[{index}]\": \"{entry}\". "
                        "Each entry must be a 0x-prefixed 40-hex-char string "
                        "(e.g. \"0x1234567890abcdef1234567890abcdef12345678\")."
                    )
                cleaned.append(trimmed)
            if cleaned:
                allowed_agents = cleaned
        result = self._client.create_context_graph(
            name,
            description,
            cg_id=_first_text(args, "id"),
            access_policy=access_policy,
            allowed_agents=allowed_agents,
        )
        return json.dumps(result)

    def _handle_context_graph_invite(self, args: Dict[str, Any]) -> str:
        if not self._context_graph_admin_tools_allowed():
            return tool_error(
                "Context graph admin tools are disabled by the adapter guard. "
                "Enable DKG_ALLOW_CONTEXT_GRAPH_ADMIN_TOOLS explicitly."
            )
        if self._offline:
            return tool_error("DKG daemon is offline.")
        cg = _first_text(args, "context_graph_id")
        peer_id = _first_text(args, "peer_id")
        if not cg:
            return tool_error("context_graph_id is required.")
        if not peer_id:
            return tool_error("peer_id is required.")
        result = self._client.invite_to_context_graph(cg, peer_id)
        if not isinstance(result, dict):
            result = {"result": result}
        status: Dict[str, Any] = {}
        try:
            status_result = self._client.status()
            if isinstance(status_result, dict):
                status = status_result
        except Exception:
            status = {}
        multiaddrs = [value for value in status.get("multiaddrs", []) if isinstance(value, str)]
        curator_multiaddr = _pick_shareable_multiaddr(multiaddrs)
        enriched = {
            **result,
            "peerId": peer_id,
            "curatorMultiaddr": curator_multiaddr,
            "inviteCode": f"{cg}\n{curator_multiaddr}" if curator_multiaddr else cg,
        }
        return json.dumps(enriched)

    def _handle_participant_add(self, args: Dict[str, Any]) -> str:
        return self._participant_tool(args, "add")

    def _handle_participant_remove(self, args: Dict[str, Any]) -> str:
        return self._participant_tool(args, "remove")

    def _handle_participant_list(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline.")
        cg = _first_text(args, "context_graph_id")
        if not cg:
            return tool_error("context_graph_id is required.")
        return json.dumps(self._client.list_participants(cg))

    def _participant_tool(self, args: Dict[str, Any], action: str) -> str:
        if not self._context_graph_admin_tools_allowed():
            return tool_error(
                "Context graph admin tools are disabled by the adapter guard. "
                "Enable DKG_ALLOW_CONTEXT_GRAPH_ADMIN_TOOLS explicitly."
            )
        if self._offline:
            return tool_error("DKG daemon is offline.")
        cg = _first_text(args, "context_graph_id")
        agent_address = _first_text(args, "agent_address")
        if not cg:
            return tool_error("context_graph_id is required.")
        if not agent_address:
            return tool_error("agent_address is required.")
        if action == "add":
            return json.dumps(self._client.add_participant(cg, agent_address))
        return json.dumps(self._client.remove_participant(cg, agent_address))

    def _handle_join_request_list(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline.")
        cg = _first_text(args, "context_graph_id")
        if not cg:
            return tool_error("context_graph_id is required.")
        return json.dumps(self._client.list_join_requests(cg))

    def _handle_join_request_approve(self, args: Dict[str, Any]) -> str:
        return self._join_request_tool(args, "approve")

    def _handle_join_request_reject(self, args: Dict[str, Any]) -> str:
        return self._join_request_tool(args, "reject")

    def _join_request_tool(self, args: Dict[str, Any], action: str) -> str:
        if not self._context_graph_admin_tools_allowed():
            return tool_error(
                "Context graph admin tools are disabled by the adapter guard. "
                "Enable DKG_ALLOW_CONTEXT_GRAPH_ADMIN_TOOLS explicitly."
            )
        if self._offline:
            return tool_error("DKG daemon is offline.")
        cg = _first_text(args, "context_graph_id")
        agent_address = _first_text(args, "agent_address")
        if not cg:
            return tool_error("context_graph_id is required.")
        if not agent_address:
            return tool_error("agent_address is required.")
        if action == "approve":
            return json.dumps(self._client.approve_join_request(cg, agent_address))
        return json.dumps(self._client.reject_join_request(cg, agent_address))

    def _handle_assertion_create(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline.")
        cg, name = _required_cg_and_name(args)
        if not cg:
            return tool_error("context_graph_id is required.")
        if not name:
            return tool_error("name is required.")
        return json.dumps(self._client.create_assertion(cg, name, _first_text(args, "sub_graph_name")))

    def _handle_assertion_write(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline.")
        cg, name = _required_cg_and_name(args)
        if not cg:
            return tool_error("context_graph_id is required.")
        if not name:
            return tool_error("name is required.")
        quads = _normalize_quads(args.get("quads"))
        if not quads:
            return tool_error("quads must contain at least one item with subject, predicate, and object.")
        return json.dumps(self._client.write_assertion(name, cg, quads, _first_text(args, "sub_graph_name")))

    def _handle_assertion_promote(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline.")
        cg, name = _required_cg_and_name(args)
        if not cg:
            return tool_error("context_graph_id is required.")
        if not name:
            return tool_error("name is required.")
        entities = args.get("entities")
        if entities is not None and not (
            isinstance(entities, list) and entities and all(isinstance(e, str) and e.strip() for e in entities)
        ):
            return tool_error("entities must be omitted or a non-empty array of strings.")
        return json.dumps(self._client.promote_assertion(name, cg, entities, _first_text(args, "sub_graph_name")))

    def _handle_assertion_discard(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline.")
        cg, name = _required_cg_and_name(args)
        if not cg:
            return tool_error("context_graph_id is required.")
        if not name:
            return tool_error("name is required.")
        return json.dumps(self._client.discard_assertion(name, cg, _first_text(args, "sub_graph_name")))

    def _handle_assertion_import_file(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline.")
        cg, name = _required_cg_and_name(args)
        file_path = _first_text(args, "file_path")
        if not cg:
            return tool_error("context_graph_id is required.")
        if not name:
            return tool_error("name is required.")
        if not file_path:
            return tool_error("file_path is required.")
        return json.dumps(self._client.import_assertion_file(
            name,
            cg,
            file_path,
            content_type=_first_text(args, "content_type"),
            ontology_ref=_first_text(args, "ontology_ref"),
            sub_graph_name=_first_text(args, "sub_graph_name"),
        ))

    def _handle_assertion_query(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline.")
        cg, name = _required_cg_and_name(args)
        if not cg:
            return tool_error("context_graph_id is required.")
        if not name:
            return tool_error("name is required.")
        return json.dumps(self._client.query_assertion(name, cg, sub_graph_name=_first_text(args, "sub_graph_name")))

    def _handle_assertion_history(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline.")
        cg, name = _required_cg_and_name(args)
        if not cg:
            return tool_error("context_graph_id is required.")
        if not name:
            return tool_error("name is required.")
        return json.dumps(self._client.assertion_history(
            name,
            cg,
            agent_address=_first_text(args, "agent_address"),
            sub_graph_name=_first_text(args, "sub_graph_name"),
        ))

    def _handle_sub_graph_create(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline.")
        cg = _first_text(args, "context_graph_id")
        sub_graph = _first_text(args, "sub_graph_name")
        if not cg:
            return tool_error("context_graph_id is required.")
        if not sub_graph:
            return tool_error("sub_graph_name is required.")
        return json.dumps(self._client.create_sub_graph(cg, sub_graph))

    def _handle_sub_graph_list(self, args: Dict[str, Any]) -> str:
        if self._offline:
            return tool_error("DKG daemon is offline.")
        cg = _first_text(args, "context_graph_id")
        if not cg:
            return tool_error("context_graph_id is required.")
        return json.dumps(self._client.list_sub_graphs(cg))

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
        subject = f"urn:hermes:{_uri_segment(self._agent_name, 'agent')}:{_uri_segment(target, 'memory')}"
        for e in entries:
            quads.append({
                "subject": subject,
                "predicate": "urn:hermes:content",
                "object": _quote_literal(f"[{e.get('target', target)}]\n{e['content']}"),
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
        exposure = str(self._config.get("publish_tool", "direct")).lower()
        allow = self._config.get("allow_direct_publish", True)
        if exposure == "disabled" or allow is False or str(allow).lower() in ("0", "false", "no"):
            return False
        return (
            allow is True
            or str(allow).lower() in ("1", "true", "yes")
            or exposure == "direct"
        )

    def _context_graph_admin_tools_allowed(self) -> bool:
        allow = self._config.get("allow_context_graph_admin_tools", True)
        if allow is False or str(allow).lower() in ("0", "false", "no"):
            return False
        return allow is True or str(allow).lower() in ("1", "true", "yes")

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


def _first_text(args: Dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


_ETH_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def _normalize_wm_agent_address(agent_address: str) -> str:
    value = agent_address.strip()
    if value.startswith("did:dkg:agent:"):
        value = value[len("did:dkg:agent:"):]
    if _ETH_ADDRESS_RE.match(value):
        try:
            from eth_utils import to_checksum_address
            return to_checksum_address(value)
        except Exception:
            return value
    return value


def _required_cg_and_name(args: Dict[str, Any]) -> tuple[str, str]:
    return _first_text(args, "context_graph_id"), _first_text(args, "name")


_ECHAR_REPLACEMENTS = {
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\f": "\\f",
    "\r": "\\r",
}


def _quote_literal(value: str) -> str:
    """
    Wrap a free-text string as an N-Triples literal.

    Escapes the full set the daemon's storage parser requires:
    * the two structural ECHARs (`\\` and `"`) first, so subsequent
      escape introducers don't get themselves doubled;
    * the five common ECHAR control bytes (`\\b`, `\\t`, `\\n`, `\\f`, `\\r`);
    * every remaining ASCII control byte (0x00-0x1F and 0x7F) as a
      `\\uXXXX` UCHAR escape — without this, inputs containing NUL,
      VT, DEL, etc. produce an invalid literal that the parser rejects.

    Mirrors the OpenClaw side of the parity hardening (PR #413, defensive
    post-pass over `escapeDkgRdfLiteral`). The TypeScript canonical helper
    has the same gap upstream — see issue #416.
    """
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    out: List[str] = []
    for ch in escaped:
        code = ord(ch)
        if ch in _ECHAR_REPLACEMENTS:
            out.append(_ECHAR_REPLACEMENTS[ch])
        elif code < 0x20 or code == 0x7F:
            out.append(f"\\u{code:04X}")
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


def _uri_segment(value: Any, fallback: str) -> str:
    segment = re.sub(r"[^A-Za-z0-9._:-]+", "-", str(value or "").strip()).strip("-")
    return segment or fallback


def _normalize_quads(raw_quads: Any) -> List[Dict[str, str]]:
    if not isinstance(raw_quads, list):
        return []
    quads: List[Dict[str, str]] = []
    for raw in raw_quads:
        if not isinstance(raw, dict):
            return []
        subject = str(raw.get("subject", "")).strip()
        predicate = str(raw.get("predicate", "")).strip()
        object_value = str(raw.get("object", "")).strip()
        if not subject or not predicate or not object_value:
            return []
        quad = {
            "subject": subject,
            "predicate": predicate,
            "object": object_value if _is_uri(object_value) or object_value.startswith('"') else _quote_literal(object_value),
        }
        if raw.get("graph") is not None:
            quad["graph"] = str(raw.get("graph", ""))
        quads.append(quad)
    return quads


def _quad_root_entities(quads: List[Dict[str, str]]) -> List[str]:
    roots: List[str] = []
    for quad in quads:
        subject = str(quad.get("subject", "")).strip()
        if subject and subject not in roots:
            roots.append(subject)
    return roots


def _coerce_limit(value: Any, default: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except Exception:
        parsed = default
    return max(1, min(maximum, parsed))


def _build_memory_search_sparql(keywords: List[str], limit: int) -> str:
    filters = " || ".join(
        f'CONTAINS(LCASE(STR(?text)), "{_escape_sparql(keyword)}")'
        for keyword in keywords
    )
    return (
        "SELECT ?uri ?pred ?text WHERE { "
        "?uri ?pred ?text . "
        "FILTER(isLiteral(?text)) "
        "FILTER(STRLEN(STR(?text)) >= 2) "
        f"FILTER({filters}) "
        f"}} LIMIT {limit}"
    )


def _binding_value(value: Any) -> str:
    if isinstance(value, dict):
        value = value.get("value") or value.get("id") or value.get("term") or ""
    text = str(value or "")
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        text = text[1:-1]
    return text.replace('\\"', '"').replace("\\n", "\n")


def _keyword_overlap(text: str, keywords: List[str]) -> float:
    lower = text.lower()
    if not keywords:
        return 0.0
    return len([keyword for keyword in keywords if keyword in lower]) / len(keywords)


def _memory_search_layer(context_graph_id: str, view: str) -> str:
    suffix = {
        "working-memory": "wm",
        "shared-working-memory": "swm",
        "verified-memory": "vm",
    }.get(view, "wm")
    prefix = "agent-context" if context_graph_id == "agent-context" else "project"
    return f"{prefix}-{suffix}"


def _cache_memory_search(query: str, cache: Dict[str, Any], limit: int) -> Dict[str, Any]:
    keywords = [k for k in query.lower().split() if len(k) >= 2]
    hits: List[Dict[str, Any]] = []
    for target in ("memory", "user"):
        entries = cache.get(target, [])
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            content = str(entry.get("content", ""))
            score = _keyword_overlap(content, keywords)
            if score <= 0:
                continue
            hits.append({
                "snippet": content[:500],
                "layer": "local-cache",
                "source": target,
                "score": round(score, 4),
                "path": f"local-cache://{target}/{_stable_scope_hash(content)}",
            })
    ranked = sorted(hits, key=lambda h: float(h.get("score", 0)), reverse=True)[:limit]
    return {"query": query, "count": len(ranked), "scope": None, "hits": ranked, "offline": True}


def _pick_shareable_multiaddr(addrs: List[str]) -> Optional[str]:
    if not addrs:
        return None
    return sorted(addrs, key=_score_multiaddr, reverse=True)[0]


def _score_multiaddr(addr: str) -> int:
    if "/p2p-circuit/" in addr:
        return 100
    parts = addr.split("/")
    ipv4 = ""
    for index, part in enumerate(parts):
        if part == "ip4" and index + 1 < len(parts):
            ipv4 = parts[index + 1]
            break
    if not ipv4:
        return 50
    if ipv4.startswith("127."):
        return 0
    if _is_private_ipv4(ipv4):
        return 10
    return 80


def _is_private_ipv4(ip: str) -> bool:
    if ip.startswith("10.") or ip.startswith("192.168.") or ip.startswith("169.254."):
        return True
    parts = ip.split(".")
    if len(parts) >= 2 and parts[0] == "172":
        try:
            second = int(parts[1])
        except ValueError:
            return False
        return 16 <= second <= 31
    return False


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
