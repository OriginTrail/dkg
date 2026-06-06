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


  it('persists turn identity sequence across provider restarts', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-provider-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
def tool_error(message):
    return json.dumps({"error": message})
registry.tool_error = tool_error
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

def make_provider():
    provider = module.DKGMemoryProvider()
    provider._config = {"profile_name": "dev"}
    provider._agent_name = "agent"
    provider._session_id = module._scoped_session_id("session-1", provider._config)
    provider._cache = module._load_cache("agent")
    provider._offline = True
    provider._client = None
    return provider

first = make_provider()
first.sync_turn("same user", "same assistant")
second = make_provider()
second.sync_turn("same user", "same assistant")

cache = module._load_cache("agent")
turns = [item for item in cache["queued_writes"] if item.get("type") == "turn"]
assert len(turns) == 2, turns
assert turns[0]["turn_id"] != turns[1]["turn_id"], turns
assert turns[0]["idempotency_key"] != turns[1]["idempotency_key"], turns
assert turns[0]["turn_id"].split(":")[-2] == "1", turns
assert turns[1]["turn_id"].split(":")[-2] == "2", turns
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('CLI sync preserves queued turn idempotency fields', () => {
    const script = String.raw`
import importlib.util
import sys
import types
from pathlib import Path

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"

pkg = types.ModuleType("plugins.memory.dkg")
pkg.__path__ = [str(plugin_dir)]
pkg._load_config = lambda: {"daemon_url": "http://127.0.0.1:9200", "agent_name": "agent"}
cache = {
    "queued_writes": [{
        "type": "turn",
        "session_id": "session-1",
        "user": "hello",
        "assistant": "hi",
        "turn_id": "turn-123",
        "idempotency_key": "idem-123",
    }]
}
saved = []
pkg._load_cache = lambda agent_name: cache
pkg._save_cache = lambda next_cache, agent_name: saved.append((next_cache, agent_name))

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")
sys.modules["plugins.memory.dkg"] = pkg

store_calls = []
client_mod = types.ModuleType("plugins.memory.dkg.client")
class DKGClient:
    def __init__(self, base_url, **kwargs):
        self.base_url = base_url
    def health_check(self):
        return True
    def store_turn(self, session_id, user, assistant, agent_name="", turn_id="", idempotency_key=""):
        store_calls.append({
            "session_id": session_id,
            "user": user,
            "assistant": assistant,
            "agent_name": agent_name,
            "turn_id": turn_id,
            "idempotency_key": idempotency_key,
        })
        return {"success": True}
    def close(self):
        pass
client_mod.DKGClient = DKGClient
sys.modules["plugins.memory.dkg.client"] = client_mod

click = types.ModuleType("click")
click.echo = lambda *args, **kwargs: None
click.argument = lambda *args, **kwargs: (lambda fn: fn)
class FakeGroup:
    def __init__(self):
        self.commands = {}
    def group(self, name):
        def decorate(fn):
            group = FakeGroup()
            self.commands[name] = group
            return group
        return decorate
    def command(self, name):
        def decorate(fn):
            self.commands[name] = fn
            return fn
        return decorate
click.Group = FakeGroup
sys.modules["click"] = click

spec = importlib.util.spec_from_file_location("plugins.memory.dkg.cli", plugin_dir / "cli.py")
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg.cli"] = module
spec.loader.exec_module(module)

root = FakeGroup()
module.register_cli(root)
root.commands["dkg"].commands["sync"]()

assert store_calls == [{
    "session_id": "session-1",
    "user": "hello",
    "assistant": "hi",
    "agent_name": "agent",
    "turn_id": "turn-123",
    "idempotency_key": "idem-123",
}], store_calls
assert saved[0][0]["queued_writes"] == [], saved
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('uses assertion-scoped reads for prefetch without requiring an agent-scoped token', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-prefetch-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
def tool_error(message):
    return json.dumps({"error": message})
registry.tool_error = tool_error
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

client = client_module.DKGClient("http://127.0.0.1:9200")
client_calls = []
def post(path, data=None):
    client_calls.append((path, data or {}))
    return {"quads": []}
client._post = post
client.query_assertion("hermes", "cg:test", "SELECT ?s ?p ?o WHERE { ?s ?p ?o }")
assert client_calls == [
    (
        "/api/assertion/hermes/query",
        {
            "contextGraphId": "cg:test",
            "sparql": "SELECT ?s ?p ?o WHERE { ?s ?p ?o }",
        },
    )
], client_calls
client.query_assertion("hermes", "cg:test")
assert client_calls[-1] == ("/api/assertion/hermes/query", {"contextGraphId": "cg:test"}), client_calls

spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

class FakeClient:
    def __init__(self):
        self.calls = []

    def query_assertion(self, assertion_name, context_graph_id, sparql=""):
        self.calls.append((assertion_name, context_graph_id, sparql))
        return {
            "quads": [
                {
                    "subject": "urn:hermes:agent:memory",
                    "predicate": "urn:hermes:content",
                    "object": "Needle fact from DKG",
                }
            ]
        }

    def query(self, *args, **kwargs):
        raise AssertionError("prefetch should use the assertion-scoped query path")

provider = module.DKGMemoryProvider()
provider._offline = False
provider._client = FakeClient()
provider._assertion_id = "hermes"
provider._context_graph = "cg:test"
text = provider.prefetch("Needle")

assert len(provider._client.calls) == 1, provider._client.calls
assert provider._client.calls[0][0] == "hermes", provider._client.calls
assert provider._client.calls[0][1] == "cg:test", provider._client.calls
assert "SELECT ?s ?p ?o" in provider._client.calls[0][2], provider._client.calls
assert "CONTAINS" in provider._client.calls[0][2], provider._client.calls
assert "Needle fact from DKG" in text, text
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('exposes the DKG V10 tool names from OpenClaw and the node skill to Hermes agents', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-tools-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
def tool_error(message):
    return json.dumps({"error": message})
registry.tool_error = tool_error
sys.modules["tools"] = tools_pkg
sys.modules["tools.registry"] = registry

constants = types.ModuleType("hermes_constants")
constants.get_hermes_home = lambda: home
sys.modules["hermes_constants"] = constants

sys.modules["plugins"] = types.ModuleType("plugins")
sys.modules["plugins.memory"] = types.ModuleType("plugins.memory")

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

provider = module.DKGMemoryProvider()
names = sorted(schema["name"] for schema in provider.get_tool_schemas())
expected_default = [
    "dkg_assertion_create",
    "dkg_assertion_discard",
    "dkg_assertion_history",
    "dkg_assertion_import_file",
    "dkg_assertion_promote",
    "dkg_assertion_query",
    "dkg_assertion_write",
    "dkg_import_artifact_read_markdown",
    "dkg_import_artifact_resolve",
    "dkg_semantic_enrichment_write",
    "dkg_context_graph_create",
    "dkg_context_graph_invite",
    "dkg_find_agents",
    "dkg_invoke_skill",
    "dkg_join_request_approve",
    "dkg_join_request_list",
    "dkg_join_request_reject",
    "dkg_list_context_graphs",
    "dkg_participant_add",
    "dkg_participant_list",
    "dkg_participant_remove",
    "dkg_publish",
    "dkg_query",
    "dkg_read_messages",
    "dkg_send_message",
    "dkg_shared_memory_publish",
    "dkg_status",
    "dkg_sub_graph_create",
    "dkg_sub_graph_list",
    "dkg_subscribe",
    "dkg_wallet_balances",
    "memory_search",
]
missing = [name for name in expected_default if name not in names]
assert missing == [], missing
subscribe_schema = next(schema for schema in provider.get_tool_schemas() if schema["name"] == "dkg_subscribe")
assert "include_shared_memory" in subscribe_schema["parameters"]["properties"], subscribe_schema
search_schema = next(schema for schema in provider.get_tool_schemas() if schema["name"] == "memory_search")
assert "context_graph_id" in search_schema["parameters"]["properties"], search_schema
assert "sub_graph_name" in search_schema["parameters"]["properties"], search_schema
assert "context_graph" not in search_schema["parameters"]["properties"], search_schema
query_schema = next(schema for schema in provider.get_tool_schemas() if schema["name"] == "dkg_query")
assert "sub_graph_name" in query_schema["parameters"]["properties"], query_schema
share_schema = next(schema for schema in provider.get_tool_schemas() if schema["name"] == "dkg_share")
assert "context_graph_id" in share_schema["parameters"]["properties"], share_schema
assert "context_graph" not in share_schema["parameters"]["properties"], share_schema
# sub_graph_name is in the schema so MCP clients can pass it portably
# (#413 — _handle_share already forwards it; the schema exposure was missing).
assert "sub_graph_name" in share_schema["parameters"]["properties"], share_schema
# context_graph_id is required on Hermes too, matching OpenClaw's contract
# (#413 unification — no implicit current-project fallback).
assert share_schema["parameters"]["required"] == ["content", "context_graph_id"], share_schema
missing_cg = provider.handle_tool_call("dkg_share", {"content": "alpha"})
assert "context_graph_id is required" in missing_cg, missing_cg
semantic_schema = next(schema for schema in provider.get_tool_schemas() if schema["name"] == "dkg_semantic_enrichment_write")
assert "name" not in semantic_schema["parameters"]["properties"], semantic_schema
assert "Append model-derived triples" in semantic_schema["description"], semantic_schema
assert "separate Working Memory assertion" not in semantic_schema["description"], semantic_schema
resolver_schema = next(schema for schema in provider.get_tool_schemas() if schema["name"] == "dkg_import_artifact_resolve")
assert "Optional validation/debug helper" in resolver_schema["description"], resolver_schema

provider._config = {
    "publish_tool": "disabled",
    "allow_direct_publish": False,
    "allow_context_graph_admin_tools": False,
}
disabled_names = sorted(schema["name"] for schema in provider.get_tool_schemas())
assert "dkg_publish" not in disabled_names, disabled_names
assert "dkg_shared_memory_publish" not in disabled_names, disabled_names
assert "dkg_context_graph_invite" not in disabled_names, disabled_names
guarded = provider.handle_tool_call("dkg_shared_memory_publish", {"context_graph_id": "cg:test"})
assert "disabled by the adapter publish guard" in guarded, guarded
admin_guarded = provider.handle_tool_call("dkg_participant_add", {"context_graph_id": "cg:test", "agent_address": "0xabc"})
assert "Context graph admin tools are disabled" in admin_guarded, admin_guarded

provider._config = {"publish_tool": "direct", "allow_direct_publish": True}
direct_schemas = provider.get_tool_schemas()
direct_names = sorted(schema["name"] for schema in direct_schemas)
for name in ["dkg_publish", "dkg_shared_memory_publish"]:
    assert name in direct_names, direct_names
publish_schema = next(schema for schema in direct_schemas if schema["name"] == "dkg_publish")
quad_props = publish_schema["parameters"]["properties"]["quads"]["items"]["properties"]
assert "graph" in quad_props, publish_schema

provider._config = {
    "publish_tool": "direct",
    "allow_direct_publish": True,
    "allow_context_graph_admin_tools": True,
}
operator_names = sorted(schema["name"] for schema in provider.get_tool_schemas())
for name in [
    "dkg_context_graph_invite",
    "dkg_participant_add",
    "dkg_participant_remove",
    "dkg_join_request_approve",
    "dkg_join_request_reject",
]:
    assert name in operator_names, operator_names
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

});
