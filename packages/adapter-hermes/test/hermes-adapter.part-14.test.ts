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



  it('[D3] dkg_knowledge_asset_create writes + seals quads in one call and shares on also_share_swm', () => {
    // The one-call create+write(+share) shortcut (api-agent-tooling cleanup D3):
    //   - quads supplied -> daemon writes + SEALS in this call (finalize default-true);
    //   - also_share_swm=true -> daemon ALSO shares the sealed asset to SWM;
    //   - also_share_swm WITHOUT quads is IGNORED (nothing to seal/share -> plain draft, no error).
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-create-d3-"))

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
sys.modules["plugins.memory.dkg"] = types.ModuleType("plugins.memory.dkg")

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
provider._offline = False
provider._agent_name = "tester"

class CapturingClient:
    def __init__(self):
        self.calls = []
    def create_assertion(self, context_graph_id, name, sub_graph_name=None, quads=None, also_share_swm=False):
        self.calls.append({
            "context_graph_id": context_graph_id,
            "name": name,
            "sub_graph_name": sub_graph_name,
            "quads": quads,
            "also_share_swm": also_share_swm,
        })
        return {"assertionUri": f"urn:ka:{name}", "sealed": bool(quads), "swmShared": bool(also_share_swm)}

client = CapturingClient()
provider._client = client

# Bare create (no quads) stays a primitive: quads None, no share.
provider.handle_tool_call("dkg_knowledge_asset_create", {"context_graph_id": "cg:test", "name": "empty"})
assert client.calls[0]["quads"] is None, client.calls[0]
assert client.calls[0]["also_share_swm"] is False, client.calls[0]

# Create + write quads (one call). The handler normalizes quads exactly like
# dkg_knowledge_asset_write: a plain-literal object is N-Triples-quoted, a URI
# object passes through unquoted, and any per-quad graph slot is dropped.
r_quads = json.loads(provider.handle_tool_call("dkg_knowledge_asset_create", {
    "context_graph_id": "cg:test",
    "name": "withquads",
    "quads": [
        {"subject": "urn:s", "predicate": "urn:p", "object": "o", "graph": "urn:g"},
        {"subject": "urn:s", "predicate": "urn:p2", "object": "urn:uri-object"},
    ],
}))
assert client.calls[1]["quads"] == [
    {"subject": "urn:s", "predicate": "urn:p", "object": '"o"'},
    {"subject": "urn:s", "predicate": "urn:p2", "object": "urn:uri-object"},
], client.calls[1]
assert client.calls[1]["also_share_swm"] is False, client.calls[1]
assert r_quads["sealed"] is True, r_quads

# Create + write + share to SWM (one call).
r_share = json.loads(provider.handle_tool_call("dkg_knowledge_asset_create", {
    "context_graph_id": "cg:test",
    "name": "shared",
    "quads": [{"subject": "urn:s2", "predicate": "urn:p", "object": "o2"}],
    "also_share_swm": True,
}))
assert client.calls[2]["quads"] == [{"subject": "urn:s2", "predicate": "urn:p", "object": '"o2"'}], client.calls[2]
assert client.calls[2]["also_share_swm"] is True, client.calls[2]
assert r_share["swmShared"] is True, r_share

# also_share_swm WITHOUT quads is IGNORED (parity with MCP + OpenClaw / plan
# §2.6): no error, a plain create fires with no quads, and the client never
# emits alsoShareSwm to the wire (covered at the wire level in
# test_no_per_quad_graph.py::test_create_without_quads_never_sends_also_share_swm).
calls_before = len(client.calls)
ignored = json.loads(provider.handle_tool_call("dkg_knowledge_asset_create", {
    "context_graph_id": "cg:test",
    "name": "ignoredshare",
    "also_share_swm": True,
}))
assert "error" not in ignored, ignored
assert len(client.calls) == calls_before + 1, client.calls
assert client.calls[-1]["quads"] is None, client.calls[-1]

# also_share_swm must be a boolean.
err_type = json.loads(provider.handle_tool_call("dkg_knowledge_asset_create", {
    "context_graph_id": "cg:test",
    "name": "badtype",
    "quads": [{"subject": "urn:s", "predicate": "urn:p", "object": "o"}],
    "also_share_swm": "yes",
}))
assert "error" in err_type and "also_share_swm must be a boolean" in err_type["error"], err_type

# Schema exposes the new optional params; required is unchanged.
create_schema = next(s for s in provider.get_tool_schemas() if s["name"] == "dkg_knowledge_asset_create")
assert "quads" in create_schema["parameters"]["properties"], create_schema
assert "also_share_swm" in create_schema["parameters"]["properties"], create_schema
assert create_schema["parameters"]["required"] == ["context_graph_id", "name"], create_schema
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

});
