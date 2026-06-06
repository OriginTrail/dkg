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



  it('keeps generated Hermes DKG session IDs within the Node UI reader limit', () => {
    const script = String.raw`
import importlib.util
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-session-id-"))

agent_pkg = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
class MemoryProvider:
    pass
memory_provider.MemoryProvider = MemoryProvider
sys.modules["agent"] = agent_pkg
sys.modules["agent.memory_provider"] = memory_provider

tools_pkg = types.ModuleType("tools")
registry = types.ModuleType("tools.registry")
registry.tool_error = lambda message: message
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

session_id = module._scoped_session_id(
    "session-" + ("x" * 200),
    {"profile_name": "Profile " + ("y" * 200)},
)
assert session_id.startswith("hermes:dkg:profile-profile-"), session_id
assert len(session_id) <= 128, (len(session_id), session_id)
assert module._scoped_session_id("hermes:dkg:already-scoped", {"profile_name": "ignored"}) == "hermes:dkg:already-scoped"
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('returns SKILL-shaped Hermes memory_search hits across agent and project layers', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-memory-search-"))

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

class FakeClient:
    def __init__(self):
        self.calls = []

    def _resolve_agent_address(self):
        return "0xAgent"

    def query(self, sparql, context_graph_id, **kwargs):
        self.calls.append((context_graph_id, kwargs))
        return {
            "result": {
                "bindings": [{
                    "uri": {"value": f"urn:{context_graph_id}:{kwargs['view']}"},
                    "pred": {"value": "schema:description"},
                    "text": {"value": f"alpha beta from {context_graph_id} {kwargs['view']}"},
                }],
            },
        }

provider = module.DKGMemoryProvider()
provider._offline = False
provider._client = FakeClient()
provider._context_graph = "project-cg"
provider._cache = {}

result = json.loads(provider.handle_tool_call("memory_search", {"query": "alpha beta", "limit": 10}))
assert result["query"] == "alpha beta", result
assert result["scope"] == "project-cg", result
assert result["count"] == 6, result
layers = [hit["layer"] for hit in result["hits"]]
assert set(layers) == {
    "agent-context-wm",
    "agent-context-swm",
    "agent-context-vm",
    "project-wm",
    "project-swm",
    "project-vm",
}, layers
assert layers[:2] == ["agent-context-vm", "project-vm"], layers
assert {hit["source"] for hit in result["hits"] if hit["layer"].startswith("agent-context")} == {"sessions"}, result
assert {hit["source"] for hit in result["hits"] if hit["layer"].startswith("project")} == {"memory"}, result
assert all(hit["score"] == 1.0 for hit in result["hits"]), result
assert all("_rank" not in hit for hit in result["hits"]), result
assert provider._client.calls == [
    ("agent-context", {"view": "working-memory", "agent_address": "0xAgent"}),
    ("agent-context", {"view": "shared-working-memory", "agent_address": None}),
    ("agent-context", {"view": "verified-memory", "agent_address": None}),
    ("project-cg", {"view": "working-memory", "agent_address": "0xAgent"}),
    ("project-cg", {"view": "shared-working-memory", "agent_address": None}),
    ("project-cg", {"view": "verified-memory", "agent_address": None}),
], provider._client.calls
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('uses Hermes client peer fallback for memory_search working-memory queries', () => {
    const script = String.raw`
import importlib
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-memory-search-peer-"))

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

client_module = importlib.import_module("plugins.memory.dkg.client")
client = client_module.DKGClient("http://127.0.0.1:9200")
calls = []
queries = []
def fake_get(path):
    calls.append(path)
    if path == "/api/agent/identity":
        return {"success": False}
    if path == "/api/status":
        return {"peerId": "peer-from-status"}
    raise AssertionError(path)
def fake_query(sparql, context_graph_id, **kwargs):
    queries.append((context_graph_id, kwargs))
    return {"result": {"bindings": []}}
client._get = fake_get
client.query = fake_query

provider = module.DKGMemoryProvider()
provider._offline = False
provider._client = client
provider._context_graph = "agent-context"
provider._cache = {}

result = json.loads(provider.handle_tool_call("memory_search", {"query": "alpha", "limit": 5}))
assert result == {"query": "alpha", "count": 0, "scope": None, "hits": []}, result
assert calls == ["/api/agent/identity", "/api/status"], calls
assert queries[0] == ("agent-context", {"view": "working-memory", "agent_address": "peer-from-status"}), queries
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('does not return stale cache hits for online DKG memory_search no-hit responses', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-memory-search-empty-"))

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
spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg",
    plugin_dir / "__init__.py",
    submodule_search_locations=[str(plugin_dir)],
)
module = importlib.util.module_from_spec(spec)
sys.modules["plugins.memory.dkg"] = module
spec.loader.exec_module(module)

class EmptyClient:
    def _resolve_agent_address(self):
        return "0xAgent"

    def query(self, sparql, context_graph_id, **kwargs):
        return {"result": {"bindings": []}}

provider = module.DKGMemoryProvider()
provider._offline = False
provider._client = EmptyClient()
provider._context_graph = "project-cg"
provider._cache = {"memory": [{"target": "memory", "content": "alpha stale cache"}]}

online = json.loads(provider.handle_tool_call("memory_search", {"query": "alpha", "limit": 5}))
assert online == {"query": "alpha", "count": 0, "scope": "project-cg", "hits": []}, online

provider._offline = True
offline = json.loads(provider.handle_tool_call("memory_search", {"query": "alpha", "limit": 5}))
assert offline["offline"] is True and offline["count"] == 1, offline
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('loads Hermes Python client auth from setup-resolved DKG home', () => {
    const script = String.raw`
import importlib.util
import os
import tempfile
from pathlib import Path

root = Path(tempfile.mkdtemp(prefix="hermes-dkg-home-"))
default_home = root / "user-home"
default_dkg_home = default_home / ".dkg"
resolved_dkg_home = root / ".dkg-dev"
default_dkg_home.mkdir(parents=True)
resolved_dkg_home.mkdir(parents=True)
(default_dkg_home / "auth.token").write_text("stale-token\n", encoding="utf-8")
(resolved_dkg_home / "auth.token").write_text("# comment\nlive-token\n", encoding="utf-8")

os.environ["HOME"] = str(default_home)
os.environ["USERPROFILE"] = str(default_home)
os.environ.pop("DKG_HOME", None)

plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
spec = importlib.util.spec_from_file_location("dkg_client", plugin_dir / "client.py")
client_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client_module)

client = client_module.DKGClient("http://127.0.0.1:9200", dkg_home=str(resolved_dkg_home))
assert client._token == "live-token", client._token

os.environ["DKG_AUTH_TOKEN"] = "env-override-token"
env_override_client = client_module.DKGClient("http://127.0.0.1:9200", dkg_home=str(resolved_dkg_home))
assert env_override_client._token == "env-override-token", env_override_client._token
os.environ.pop("DKG_AUTH_TOKEN", None)

env_dkg_home = root / "env-dkg"
env_dkg_home.mkdir()
(env_dkg_home / "auth.token").write_text("env-token\n", encoding="utf-8")
os.environ["DKG_HOME"] = str(env_dkg_home)
env_client = client_module.DKGClient("http://127.0.0.1:9200")
assert env_client._token == "env-token", env_client._token
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

});
