import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
vi.mock('@origintrail-official/dkg-core', async () => {
  const actual = await vi.importActual<typeof import('@origintrail-official/dkg-core')>(
    '@origintrail-official/dkg-core',
  );
  return {
    ...actual,
    resolveDkgConfigHome: vi.fn((opts) => actual.resolveDkgConfigHome(opts)),
    resolveDkgHome: vi.fn((opts) => actual.resolveDkgHome(opts)),
  };
});
import { resolveDkgHome } from '@origintrail-official/dkg-core';
import { HermesAdapterPlugin } from '../src/HermesAdapterPlugin.js';
import { registerHermesRoutes } from '../src/hermes-routes.js';
import { HermesDkgClient, redact } from '../src/dkg-client.js';
import {
  disconnectHermesProfile,
  planHermesSetup,
  runDoctor,
  runDisconnect,
  runReconnect,
  resolveHermesProfile,
  runSetup,
  runUninstall,
  runVerify,
  setupHermesProfile,
  uninstallHermesProfile,
  verifyHermesProfile,
} from '../src/setup.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
import { createTrackingApi, trackingRes, type TrackingApi } from './hermes-adapter.shared';

describe('Hermes Python provider', () => {



  it('enforces OpenClaw-parity Hermes tool contracts', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-contracts-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
registry.tool_error = lambda message: json.dumps({"error": message})
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
client_spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg.client",
    plugin_dir / "client.py",
)
client_module = importlib.util.module_from_spec(client_spec)
sys.modules["plugins.memory.dkg.client"] = client_module
client_spec.loader.exec_module(client_module)

spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

client = client_module.DKGClient("http://127.0.0.1:9200")
client._post = lambda path, data=None: {"success": False, "error": "Assertion already exists"}
exists = client.create_assertion("cg:test", "Hermes")
assert exists["success"] is True and exists["alreadyExists"] is True, exists

class FakeError(Exception):
    pass

class FakeResponse:
    text = '{"error":"Assertion already exists"}'

    def json(self):
        return {"error": "Assertion already exists"}

    def raise_for_status(self):
        err = FakeError("400 Client Error")
        err.response = self
        raise err

class FakeSession:
    def post(self, *args, **kwargs):
        return FakeResponse()

client_http = client_module.DKGClient("http://127.0.0.1:9200")
client_http._session = FakeSession()
exists_http = client_http.create_assertion("cg:test", "Hermes")
assert exists_http["success"] is True and exists_http["alreadyExists"] is True, exists_http

created_assertions = []

class ExistingAssertionClient:
    def __init__(self, base_url, **kwargs):
        self.base_url = base_url

    def health_check(self):
        return True

    def create_assertion(self, context_graph_id, name):
        created_assertions.append((context_graph_id, name))
        return {"success": True, "alreadyExists": True}

provider_existing = module.DKGMemoryProvider()
module._load_config = lambda: {
    "daemon_url": "http://127.0.0.1:9200",
    "context_graph": "cg:test",
    "agent_name": "HermesAgent",
}
module._load_cache = lambda agent_name: {"memory": [], "user": [], "queued_writes": []}
client_module.DKGClient = ExistingAssertionClient
provider_existing._backlog_import_if_needed = lambda hermes_home: None
provider_existing.initialize("session-1")
assert provider_existing._assertion_id == "memory", provider_existing._assertion_id
assert created_assertions == [("cg:test", "memory")], created_assertions

agent_context_calls = []

class MissingAgentContextClient:
    def __init__(self, base_url, **kwargs):
        self.base_url = base_url
        self.create_attempts = 0

    def health_check(self):
        return True

    def create_assertion(self, context_graph_id, name):
        self.create_attempts += 1
        agent_context_calls.append(("create_assertion", context_graph_id, name))
        if self.create_attempts == 1:
            return {
                "success": False,
                "code": "CONTEXT_GRAPH_NOT_FOUND",
                "error": 'Unknown contextGraphId "agent-context"',
            }
        return {"success": True, "alreadyExists": True}

    def create_context_graph(self, name, description="", cg_id=None, **kwargs):
        agent_context_calls.append(("create_context_graph", name, description, cg_id, kwargs))
        return {"created": cg_id}

provider_agent_context = module.DKGMemoryProvider()
module._load_config = lambda: {
    "daemon_url": "http://127.0.0.1:9200",
    "context_graph": "agent-context",
    "agent_name": "HermesAgent",
}
client_module.DKGClient = MissingAgentContextClient
provider_agent_context._backlog_import_if_needed = lambda hermes_home: None
provider_agent_context.initialize("session-2")
assert provider_agent_context._assertion_id == "memory", provider_agent_context._assertion_id
assert agent_context_calls == [
    ("create_assertion", "agent-context", "memory"),
    (
        "create_context_graph",
        "Agent Context",
        "Chat-turn working memory for local agent integrations.",
        "agent-context",
        {"access_policy": 1},
    ),
    ("create_assertion", "agent-context", "memory"),
], agent_context_calls

class QueryClient:
    def __init__(self):
        self.queries = []

    def _resolve_agent_address(self):
        return "peer-default"

    def query(self, sparql, context_graph_id, **kwargs):
        self.queries.append((sparql, context_graph_id, kwargs))
        return {"ok": True}

provider = module.DKGMemoryProvider()
provider._offline = False
provider._context_graph = "default-cg"
class ListContextGraphsClient:
    def __init__(self):
        self.rows = [
            {"id": "mine", "callerInvolved": True},
            {"id": "public-noise", "callerInvolved": False},
        ]

    def list_context_graphs(self):
        return {"contextGraphs": self.rows}

provider._client = ListContextGraphsClient()
mine = json.loads(provider.handle_tool_call("dkg_list_context_graphs", {}))
all_graphs = json.loads(provider.handle_tool_call("dkg_list_context_graphs", {"scope": "all"}))
bad_scope = json.loads(provider.handle_tool_call("dkg_list_context_graphs", {"scope": "other"}))
assert [row["id"] for row in mine["contextGraphs"]] == ["mine"], mine
assert mine["scope"] == "mine", mine
assert [row["id"] for row in all_graphs["contextGraphs"]] == ["mine", "public-noise"], all_graphs
assert all_graphs["scope"] == "all", all_graphs
assert "scope" in bad_scope["error"], bad_scope

provider._client = QueryClient()

for args, needle in [
    ({"sparql": "ASK {}", "contextGraph_id": "old"}, "contextGraph_id"),
    ({"sparql": "ASK {}", "include_shared_memory": True}, "include_shared_memory"),
    ({"sparql": "ASK {}", "context_graph": "old"}, "context_graph"),
    ({"sparql": "ASK {}", "context_graph_id": "cg:test", "view": "bad"}, "view"),
    ({"sparql": "ASK {}", "view": "working-memory"}, "context_graph_id"),
    ({"sparql": "ASK {}", "context_graph_id": "cg:test", "view": "shared-working-memory", "sub_graph_name": "scratch"}, "sub_graph_name"),
    ({"sparql": "ASK {}", "context_graph_id": "cg:test", "view": "working-memory", "agent_address": "   "}, "agent_address"),
]:
    result = json.loads(provider.handle_tool_call("dkg_query", args))
    assert needle in result["error"], (args, result)

result = json.loads(provider.handle_tool_call("dkg_query", {
    "sparql": "ASK {}",
    "context_graph_id": "cg:test",
    "view": "working-memory",
    "agent_address": "did:dkg:agent:peer-explicit",
}))
assert result["ok"] is True, result
assert provider._client.queries[-1][2]["agent_address"] == "peer-explicit", provider._client.queries

result = json.loads(provider.handle_tool_call("dkg_query", {
    "sparql": "ASK {}",
    "context_graph_id": "cg:test",
    "view": "working-memory",
}))
assert result["ok"] is True, result
assert provider._client.queries[-1][2]["agent_address"] == "peer-default", provider._client.queries

class ReadMarkdownClient:
    def __init__(self):
        self.calls = []

    def read_import_artifact_markdown(self, context_graph_id, **kwargs):
        self.calls.append((context_graph_id, kwargs))
        return {"ok": True}

provider._client = ReadMarkdownClient()
result = json.loads(provider.handle_tool_call("dkg_knowledge_asset_import_artifact_read_markdown", {
    "context_graph_id": "cg:test",
    "assertion_uri": "did:dkg:context-graph:cg:test/assertion/agent/imported",
    "max_bytes": "4096",
}))
assert result["ok"] is True, result
assert provider._client.calls[-1][1]["max_bytes"] == 4096, provider._client.calls

for bad_max_bytes in [0, -1, 1.5, True, "   "]:
    result = json.loads(provider.handle_tool_call("dkg_knowledge_asset_import_artifact_read_markdown", {
        "context_graph_id": "cg:test",
        "assertion_uri": "did:dkg:context-graph:cg:test/assertion/agent/imported",
        "max_bytes": bad_max_bytes,
    }))
    assert "positive integer" in result["error"], (bad_max_bytes, result)
assert len(provider._client.calls) == 1, provider._client.calls

class AssertionWriteClient:
    def __init__(self):
        self.calls = []

    def write_assertion(self, name, context_graph_id, quads, sub_graph_name=None):
        self.calls.append((name, context_graph_id, quads, sub_graph_name))
        return {"ok": True}

provider._client = AssertionWriteClient()
result = json.loads(provider.handle_tool_call("dkg_knowledge_asset_write", {
    "context_graph_id": "cg:test",
    "name": "notes",
    "quads": [
        {"subject": "urn:doc:1", "predicate": "http://schema.org/contactPoint", "object": "mailto:alice@example.org"},
    ],
}))
assert result["ok"] is True, result
assert provider._client.calls[-1][2][0]["object"] == '"mailto:alice@example.org"', provider._client.calls

class SemanticClient:
    def __init__(self):
        self.calls = []

    def write_semantic_enrichment(self, context_graph_id, semantic_quads, **kwargs):
        self.calls.append((context_graph_id, semantic_quads, kwargs))
        return {"ok": True}

provider._client = SemanticClient()
result = json.loads(provider.handle_tool_call("dkg_knowledge_asset_semantic_enrichment_write", {
    "context_graph_id": "cg:test",
    "assertion_uri": "did:dkg:context-graph:cg:test/assertion/agent/imported",
    "semantic_quads": [
        {"subject": "urn:doc:1", "predicate": "http://schema.org/about", "object": "Topic"},
        {"subject": "urn:doc:1", "predicate": "http://schema.org/author", "object": "mailto:alice@example.org"},
        {"subject": "urn:doc:1", "predicate": "http://schema.org/sameAs", "object": "ipfs://bafy-test"},
    ],
}))
assert result["ok"] is True, result
assert provider._client.calls[-1][1] == [
    {"subject": "urn:doc:1", "predicate": "http://schema.org/about", "object": '"Topic"'},
    {"subject": "urn:doc:1", "predicate": "http://schema.org/author", "object": "mailto:alice@example.org"},
    {"subject": "urn:doc:1", "predicate": "http://schema.org/sameAs", "object": "ipfs://bafy-test"},
], provider._client.calls
assert "name" not in provider._client.calls[-1][2], provider._client.calls

name_result = json.loads(provider.handle_tool_call("dkg_knowledge_asset_semantic_enrichment_write", {
    "context_graph_id": "cg:test",
    "assertion_uri": "did:dkg:context-graph:cg:test/assertion/agent/imported",
    "semanticAssertionName": "semantic-imported",
    "semantic_quads": [
        {"subject": "urn:doc:1", "predicate": "http://schema.org/about", "object": "Topic"},
    ],
}))
assert "target assertion names are not supported" in name_result["error"], name_result

graph_result = json.loads(provider.handle_tool_call("dkg_knowledge_asset_semantic_enrichment_write", {
    "context_graph_id": "cg:test",
    "assertion_uri": "did:dkg:context-graph:cg:test/assertion/agent/imported",
    "semantic_quads": [
        {"subject": "urn:doc:1", "predicate": "http://schema.org/about", "object": "Topic", "graph": "urn:graph:bad"},
    ],
}))
assert "graph" in graph_result["error"], graph_result
provider._client = QueryClient()
provider._config = {"publish_tool": "direct", "allow_direct_publish": True}
for tool_name, args in [
    ("memory_search", {"query": "alpha beta", "context_graph": "legacy"}),
    ("dkg_share", {"content": "alpha", "context_graph": "legacy"}),
    ("dkg_shared_memory_publish", {"context_graph": "legacy"}),
    ("dkg_knowledge_asset_write", {
        "context_graph": "legacy",
        "name": "notes",
        "quads": [{"subject": "urn:s", "predicate": "urn:p", "object": "o"}],
    }),
]:
    result = json.loads(provider.handle_tool_call(tool_name, args))
    assert "context_graph" in result["error"], (tool_name, result)

class MessageClient:
    def __init__(self):
        self.paths = []

    def _get(self, path):
        self.paths.append(path)
        return {"ok": True}

provider._client = MessageClient()
result = json.loads(provider.handle_tool_call("dkg_read_messages", {
    "peer": "peer one",
    "limit": 10,
    "since": "123",
}))
assert result["ok"] is True, result
assert provider._client.paths == ["/api/messages?peer=peer+one&limit=10&since=123"], provider._client.paths

class InviteClient:
    def invite_to_context_graph(self, context_graph_id, peer_id):
        return {"success": True, "contextGraphId": context_graph_id}

    def status(self):
        return {
            "multiaddrs": [
                "/ip4/127.0.0.1/tcp/8900/p2p/peer-local",
                "/ip4/203.0.113.10/tcp/8900/p2p/peer-public",
                "/ip4/10.0.0.5/tcp/8900/p2p/peer-private",
            ]
        }

provider._config = {
    "publish_tool": "direct",
    "allow_direct_publish": True,
    "allow_context_graph_admin_tools": True,
}
provider._client = InviteClient()
result = json.loads(provider.handle_tool_call("dkg_context_graph_invite", {
    "context_graph_id": "cg:test",
    "peer_id": "peer-friend",
}))
assert result["success"] is True, result
assert result["peerId"] == "peer-friend", result
assert result["curatorMultiaddr"] == "/ip4/203.0.113.10/tcp/8900/p2p/peer-public", result
assert result["inviteCode"] == "cg:test\n/ip4/203.0.113.10/tcp/8900/p2p/peer-public", result

class RegisterFailClient:
    def __init__(self):
        self.published = False

    def register_context_graph(self, context_graph_id, access_policy=None):
        return {"success": False, "error": "wallet missing"}

    def publish(self, *args, **kwargs):
        self.published = True
        raise AssertionError("publish should not run")

provider._config = {"publish_tool": "direct", "allow_direct_publish": True}
provider._client = RegisterFailClient()
result = json.loads(provider.handle_tool_call("dkg_shared_memory_publish", {
    "context_graph_id": "cg:test",
    "register_if_needed": True,
}))
assert result["success"] is False and "wallet missing" in result["error"], result
assert provider._client.published is False

class AlreadyRegisteredClient(RegisterFailClient):
    def register_context_graph(self, context_graph_id, access_policy=None):
        return {"success": False, "error": "context graph already registered"}

    def publish(self, *args, **kwargs):
        self.published = True
        return {"success": True}

provider._client = AlreadyRegisteredClient()
result = json.loads(provider.handle_tool_call("dkg_shared_memory_publish", {
    "context_graph_id": "cg:test",
    "register_if_needed": True,
}))
assert result["success"] is True and provider._client.published is True, result
# FIX H (#1084:1810): the already-registered short-circuit normalizes the
# registration to a success shape — it must NOT carry the raw {success:false}.
assert result["registration"] == {"alreadyRegistered": True}, result

# dkg_publish (one-shot) routes through the ATOMIC assertionName fork
# (client.publish_quads): create a uniquely-named sealed assertion + publish it
# by name in one atomic mint — no per-root selection/loop (parity w/ OpenClaw+MCP).
class PublishClient:
    def __init__(self):
        self.publish_quads_call = None

    def publish_quads(self, context_graph_id, quads, sub_graph_name=None):
        self.publish_quads_call = (context_graph_id, quads, sub_graph_name)
        return {"kaId": "ka", "ual": "did:dkg:1/0xabc/5", "status": "confirmed"}

provider._client = PublishClient()
result = json.loads(provider.handle_tool_call("dkg_publish", {
    "context_graph_id": "cg:test",
    "quads": [
        {"subject": "urn:root:1", "predicate": "urn:p", "object": "one"},
        {"subject": "urn:root:2", "predicate": "urn:p", "object": "two"},
        {"subject": "urn:root:1", "predicate": "urn:p2", "object": "three"},
    ],
}))
# Multi-subject quads publish atomically in ONE call — no 409, no over-scope.
assert result["ual"] == "did:dkg:1/0xabc/5", result
assert result["quadsPublished"] == 3, result
assert provider._client.publish_quads_call[0] == "cg:test", provider._client.publish_quads_call
assert len(provider._client.publish_quads_call[1]) == 3, provider._client.publish_quads_call
# The obsolete selection-fork result fields are gone.
for _k in ("rootEntities", "partial", "publishedRoots", "failedRoot", "notAttemptedRoots"):
    assert _k not in result, _k
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

});
