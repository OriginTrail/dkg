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



  it('uploads Hermes assertion imports as safe multipart requests', () => {
    const script = String.raw`
import importlib.util
import os
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-import-"))
plugin_dir = Path(r"${process.cwd().replace(/\\/g, '\\\\')}") / "hermes-plugin"
client_spec = importlib.util.spec_from_file_location(
    "plugins.memory.dkg.client",
    plugin_dir / "client.py",
)
client_module = importlib.util.module_from_spec(client_spec)
sys.modules["plugins.memory.dkg.client"] = client_module
client_spec.loader.exec_module(client_module)

safe_file = home / "notes.md"
safe_file.write_text("# Notes", encoding="utf-8")
outside_file = Path(tempfile.mkdtemp(prefix="hermes-dkg-import-outside-")) / "notes.md"
outside_file.write_text("# Outside", encoding="utf-8")
symlink_file = home / "linked-outside.md"
try:
    os.symlink(outside_file, symlink_file)
except (AttributeError, NotImplementedError, OSError):
    symlink_file = None
blocked_dir = home / ".dkg"
blocked_dir.mkdir()
blocked_file = blocked_dir / "auth.token"
blocked_file.write_text("secret", encoding="utf-8")
ssh_dir = home / ".ssh"
ssh_dir.mkdir()
ssh_key = ssh_dir / "id_rsa"
ssh_key.write_text("secret", encoding="utf-8")

calls = []
class FakeResponse:
    def raise_for_status(self):
        pass
    def json(self):
        return {"success": True}

def fake_post(url, data=None, files=None, headers=None, timeout=None):
    calls.append({
        "url": url,
        "data": data,
        "files": files,
        "headers": headers,
        "timeout": timeout,
    })
    return FakeResponse()

requests_module = types.ModuleType("requests")
requests_module.post = fake_post
sys.modules["requests"] = requests_module

client = client_module.DKGClient("http://127.0.0.1:9200", import_roots=[str(home)])
client._token = "secret-token"
result = client.import_assertion_file("assertion name", "cg:test", str(safe_file), sub_graph_name="sub")
assert result == {"success": True}, result
assert len(calls) == 1, calls
call = calls[0]
assert call["url"].endswith("/api/knowledge-assets/assertion%20name/wm/import-file"), call
assert call["data"] == {"contextGraphId": "cg:test", "subGraphName": "sub"}, call
assert call["headers"] == {"Accept": "application/json", "Authorization": "Bearer secret-token"}, call
file_tuple = call["files"]["file"]
assert file_tuple[0] == "notes.md", file_tuple
assert file_tuple[2] == "text/markdown", file_tuple

blocked = client.import_assertion_file("assertion", "cg:test", str(blocked_file))
assert blocked["success"] is False, blocked
assert "Refusing to import" in blocked["error"], blocked
blocked_ssh = client.import_assertion_file("assertion", "cg:test", str(ssh_key))
assert blocked_ssh["success"] is False, blocked_ssh
assert "Refusing to import" in blocked_ssh["error"], blocked_ssh
outside = client.import_assertion_file("assertion", "cg:test", str(outside_file))
assert outside["success"] is False, outside
assert "safe roots" in outside["error"], outside
if symlink_file is not None:
    symlinked = client.import_assertion_file("assertion", "cg:test", str(symlink_file))
    assert symlinked["success"] is False, symlinked
    assert "safe roots" in symlinked["error"], symlinked
client_without_roots = client_module.DKGClient("http://127.0.0.1:9200", import_roots=[])
no_roots = client_without_roots.import_assertion_file("assertion", "cg:test", str(safe_file))
assert no_roots["success"] is False, no_roots
assert "safe roots" in no_roots["error"], no_roots
assert len(calls) == 1, calls
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('flushes queued memory writes without reapplying them to the local cache', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-queue-"))

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
        self.writes = []

    def write_assertion(self, assertion_name, context_graph_id, quads):
        self.writes.append((assertion_name, context_graph_id, quads))
        return {"success": True}

provider = module.DKGMemoryProvider()
provider._client = FakeClient()
provider._offline = False
provider._assertion_id = "hermes"
provider._context_graph = "cg:test"
provider._agent_name = "agent"
provider._cache = {
    "memory": [{"target": "memory", "content": "cached fact"}],
    "queued_writes": [{"type": "memory", "action": "add", "target": "memory", "content": "cached fact"}],
}

provider._flush_queued_writes()

assert provider._cache["memory"] == [{"target": "memory", "content": "cached fact"}], provider._cache
assert provider._cache["queued_writes"] == [], provider._cache
assert len(provider._client.writes) == 1, provider._client.writes
assert provider._client.writes[0][2] == [{
    "subject": "urn:hermes:agent:memory",
    "predicate": "urn:hermes:content",
    "object": module._quote_literal("[memory]\ncached fact"),
}], provider._client.writes

provider._cache = {"memory": [], "queued_writes": []}
result = json.loads(provider._handle_memory({"action": "add", "target": "memory", "content": "live fact"}))
assert result["store"] == "dkg", result
assert result["queued"] is False, result
assert provider._client.writes[-1][2] == [{
    "subject": "urn:hermes:agent:memory",
    "predicate": "urn:hermes:content",
    "object": module._quote_literal("[memory]\nlive fact"),
}], provider._client.writes

class FailingClient:
    def write_assertion(self, assertion_name, context_graph_id, quads):
        return {"success": False, "error": "bad literal"}

provider._client = FailingClient()
provider._cache = {"memory": [], "queued_writes": []}
result = json.loads(provider._handle_memory({"action": "add", "target": "memory", "content": "queued fact"}))
assert result["store"] == "local_cache", result
assert result["queued"] is True, result
assert provider._cache["queued_writes"] == [{
    "type": "memory",
    "action": "add",
    "target": "memory",
    "content": "queued fact",
    "old_text": "",
}], provider._cache

provider._assertion_id = ""
provider._cache["queued_writes"] = [{"type": "memory", "action": "replace", "target": "memory", "content": "new fact", "old_text": "cached"}]
provider._flush_queued_writes()
assert provider._cache["queued_writes"] == [{"type": "memory", "action": "replace", "target": "memory", "content": "new fact", "old_text": "cached"}], provider._cache
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it('dkg_context_graph_create handler defaults to curated and forwards public + allowed_agents', () => {
    // Privacy-by-default flip in Hermes parity:
    //
    // - No `public` and no `allowed_agents` → handler sends accessPolicy: 1
    //   (curated). The agent's createContextGraph flow auto-includes the
    //   creator in DKG_ALLOWED_AGENT (see packages/agent/src/dkg-agent.ts:3962),
    //   so the creator can immediately read/write without a self-invite.
    // - `public: true` → handler drops accessPolicy (daemon resolves to open)
    //   AND drops allowed_agents even if supplied (meaningless on a public CG).
    // - `allowed_agents: [...]` (no `public`) → handler sends accessPolicy: 1
    //   AND allowedAgents.
    // - Whitespace-only / empty / non-string entries in allowed_agents are
    //   filtered out before forwarding.
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-create-cg-defaults-"))

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

class FakeClient:
    def __init__(self):
        self.calls = []
    def create_context_graph(self, name, description="", cg_id=None, *, access_policy=None, allowed_agents=None):
        self.calls.append({
            "name": name,
            "description": description,
            "cg_id": cg_id,
            "access_policy": access_policy,
            "allowed_agents": allowed_agents,
        })
        return {"created": cg_id or name, "uri": f"did:dkg:context-graph:{cg_id or name}"}

client = FakeClient()
provider._client = client

VALID_A = "0x" + "a" * 40
VALID_B = "0x" + "B" * 40

# Default - no public, no allowed_agents -> curated.
provider._handle_create_cg({"name": "Default", "id": "default"})
# Explicit public - accessPolicy dropped, allowed_agents ignored even if
# malformed (validation only runs when public is false, so public CGs never
# raise on bad allowlist content).
provider._handle_create_cg({"name": "Open", "id": "open", "public": True, "allowed_agents": ["not-an-address"]})
# Curated with explicit allowlist (valid 40-hex addresses).
provider._handle_create_cg({"name": "Team", "id": "team", "allowed_agents": [VALID_A, VALID_B]})
# Curated with whitespace-padded valid entries — trimmed but kept.
provider._handle_create_cg({"name": "Trim", "id": "trim", "allowed_agents": [f"  {VALID_A}  ", VALID_B]})
# Round 1 — invalid address must surface as a tool error and NOT call client.
err = json.loads(provider._handle_create_cg({"name": "Bad", "id": "bad", "allowed_agents": [VALID_A, "not-an-address"]}))
assert "error" in err and "Invalid Ethereum address" in err["error"], err
assert "not-an-address" in err["error"], err
# Round 1 — too-short hex value also rejected.
err2 = json.loads(provider._handle_create_cg({"name": "Short", "id": "short", "allowed_agents": ["0xabc"]}))
assert "error" in err2 and "Invalid Ethereum address" in err2["error"], err2

# Round 2 — fail-fast on non-string entries instead of silently dropping
# them. LLMs occasionally emit numbers / dicts / nulls in tool args; if we
# silently drop them, the agent thinks the participant was added when it
# wasn't. Fail with a precise index-scoped error so the agent can correct.
err3 = json.loads(provider._handle_create_cg({"name": "Mixed", "id": "mixed", "allowed_agents": [VALID_A, 42, VALID_B]}))
assert "error" in err3 and "allowed_agents[1]" in err3["error"] and "must be a string" in err3["error"], err3

# Round 2 — fail-fast on empty / whitespace-only entries.
err4 = json.loads(provider._handle_create_cg({"name": "Empty", "id": "empty", "allowed_agents": [VALID_A, "   "]}))
assert "error" in err4 and "allowed_agents[1]" in err4["error"] and ("empty" in err4["error"] or "whitespace" in err4["error"]), err4

# Round 2 — fail-fast on null entries.
err5 = json.loads(provider._handle_create_cg({"name": "Null", "id": "null", "allowed_agents": [VALID_A, None]}))
assert "error" in err5 and "allowed_agents[1]" in err5["error"], err5

# Round 2 — non-list allowed_agents (e.g. dict, string) rejected.
err6 = json.loads(provider._handle_create_cg({"name": "NotList", "id": "notlist", "allowed_agents": "0x1234"}))
assert "error" in err6 and "must be an array" in err6["error"], err6

# Round 2 — non-boolean public rejected (string "yes" should NOT silently
# fall back to curated; the agent gets a clear error).
err7 = json.loads(provider._handle_create_cg({"name": "Yes", "id": "yes", "public": "yes"}))
assert "error" in err7 and "public" in err7["error"] and "boolean" in err7["error"], err7

# Round 2 — non-boolean public rejected (number 1 should NOT be coerced).
err8 = json.loads(provider._handle_create_cg({"name": "One", "id": "one", "public": 1}))
assert "error" in err8 and "public" in err8["error"], err8

assert client.calls[0] == {
    "name": "Default", "description": "", "cg_id": "default",
    "access_policy": 1, "allowed_agents": None,
}, client.calls[0]
assert client.calls[1] == {
    "name": "Open", "description": "", "cg_id": "open",
    "access_policy": None, "allowed_agents": None,
}, client.calls[1]
assert client.calls[2] == {
    "name": "Team", "description": "", "cg_id": "team",
    "access_policy": 1, "allowed_agents": [VALID_A, VALID_B],
}, client.calls[2]
assert client.calls[3] == {
    "name": "Trim", "description": "", "cg_id": "trim",
    "access_policy": 1, "allowed_agents": [VALID_A, VALID_B],
}, client.calls[3]
# All round-1 + round-2 failure paths must NOT have hit the client —
# pre-flight validation.
assert len(client.calls) == 4, client.calls
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

});
