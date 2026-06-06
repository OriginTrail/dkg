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



  it('dkg_share mints unique subjects per call, N-Triples-quotes content, and surfaces snake_case root_entities', () => {
    // Closes OriginTrail/dkg#414 — the same three SWM-write bugs PR #413
    // fixed for OpenClaw, applied to Hermes:
    //   1. Constant subject → publisher upserts and overwrites prior shares.
    //   2. Raw content → storage parser coerces to invalid IRI.
    //   3. Partial _quote_literal escaping → control bytes leak through.
    const script = String.raw`
import importlib.util
import json
import re
import sys
import tempfile
import types
from pathlib import Path

home = Path(tempfile.mkdtemp(prefix="hermes-dkg-share-hardening-"))

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
    def share(self, context_graph_id, quads, sub_graph_name=None):
        self.calls.append({
            "context_graph_id": context_graph_id,
            "quads": quads,
            "sub_graph_name": sub_graph_name,
        })
        return {"shareOperationId": f"swm-{len(self.calls)}", "triplesWritten": len(quads)}

client = CapturingClient()
provider._client = client

# Bug 1 fix — successive shares mint distinct subjects so the publisher
# does not upsert and overwrite prior facts.
r1 = json.loads(provider.handle_tool_call("dkg_share", {"content": "first fact", "context_graph_id": "cg:test"}))
r2 = json.loads(provider.handle_tool_call("dkg_share", {"content": "second fact", "context_graph_id": "cg:test"}))
subject1 = client.calls[0]["quads"][0]["subject"]
subject2 = client.calls[1]["quads"][0]["subject"]
assert subject1 != subject2, (subject1, subject2)
assert re.match(r"^urn:hermes:tester:shared:\d+-[0-9a-f]+$", subject1), subject1
assert re.match(r"^urn:hermes:tester:shared:\d+-[0-9a-f]+$", subject2), subject2

# Response shape parity with OpenClaw: subject + snake_case root_entities.
assert r1["subject"] == subject1, r1
assert r1["root_entities"] == [subject1], r1
assert r1.get("rootEntities") is None, r1
assert "shareOperationId" in r1, r1

# Bug 2 fix — content is wrapped as an N-Triples literal (quoted) before
# being handed to the daemon, not as a bare string the storage layer would
# coerce to an IRI.
obj1 = client.calls[0]["quads"][0]["object"]
assert obj1.startswith('"') and obj1.endswith('"'), obj1
assert obj1 == '"first fact"', obj1

# Bug 3 fix — _quote_literal escapes the full ECHAR set (\\, ", \\b, \\t,
# \\n, \\f, \\r) and UCHAR-encodes any other ASCII control bytes (NUL, VT,
# DEL, etc.) so a payload with mixed control characters round-trips cleanly.
r3 = json.loads(provider.handle_tool_call("dkg_share", {
    "content": "a\nb\rc\td\fe\bf \"q\" \\ end",
    "context_graph_id": "cg:test",
}))
obj_echar = client.calls[2]["quads"][0]["object"]
assert obj_echar == '"a\\nb\\rc\\td\\fe\\bf \\"q\\" \\\\ end"', obj_echar

NUL = chr(0x00)
VT = chr(0x0B)
DEL = chr(0x7F)
r4 = json.loads(provider.handle_tool_call("dkg_share", {
    "content": f"x{NUL}y{VT}z{DEL}",
    "context_graph_id": "cg:test",
}))
obj_uchar = client.calls[3]["quads"][0]["object"]
assert obj_uchar == '"x\\u0000y\\u000Bz\\u007F"', obj_uchar

# sub_graph_name still plumbs through, schema unchanged on that axis.
provider.handle_tool_call("dkg_share", {"content": "scoped", "context_graph_id": "cg:test", "sub_graph_name": "protocols"})
assert client.calls[4]["sub_graph_name"] == "protocols", client.calls[4]

# Schema parity with OpenClaw — content + context_graph_id required, sub_graph_name optional.
share_schema = next(s for s in provider.get_tool_schemas() if s["name"] == "dkg_share")
assert share_schema["parameters"]["required"] == ["content", "context_graph_id"], share_schema
assert "sub_graph_name" in share_schema["parameters"]["properties"], share_schema

# Round 1 — type validation at the runtime boundary. Malformed MCP payloads
# must surface a structured tool_error rather than crashing inside
# _quote_literal with AttributeError on .replace.
client.calls.clear()
err_obj = json.loads(provider.handle_tool_call("dkg_share", {"content": {}, "context_graph_id": "cg:test"}))
assert "error" in err_obj and "must be a string" in err_obj["error"], err_obj
err_bool = json.loads(provider.handle_tool_call("dkg_share", {"content": False, "context_graph_id": "cg:test"}))
# False also trips the "Content is required" check before the type check;
# either is acceptable as long as it's a structured error and no daemon call fired.
assert "error" in err_bool, err_bool
err_cg = json.loads(provider.handle_tool_call("dkg_share", {"content": "hello", "context_graph_id": ["cg:test"]}))
assert "error" in err_cg and ("context_graph_id" in err_cg["error"]), err_cg
err_sub = json.loads(provider.handle_tool_call("dkg_share", {"content": "hello", "context_graph_id": "cg:test", "sub_graph_name": 42}))
assert "error" in err_sub and "sub_graph_name" in err_sub["error"], err_sub
assert client.calls == [], client.calls

# Round 2 — daemon failures must pass through untouched. The Python client
# returns failure shapes ({success: False}, {ok: False}, or bare {error: ...})
# on errors (it doesn't throw), so a write that 4xx'd at the daemon would
# otherwise have synthetic subject / root_entities attached, masking the
# failure for chained publish calls. _handle_share routes through
# _client_result_failed() so all three shapes are caught the same way as
# elsewhere in the module.
class FailingClient:
    def __init__(self, failure):
        self.failure = failure
    def share(self, *args, **kwargs):
        return self.failure

for failure_shape in [
    {"success": False, "error": "context graph not registered"},
    {"ok": False, "error": "auth required"},
    {"error": "stream closed"},
]:
    provider._client = FailingClient(failure_shape)
    fail_result = json.loads(provider.handle_tool_call("dkg_share", {"content": "x", "context_graph_id": "cg:test"}))
    assert "subject" not in fail_result, (failure_shape, fail_result)
    assert "root_entities" not in fail_result, (failure_shape, fail_result)
    # Failure result must pass through untouched.
    for key, expected in failure_shape.items():
        assert fail_result.get(key) == expected, (failure_shape, fail_result)
provider._client = client
`;
    const result = spawnSync('python', ['-B', '-c', script], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

});
