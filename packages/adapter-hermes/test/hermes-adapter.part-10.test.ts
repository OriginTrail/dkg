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



  it('routes Hermes parity tools to DKG V10 daemon endpoints', () => {
    const script = String.raw`
import importlib.util
import json
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-tool-routes-"))

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
calls = []
client._post = lambda path, data=None: calls.append(("POST", path, data or {})) or {"ok": True}
client._get = lambda path: calls.append(("GET", path, {})) or {"ok": True}

bad_cg = client.create_context_graph("Bad", cg_id="Bad:Id")
assert bad_cg["success"] is False, bad_cg
client.create_context_graph("My Project", "desc")
# T-PRIVACY: client passes accessPolicy + allowedAgents through to the daemon
# verbatim when supplied, and omits them when not. The CLIENT layer does NOT
# validate address format; that's the tool handler's job — the client just
# forwards bytes to the daemon for the cases where a programmatic caller has
# already validated upstream.
client.create_context_graph("Curated", "private cg", access_policy=1)
client.create_context_graph(
    "Team",
    "shared",
    access_policy=1,
    allowed_agents=["0x" + "a" * 40, "0x" + "B" * 40],
)

# Round 3 — access_policy=True (Python bool, which is a subclass of int)
# would have silently sent JSON true to the daemon under the previous
# isinstance(access_policy, int) check; the daemon's typeof check would
# then drop the field and resolve to default-public, the opposite of a
# programmatic caller's intent. Now rejected at the client layer with a
# clear error before any daemon contact.
bool_true_result = client.create_context_graph("BoolTrue", "x", access_policy=True)
assert bool_true_result["success"] is False, bool_true_result
assert "access_policy" in bool_true_result["error"], bool_true_result
bool_false_result = client.create_context_graph("BoolFalse", "x", access_policy=False)
assert bool_false_result["success"] is False, bool_false_result
# Round 3 — only meaningful values {0, 1} accepted; other ints rejected.
out_of_range = client.create_context_graph("Two", "x", access_policy=2)
assert out_of_range["success"] is False, out_of_range
assert "0" in out_of_range["error"] and "1" in out_of_range["error"], out_of_range
# access_policy=0 is the open/discoverable value — accepted.
client.create_context_graph("OpenExplicit", "x", access_policy=0)

client.subscribe("cg:test", include_shared_memory=True)
client.write_assertion("a b", "cg:test", [{"subject": "urn:s", "predicate": "urn:p", "object": '"o"'}], "sub")
client.resolve_import_artifact("cg:test", assertion_uri="did:dkg:context-graph:cg:test/assertion/agent/imported", file_hash="sha256:" + "a" * 64, sub_graph_name="sub")
client.read_import_artifact_markdown("cg:test", assertion_uri="did:dkg:context-graph:cg:test/assertion/agent/imported", max_bytes=4096)
client.write_semantic_enrichment(
    "cg:test",
    [{"subject": "urn:doc:1", "predicate": "http://schema.org/about", "object": '"Topic"'}],
    assertion_uri="did:dkg:context-graph:cg:test/assertion/agent/imported",
    generation_method="test-model",
    agent_identity="did:dkg:agent:test",
    generated_at="2026-05-11T00:00:00.000Z",
)
client.discard_assertion("a b", "cg:test")
client.assertion_history("a b", "cg:test", agent_address="agent", sub_graph_name="sub")
client.create_sub_graph("cg:test", "notes")
client.list_sub_graphs("cg:test")
client.invite_to_context_graph("cg:test", "peer")
client.add_participant("cg:test", "agent")
client.list_join_requests("cg:test")
client.query("ASK {}", "did:dkg:context-graph:cg:test", view="shared-working-memory")
client.list_sub_graphs("did:dkg:context-graph:0xabc/tuesday-cg")
client.register_context_graph("did:dkg:context-graph:ui-refresh")

_VALID_ADDR_A = "0x" + "a" * 40
_VALID_ADDR_B = "0x" + "B" * 40

assert calls == [
    ("POST", "/api/context-graph/create", {"id": "my-project", "name": "My Project", "description": "desc"}),
    ("POST", "/api/context-graph/create", {"id": "curated", "name": "Curated", "description": "private cg", "accessPolicy": 1}),
    ("POST", "/api/context-graph/create", {"id": "team", "name": "Team", "description": "shared", "accessPolicy": 1, "allowedAgents": [_VALID_ADDR_A, _VALID_ADDR_B]}),
    ("POST", "/api/context-graph/create", {"id": "openexplicit", "name": "OpenExplicit", "description": "x", "accessPolicy": 0}),
    ("POST", "/api/context-graph/subscribe", {"contextGraphId": "cg:test", "includeSharedMemory": True}),
    ("POST", "/api/knowledge-assets/a%20b/wm/write", {"contextGraphId": "cg:test", "quads": [{"subject": "urn:s", "predicate": "urn:p", "object": '"o"'}], "subGraphName": "sub"}),
    ("POST", "/api/knowledge-assets/import-artifact/resolve", {"contextGraphId": "cg:test", "assertionUri": "did:dkg:context-graph:cg:test/assertion/agent/imported", "fileHash": "sha256:" + "a" * 64, "subGraphName": "sub"}),
    ("POST", "/api/knowledge-assets/import-artifact/read-markdown", {"contextGraphId": "cg:test", "assertionUri": "did:dkg:context-graph:cg:test/assertion/agent/imported", "maxBytes": 4096}),
    ("POST", "/api/knowledge-assets/semantic-enrichment/write", {"contextGraphId": "cg:test", "semanticQuads": [{"subject": "urn:doc:1", "predicate": "http://schema.org/about", "object": '"Topic"'}], "assertionUri": "did:dkg:context-graph:cg:test/assertion/agent/imported", "generationMethod": "test-model", "agentIdentity": "did:dkg:agent:test", "generatedAt": "2026-05-11T00:00:00.000Z"}),
    ("POST", "/api/knowledge-assets/a%20b/wm/discard", {"contextGraphId": "cg:test"}),
    ("GET", "/api/knowledge-assets/a%20b?contextGraphId=cg%3Atest&agentAddress=agent&subGraphName=sub", {}),
    ("POST", "/api/sub-graph/create", {"contextGraphId": "cg:test", "subGraphName": "notes"}),
    ("GET", "/api/sub-graph/list?contextGraphId=cg%3Atest", {}),
    ("POST", "/api/context-graph/invite", {"contextGraphId": "cg:test", "peerId": "peer"}),
    ("POST", "/api/context-graph/cg%3Atest/add-participant", {"agentAddress": "agent"}),
    ("GET", "/api/context-graph/cg%3Atest/join-requests", {}),
    ("POST", "/api/query", {"sparql": "ASK {}", "contextGraphId": "cg:test", "view": "shared-working-memory"}),
    ("GET", "/api/sub-graph/list?contextGraphId=0xabc%2Ftuesday-cg", {}),
    ("POST", "/api/context-graph/register", {"id": "ui-refresh"}),
], calls

client_identity = client_module.DKGClient("http://127.0.0.1:9200")
def fake_get(path):
    if path == "/api/agent/identity":
        return {"peerId": "peer-from-identity"}
    raise AssertionError(path)
client_identity._get = fake_get
assert client_identity._resolve_agent_address() == "peer-from-identity"
assert client_identity._agent_identity_loaded is False

client_status = client_module.DKGClient("http://127.0.0.1:9200")
def fake_status_get(path):
    if path == "/api/agent/identity":
        return {"success": False}
    if path == "/api/status":
        return {"peerId": "peer-from-status"}
    raise AssertionError(path)
client_status._get = fake_status_get
assert client_status._resolve_agent_address() == "peer-from-status"
assert client_status._agent_identity_loaded is False

client_retry = client_module.DKGClient("http://127.0.0.1:9200")
retry_calls = {"count": 0}
def fake_retry_get(path):
    retry_calls["count"] += 1
    if retry_calls["count"] <= 2:
        return {"success": False}
    if path == "/api/agent/identity":
        return {"peerId": "peer-after-retry"}
    raise AssertionError(path)
client_retry._get = fake_retry_get
assert client_retry._resolve_agent_address() is None
assert client_retry._agent_identity_loaded is False
assert client_retry._resolve_agent_address() == "peer-after-retry"
assert client_retry._agent_identity_loaded is False

client_agent_later = client_module.DKGClient("http://127.0.0.1:9200")
later_calls = {"count": 0}
def fake_later_get(path):
    later_calls["count"] += 1
    if path == "/api/agent/identity" and later_calls["count"] == 1:
        return {"peerId": "peer-before-agent"}
    if path == "/api/agent/identity":
        return {"agentAddress": "0xAgent"}
    raise AssertionError(path)
client_agent_later._get = fake_later_get
assert client_agent_later._resolve_agent_address() == "peer-before-agent"
assert client_agent_later._agent_identity_loaded is False
assert client_agent_later._resolve_agent_address() == "0xAgent"
assert client_agent_later._agent_identity_loaded is True
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

});
