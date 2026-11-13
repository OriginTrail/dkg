"""Search across assets (read-graph settings): the Hermes tools, their client calls and their wording."""
import importlib
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

SETTINGS = {
    "policy": {"enabled": True, "layers": ["verifiable-memory", "shared-working-memory", "working-memory"]},
    "contextGraphs": [{
        "contextGraphId": "team",
        "layers": {"verifiable-memory": "build"},
        "effective": {"layers": {"verifiable-memory": "build", "shared-working-memory": "off", "working-memory": "serve"}, "viewSemantics": "per-asset"},
        "readGraphs": [
            {"readGraph": "urn:rg:1", "contextGraphId": "team", "layer": "vm", "state": "ready", "generation": 1},
            {"readGraph": "urn:rg:2", "contextGraphId": "team", "layer": "wm", "state": "ready", "generation": 1},
            {"readGraph": "urn:rg:3", "contextGraphId": "team", "layer": "wm", "state": "rebuilding", "generation": 2},
            "not a read graph",
        ],
    }],
}
SUMMARY = "\n".join([
    "Search across assets in team:",
    "- Published assets: Preview: Ready to turn on",
    "- Shared memory, shared with your team: Off",
    "- Private drafts: On: 1 In use, 1 Rebuilding",
    "- Queries search across assets by default: Off, each asset is searched on its own.",
])


@pytest.fixture
def wording(plugin_module):
    return importlib.import_module(plugin_module.__name__ + ".read_graphs")


@pytest.fixture
def client_class(plugin_module):
    return importlib.import_module(plugin_module.__name__ + ".client").DKGClient


@pytest.fixture
def send(provider_factory, client_class, monkeypatch):
    mock = Mock(return_value=SETTINGS)
    monkeypatch.setattr(client_class, "_send", mock)
    return mock


# -- Wording, matching dkg-core's read-graph-settings module ---------------------

def test_settings_in_plain_words(wording):
    assert wording.describe_settings(SETTINGS) == SUMMARY


def test_settings_say_what_the_node_keeps_and_why(wording):
    answer = {
        "policy": {"enabled": False, "layers": ["verifiable-memory"]},
        "refused": {"code": "READ_GRAPHS_UNSUPPORTED", "error": "This store cannot keep a combined copy."},
        "contextGraphs": [{
            "contextGraphId": "team",
            "layers": {"verifiable-memory": "serve", "working-memory": "build"},
            "effective": {"layers": {"verifiable-memory": "off", "shared-working-memory": "off", "working-memory": "off"}},
            "viewSemantics": "merged",
        }, None],
    }
    assert wording.describe_settings(answer).split("\n") == [
        "Search across assets is switched off for this whole node.",
        "This node can't turn search across assets on: This store cannot keep a combined copy. (READ_GRAPHS_UNSUPPORTED)",
        "Search across assets in team:",
        "- Published assets: Off (set to On, but this node keeps it Off)",
        "- Shared memory, shared with your team: Off",
        "- Private drafts: Off (set to Preview, but this node does not allow it)",
        "- Queries search across assets by default: On.",
    ]


def test_settings_with_rows_only_and_unknown_states(wording):
    answer = {"refused": {}, "contextGraphs": [{"contextGraphId": "solo", "layers": {"verifiable-memory": "serve"}, "readGraphs": [{"layer": "verifiable-memory", "state": "paused"}]}]}
    assert wording.describe_settings(answer).split("\n") == [
        "This node can't turn search across assets on: no reason given",
        "Search across assets in solo:",
        "- Published assets: On: paused",
        "- Shared memory, shared with your team: not set",
        "- Private drafts: not set",
    ]
    assert "- Published assets: Preview: Getting ready" in wording.describe_settings({"contextGraphs": [{"contextGraphId": "new", "layers": {"verifiable-memory": "build"}, "readGraphs": [{"layer": 7, "state": "x"}, {"layer": "vm", "state": "building"}]}]})
    for empty in (None, {"contextGraphs": []}, {"policy": [], "contextGraphs": "none"}):
        assert wording.describe_settings(empty) == "No context graph has search across assets set up."


def test_settings_show_the_nodes_own_default(wording):
    answer = {"node": {"layers": {"verifiable-memory": "build", "shared-working-memory": "off", "working-memory": "serve"}, "viewSemantics": "merged"}, "contextGraphs": []}
    assert wording.describe_settings(answer).split("\n") == [
        "This node's default: Published assets: Preview · Shared memory, shared with your team: Off · Private drafts: On · Queries search across assets: On.",
        "No context graph has search across assets set up.",
    ]
    assert wording.describe_settings({"node": {"layers": {"verifiable-memory": "off"}, "viewSemantics": "per-asset"}, "contextGraphs": []}).split("\n")[0] == (
        "This node's default: Published assets: Off · Shared memory, shared with your team: not set · Private drafts: not set · Queries search across assets: Off."
    )
    assert wording.describe_settings({"node": {"layers": {"verifiable-memory": "off"}}, "contextGraphs": []}).split("\n")[0] == (
        "This node's default: Published assets: Off · Shared memory, shared with your team: not set · Private drafts: not set."
    )
    assert wording.describe_settings({"node": {}, "contextGraphs": []}) == "No context graph has search across assets set up."


def test_settings_say_how_far_the_copy_being_built_is(wording):
    answer = {"contextGraphs": [{
        "contextGraphId": "team",
        "effective": {"layers": {"verifiable-memory": "build", "shared-working-memory": "serve", "working-memory": "build"}},
        "readGraphs": [
            {"layer": "vm", "state": "building", "progress": 0.405},
            {"layer": "swm", "state": "building", "progress": 0},
            {"layer": "swm", "state": "ready"},
            {"layer": "wm", "state": "building", "progress": 1.5},
        ],
    }]}
    assert wording.describe_settings(answer).split("\n")[1:] == [
        "- Published assets: Preview: Getting ready 41%",
        "- Shared memory, shared with your team: On: 1 Getting ready 0%, 1 In use",
        "- Private drafts: Preview: Getting ready",
    ]


def test_settings_add_the_assets_and_facts_only_when_every_copy_reports_them(wording):
    def copy(layer, name, **extra):
        return {"readGraph": name, "layer": layer, "state": "ready", **extra}
    answer = {"contextGraphs": [{
        "contextGraphId": "team",
        "effective": {"layers": {"verifiable-memory": "serve", "shared-working-memory": "build", "working-memory": "build"}},
        "readGraphs": [
            copy("vm", "urn:a", members=12000, triples=1200000), copy("vm", "urn:b", members=400, triples=48000),
            copy("swm", "urn:c", members=1, triples=1),
            copy("wm", "urn:e", members=-1, triples=10), copy("wm", "urn:f", members=True),
        ],
    }, {
        "contextGraphId": "empty",
        "layers": {"verifiable-memory": "off", "working-memory": "build"},
        "effective": {"layers": {"verifiable-memory": "off", "shared-working-memory": "off", "working-memory": "build"}},
        "readGraphs": [copy("vm", "urn:g", members=5, triples=50), copy("wm", "urn:h", members=0, triples=0)],
    }]}
    assert wording.describe_settings(answer).split("\n") == [
        "Search across assets in team:",
        "- Published assets · 12,400 assets: On: In use. About 1,248,000 facts, at its last build",
        "- Shared memory, shared with your team · 1 asset: Preview: Ready to turn on. About 1 fact, at its last build",
        "- Private drafts: Preview: Ready to turn on",
        "Search across assets in empty:",
        "- Published assets: Off",
        "- Shared memory, shared with your team: Off",
        "- Private drafts · 0 assets: Preview: Ready to turn on. About 0 facts, at its last build",
    ]


def test_settings_count_a_memory_from_its_whole_copies(wording):
    def copy(layer, name, **extra):
        return {"readGraph": name, "layer": layer, "state": "ready", **extra}
    answer = {"contextGraphs": [{
        "contextGraphId": "team",
        "effective": {"layers": {"verifiable-memory": "serve", "shared-working-memory": "build", "working-memory": "build"}},
        "readGraphs": [
            # One asset, in the registered sub-graph `code`: the whole copy and the sub-graph's copy both hold it.
            copy("vm", "urn:vm", members=1, triples=20),
            copy("vm", "urn:vm:code", subGraphName="code", members=1, triples=20),
            # A count stays unknown while the whole copy lacks it, whatever the sub-graph's copy says.
            copy("swm", "urn:swm"),
            copy("swm", "urn:swm:code", subGraphName="code", members=1, triples=2),
            # Each agent's drafts are its own, so the agents' whole copies add up. States still come from every copy.
            copy("wm", "urn:wm:a", agentAddress="0xa", members=2, triples=6),
            copy("wm", "urn:wm:b", agentAddress="0xb", members=3, triples=9),
            copy("wm", "urn:wm:a:code", agentAddress="0xa", subGraphName="code", state="building", members=2, triples=6),
        ],
    }]}
    assert wording.describe_settings(answer).split("\n")[1:] == [
        "- Published assets · 1 asset: On: In use. About 20 facts, at its last build",
        "- Shared memory, shared with your team: Preview: Ready to turn on",
        "- Private drafts · 5 assets: Preview: 2 Ready to turn on, 1 Getting ready. About 15 facts, at its last build",
    ]


def test_changes_in_plain_words(wording):
    def change(layer, frm, to, outcome, cg="my-project"):
        return {"contextGraphId": cg, "layer": layer, "from": frm, "to": to, "outcome": outcome}
    answer = {"changes": [
        change("verifiable-memory", "off", "build", "applied"),
        change("shared-working-memory", "build", "serve", "applied"),
        change("working-memory", "serve", "build", "applied"),
        change("vm", "serve", "off", "applied"),
        change("swm", "serve", "serve", "unchanged"),
        change("wm", "off", "serve", {"refused": "Turn Preview on first."}),
        change("verifiable-memory", "off", "serve", {"refused": {"code": "X", "error": "No."}}),
        change("wm", "serve", "off", {"refused": 7}, 3),
        change("wm", "serve", "off", "odd"),
        change("vm", "off", "sideways", "applied"),
    ]}
    request = {"contextGraphId": "my-project", "layers": {"shared-working-memory": "serve"}}
    assert wording.describe_changes(answer, request).split("\n") == [
        "Getting search across assets ready for my-project's published assets. Preview shows how results would change before it is turned on.",
        "Turned search across assets on for my-project's shared memory.",
        "Search across assets is back to Preview for my-project's private drafts: queries no longer search across them, and the combined copy stays up to date.",
        "Turned search across assets off for my-project's published assets; its combined copy is removed.",
        "Search across assets was already On for my-project's shared memory.",
        "Search across assets was not changed for my-project's private drafts: Turn Preview on first.",
        "Search across assets was not changed for my-project's published assets: No. (X)",
        "Search across assets was not changed for private drafts: no reason given",
        "Search across assets was not changed for my-project's private drafts: no reason given",
        "Search across assets for my-project's published assets: sideways.",
    ]
    odd = {"changes": [change("elsewhere", "odd", "other", "unchanged", "")]}
    assert wording.describe_changes(odd, {"contextGraphId": "", "layers": {"elsewhere": "off"}}) == "Search across assets was already other for elsewhere."
    assert wording.describe_changes({"changes": []}) is None
    assert wording.describe_changes(None) is None


# The node reports every memory of each context graph in its settings, not only the ones a change names.
NODE_WIDE = {"changes": [
    {"contextGraphId": "team", "layer": "working-memory", "from": "off", "to": "off", "outcome": "unchanged"},
    {"contextGraphId": "team", "layer": "shared-working-memory", "from": "off", "to": "build", "outcome": "applied"},
    {"contextGraphId": "team", "layer": "verifiable-memory", "from": "build", "to": "build", "outcome": "unchanged"},
    {"contextGraphId": "other", "layer": "working-memory", "from": "off", "to": "off", "outcome": "unchanged"},
    {"contextGraphId": "other", "layer": "verifiable-memory", "from": "serve", "to": "serve", "outcome": "unchanged"},
    {"contextGraphId": "third", "layer": "verifiable-memory", "from": "off", "to": "build", "outcome": "applied"},
]}
PREVIEW_NOTE = "Preview shows how results would change before it is turned on."


def test_changes_name_a_memory_left_as_it_was_only_when_the_request_set_it(wording):
    both = {"contextGraphId": "did:dkg:context-graph:team", "layers": {"shared-working-memory": "build", "verifiable-memory": "build"}}
    assert wording.describe_changes(NODE_WIDE, both).split("\n") == [
        f"Getting search across assets ready for team's shared memory. {PREVIEW_NOTE}",
        "Search across assets was already Preview for team's published assets.",
        f"Getting search across assets ready for third's published assets. {PREVIEW_NOTE}",
    ]
    assert len(wording.describe_changes(NODE_WIDE, {"contextGraphId": "team", "layers": {"shared-working-memory": "build"}}).split("\n")) == 2
    assert len(wording.describe_changes(NODE_WIDE).split("\n")) == 2
    unchanged = {"changes": [change for change in NODE_WIDE["changes"] if change["outcome"] == "unchanged"]}
    assert wording.describe_changes(unchanged, {"contextGraphId": "team", "viewSemantics": "merged"}) is None
    assert wording.describe_changes(unchanged, {"contextGraphId": "other", "layers": {"vm": "serve"}}) is None
    assert wording.describe_changes({"changes": [{"contextGraphId": "other", "layer": "vm", "to": "serve", "outcome": "unchanged"}]},
                                    {"contextGraphId": "other", "layers": {"verifiable-memory": "serve"}}) == (
        "Search across assets was already On for other's published assets.")
    refused = {"success": False, "status": 409, "code": "READ_GRAPHS_APPLY_REFUSED", "error": "Nothing changed.", "changes": [
        {"contextGraphId": "team", "layer": "verifiable-memory", "from": "build", "to": "serve", "outcome": {"refused": "Not ready yet."}},
        {"contextGraphId": "other", "layer": "verifiable-memory", "from": "serve", "to": "serve", "outcome": "unchanged"},
    ]}
    assert wording.describe_refusal(refused, "this Hermes provider", {"contextGraphId": "team", "layers": {"verifiable-memory": "serve"}}) == (
        "The node refused: Nothing changed. (READ_GRAPHS_APPLY_REFUSED)\n"
        "Search across assets was not changed for team's published assets: Not ready yet.")


def test_set_tool_describes_what_it_set_from_a_node_wide_report(provider_factory, send):
    send.return_value = {**SETTINGS, **NODE_WIDE}
    out = json.loads(provider_factory().handle_tool_call(
        "dkg_read_graphs_set", {"context_graph_id": "did:dkg:context-graph:team", "mode": "preview", "layer": "shared-working-memory"}))
    assert out["summary"].split("\n\n")[0].split("\n") == [
        f"Getting search across assets ready for team's shared memory. {PREVIEW_NOTE}",
        f"Getting search across assets ready for third's published assets. {PREVIEW_NOTE}",
    ]
    assert out["changes"] == NODE_WIDE["changes"]
    send.return_value = {"success": False, "status": 409, "code": "READ_GRAPHS_APPLY_REFUSED", "error": "Nothing changed.", "changes": [
        {"contextGraphId": "team", "layer": "working-memory", "from": "off", "to": "off", "outcome": "unchanged"},
        {"contextGraphId": "team", "layer": "verifiable-memory", "from": "serve", "to": "off", "outcome": {"refused": "The store is busy."}},
    ]}
    refused = json.loads(provider_factory().handle_tool_call("dkg_read_graphs_set", {"context_graph_id": "team", "mode": "off"}))
    assert refused["error"] == ("The node refused: Nothing changed. (READ_GRAPHS_APPLY_REFUSED)\n"
                                "Search across assets was not changed for team's published assets: The store is busy.")


def test_create_outcome_in_plain_words(wording):
    preview = {"layers": {"verifiable-memory": "build"}}
    on = {"layers": {"verifiable-memory": "serve", "shared-working-memory": "serve", "working-memory": "serve"}}
    assert wording.describe_create_outcome("my-project", preview, {"applied": True}) == (
        "Getting search across assets ready for my-project's published assets. Preview shows how results would change before it is turned on."
    )
    assert wording.describe_create_outcome("my-project", on, {"applied": {}}) == (
        "Turned search across assets on for my-project's published assets, shared memory and private drafts."
    )
    assert wording.describe_create_outcome("my-project", {"layers": {"working-memory": "off", "odd-layer": "off"}}, {"applied": True}) == (
        "Search across assets stays off for my-project's private drafts and odd-layer."
    )
    assert wording.describe_create_outcome("my-project", preview, {"refused": "Only the node admin can change this."}) == (
        "Search across assets was not turned on for my-project: Only the node admin can change this. "
        "The context graph was created; search across assets can be turned on later with dkg_read_graphs_set."
    )
    assert "was not turned on for my-project: Off for this node. (READ_GRAPHS_DISABLED) " in wording.describe_create_outcome(
        "my-project", preview, {"refused": {"code": "READ_GRAPHS_DISABLED", "error": "Off for this node."}})
    assert wording.describe_create_outcome("my-project", preview, {"refused": "Only the node admin can turn search across assets on.", "code": "NODE_ADMIN_REQUIRED"}) == (
        "Search across assets was not turned on for my-project: Only the node admin can turn search across assets on. (NODE_ADMIN_REQUIRED) "
        "The context graph was created; search across assets can be turned on later with dkg_read_graphs_set."
    )
    for outcome in (None, "applied", {}):
        assert wording.describe_create_outcome("my-project", preview, outcome).startswith(
            "Search across assets was not turned on for my-project: the node did not apply the setting")


FORBIDDEN = "Only the node admin can see or change search across assets, and the node did not accept this Hermes provider's token as the node admin token"


@pytest.mark.parametrize("failure,expected", [
    ({"success": False, "error": "connection refused"}, "No answer from the node: connection refused"),
    ({"success": False, "status": 403, "error": "GET /api/store/read-graphs/settings requires a node-level admin token."}, f"{FORBIDDEN} (HTTP 403)."),
    ({"success": False, "status": 401, "error": ""}, f"{FORBIDDEN} (HTTP 401)."),
    ({"success": False, "status": 404, "error": "Not found"}, "This node has no search-across-assets settings: it runs a DKG version from before them. Update the node first."),
    ({"success": False, "status": 404, "code": "NO_SUCH", "error": "Gone."}, "The node refused: Gone. (NO_SUCH)"),
    ({"success": False, "status": 409, "code": "READ_GRAPHS_LAYER_NOT_ALLOWED", "error": "Not that memory."}, "The node refused: Not that memory. (READ_GRAPHS_LAYER_NOT_ALLOWED)"),
    ({"success": False, "status": 409, "code": "READ_GRAPHS_APPLY_REFUSED", "error": "Nothing changed.",
      "changes": [{"contextGraphId": "team", "layer": "verifiable-memory", "from": "off", "to": "serve", "outcome": {"refused": "The store is busy."}}]},
     "The node refused: Nothing changed. (READ_GRAPHS_APPLY_REFUSED)\nSearch across assets was not changed for team's published assets: The store is busy."),
    ({"success": False, "status": 500, "error": "oops"}, "The node refused: oops"),
])
def test_refusals_in_plain_words(wording, failure, expected):
    assert wording.describe_refusal(failure, "this Hermes provider") == expected


def test_tool_schemas_offer_what_the_wording_accepts(provider_factory, wording):
    schemas = {schema["name"]: schema for schema in provider_factory().get_tool_schemas()}
    props = schemas["dkg_read_graphs_set"]["parameters"]["properties"]
    assert props["mode"]["enum"] == list(wording.MODE_INPUTS)
    assert props["layer"]["enum"] == list(wording.LAYER_INPUTS)
    assert props["default_semantics"]["enum"] == list(wording.SEMANTICS_INPUTS)
    create = schemas["dkg_context_graph_create"]["parameters"]["properties"]
    assert create["read_graphs"]["enum"] == list(wording.CREATE_MODE_INPUTS)
    assert create["read_graph_layer"]["enum"] == list(wording.LAYER_INPUTS)
    assert schemas["dkg_read_graphs_status"]["parameters"]["required"] == []


# -- The client ---------------------------------------------------------------------

class _Response:
    def __init__(self, status, body=None, text="", reason=""):
        self.status_code = status
        self.ok = 200 <= status < 300
        self._body = body
        self.text = text
        self.reason = reason

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


def _client_answering(client_class, monkeypatch, *responses):
    client = client_class()
    client._token = "admin-token"
    calls = []

    def request(method, url, data=None, timeout=None, headers=None):
        calls.append((method, url, None if data is None else json.loads(data), headers))
        response = responses[min(len(calls), len(responses)) - 1]
        if isinstance(response, Exception):
            raise response
        return response

    monkeypatch.setattr(client, "_get_session", lambda: SimpleNamespace(request=request))
    return client, calls


def test_client_reads_and_changes_settings(client_class, monkeypatch, hermes_host):
    client, calls = _client_answering(client_class, monkeypatch, _Response(200, SETTINGS))
    assert client.read_graph_settings() == SETTINGS
    assert client.read_graph_settings("did:dkg:context-graph:0xabc/team") == SETTINGS
    assert client.set_read_graph_settings({"contextGraphId": "did:dkg:context-graph:team", "layers": {"verifiable-memory": "build"}}) == SETTINGS
    assert calls == [
        ("GET", "http://127.0.0.1:9200/api/store/read-graphs/settings", None, None),
        ("GET", "http://127.0.0.1:9200/api/store/read-graphs/settings?contextGraphId=0xabc%2Fteam", None, None),
        ("PUT", "http://127.0.0.1:9200/api/store/read-graphs/settings", {"contextGraphId": "team", "layers": {"verifiable-memory": "build"}},
         {"X-DKG-Actor": "agent:hermes"}),
    ]


def test_client_keeps_the_status_and_code_of_a_refusal(client_class, monkeypatch, hermes_host):
    client, _ = _client_answering(
        client_class, monkeypatch,
        _Response(409, {"code": "READ_GRAPHS_DISABLED", "error": "Off for this node."}),
        _Response(409, {"code": "READ_GRAPHS_APPLY_REFUSED", "error": "Nothing changed.", "changes": [{"layer": "vm"}]}),
        _Response(403, {"error": "Bearer admin-token is not the node admin's."}),
        _Response(502, ValueError("not json"), text="", reason="Bad Gateway"),
        _Response(200, ["not", "a", "dict"], text="[...]"),
        ConnectionError("refused for Bearer admin-token"),
    )
    assert client.read_graph_settings() == {"success": False, "status": 409, "code": "READ_GRAPHS_DISABLED", "error": "Off for this node."}
    assert client.read_graph_settings() == {"success": False, "status": 409, "code": "READ_GRAPHS_APPLY_REFUSED", "error": "Nothing changed.", "changes": [{"layer": "vm"}]}
    assert client.read_graph_settings() == {"success": False, "status": 403, "error": "Bearer [REDACTED] is not the node admin's."}
    assert client.read_graph_settings() == {"success": False, "status": 502, "error": "Bad Gateway"}
    assert client.read_graph_settings() == {"success": False, "status": 200, "error": "[...]"}
    failure = client.read_graph_settings()
    assert failure["success"] is False and "status" not in failure and "admin-token" not in failure["error"]


def test_create_sends_the_read_graph_setting_only_when_asked(recording_client):
    recording_client.create_context_graph("Team", read_graphs={"layers": {"verifiable-memory": "serve"}})
    recording_client.create_context_graph("Team")
    assert [body.get("readGraphs") for _, body in recording_client.posts] == [{"layers": {"verifiable-memory": "serve"}}, None]
    assert recording_client.post_headers == [{"X-DKG-Actor": "agent:hermes"}, None]


# -- The tools ----------------------------------------------------------------------

def test_status_tool_answers_in_plain_words(provider_factory, send):
    provider = provider_factory()
    out = json.loads(provider.handle_tool_call("dkg_read_graphs_status", {}))
    assert out == {"summary": SUMMARY, **SETTINGS}
    provider.handle_tool_call("dkg_read_graphs_status", {"context_graph_id": "did:dkg:context-graph:team"})
    assert [call.args for call in send.call_args_list] == [
        ("GET", "/api/store/read-graphs/settings"),
        ("GET", "/api/store/read-graphs/settings?contextGraphId=team"),
    ]


def test_set_tool_puts_the_engine_modes(provider_factory, send):
    answer = {**SETTINGS, "changes": [{"contextGraphId": "team", "layer": "verifiable-memory", "from": "off", "to": "build", "outcome": "applied"}]}
    send.return_value = answer
    provider = provider_factory()
    out = json.loads(provider.handle_tool_call("dkg_read_graphs_set", {"context_graph_id": "team", "mode": "preview"}))
    assert out == {"summary": "Getting search across assets ready for team's published assets. Preview shows how results would change "
                              f"before it is turned on.\n\n{SUMMARY}", **answer}
    send.return_value = SETTINGS
    cleared = json.loads(provider.handle_tool_call("dkg_read_graphs_set", {"context_graph_id": "team", "mode": "on", "layer": "all", "default_semantics": "none"}))
    assert cleared["summary"] == SUMMARY
    assert all(call.kwargs == {"headers": {"X-DKG-Actor": "agent:hermes"}} for call in send.call_args_list)
    assert [call.args[2] for call in send.call_args_list] == [
        {"contextGraphId": "team", "layers": {"verifiable-memory": "build"}},
        {"contextGraphId": "team", "layers": {"verifiable-memory": "serve", "shared-working-memory": "serve", "working-memory": "serve"}, "viewSemantics": None},
    ]


@pytest.mark.parametrize("tool", ["dkg_read_graphs_status", "dkg_read_graphs_set"])
def test_tools_give_the_refusal_in_plain_words(provider_factory, send, tool):
    send.return_value = {"success": False, "status": 403, "error": "Requires a node-level admin token."}
    out = json.loads(provider_factory().handle_tool_call(tool, {"context_graph_id": "team", "mode": "off"}))
    assert out["error"] == f"{FORBIDDEN} (HTTP 403)."


@pytest.mark.parametrize("tool,args,error", [
    ("dkg_read_graphs_status", {"context_graph_id": "did:dkg:context-graph:"}, "must be a context graph id"),
    ("dkg_read_graphs_status", {"context_graph_id": 7}, "must be a context graph id"),
    ("dkg_read_graphs_set", {}, '"context_graph_id" is required.'),
    ("dkg_read_graphs_set", {"context_graph_id": "team", "mode": "everything"}, '"mode" must be one of'),
    ("dkg_read_graphs_set", {"context_graph_id": "team", "mode": "on", "layer": "cold"}, '"layer" must be one of'),
    ("dkg_read_graphs_set", {"context_graph_id": "team", "default_semantics": "sometimes"}, '"default_semantics" must be one of'),
    ("dkg_read_graphs_set", {"context_graph_id": "team"}, 'Give "mode", "default_semantics", or both.'),
    ("dkg_read_graphs_set", {"context_graph_id": "team", "layer": "all", "default_semantics": "merged"}, '"layer" needs "mode".'),
    ("dkg_context_graph_create", {"name": "team", "read_graph_layer": "all"}, '"read_graph_layer" needs "read_graphs".'),
    ("dkg_context_graph_create", {"name": "team", "read_graphs": "off"}, '"read_graphs" must be one of preview, on.'),
    ("dkg_context_graph_create", {"name": "team", "read_graphs": "build"}, '"read_graphs" must be one of preview, on.'),
    ("dkg_read_graphs_set", {"context_graph_id": "team", "mode": "serve"}, '"mode" must be one of off, preview, on.'),
    ("dkg_context_graph_create", {"name": "team", "read_graphs": "on", "read_graph_layer": "cold"}, '"read_graph_layer" must be one of'),
])
def test_invalid_arguments_fail_without_io(provider_factory, send, tool, args, error):
    provider = provider_factory()
    provider_factory.post.reset_mock()
    assert error in json.loads(provider.handle_tool_call(tool, args))["error"]
    send.assert_not_called()
    provider_factory.post.assert_not_called()


@pytest.mark.parametrize("tool", ["dkg_read_graphs_status", "dkg_read_graphs_set"])
def test_offline_tools_fail_before_any_transport_call(provider_factory, send, tool):
    provider = provider_factory()
    provider._offline = True
    assert "offline" in json.loads(provider.handle_tool_call(tool, {"context_graph_id": "team", "mode": "on"}))["error"]
    send.assert_not_called()


def test_create_reports_the_read_graph_setting(provider_factory):
    provider = provider_factory()
    provider_factory.post.reset_mock()
    provider_factory.post.return_value = {"created": "team", "uri": "did:dkg:context-graph:team", "readGraphs": {"applied": True}}
    out = json.loads(provider.handle_tool_call("dkg_context_graph_create", {"name": "Team", "read_graphs": "on", "read_graph_layer": "shared-working-memory"}))
    path, body = provider_factory.post.call_args.args
    assert path == "/api/context-graph/create"
    assert body["readGraphs"] == {"layers": {"shared-working-memory": "serve"}}
    assert provider_factory.post.call_args.kwargs == {"headers": {"X-DKG-Actor": "agent:hermes"}}
    assert out["searchAcrossAssets"] == "Turned search across assets on for team's shared memory."


def test_create_without_the_setting_or_after_a_failure_adds_nothing(provider_factory):
    provider = provider_factory()
    provider_factory.post.reset_mock()
    provider_factory.post.return_value = {"created": "team", "uri": "did:dkg:context-graph:team"}
    out = json.loads(provider.handle_tool_call("dkg_context_graph_create", {"name": "Team"}))
    assert "readGraphs" not in provider_factory.post.call_args.args[1]
    assert provider_factory.post.call_args.kwargs == {}
    assert "searchAcrossAssets" not in out
    provider_factory.post.return_value = {"success": False, "error": "Context graph already exists"}
    failed = json.loads(provider.handle_tool_call("dkg_context_graph_create", {"name": "Team", "read_graphs": "preview"}))
    assert failed == {"success": False, "error": "Context graph already exists"}


# -- The admin-tools switch ------------------------------------------------------

GUARD = "Context graph admin tools are disabled by the adapter guard. Enable DKG_ALLOW_CONTEXT_GRAPH_ADMIN_TOOLS explicitly."


def test_admin_switch_on_by_default_offers_the_set_tool_and_create_options(provider_factory, send):
    provider = provider_factory()
    provider._cache["memory"] = [{"target": "memory", "content": "remember"}]
    schemas = {schema["name"]: schema for schema in provider.get_tool_schemas()}
    assert {"dkg_read_graphs_status", "dkg_read_graphs_set"} <= set(schemas)
    assert {"read_graphs", "read_graph_layer"} <= set(schemas["dkg_context_graph_create"]["parameters"]["properties"])
    assert "dkg_read_graphs_status/set — See or change where queries search across assets" in provider.system_prompt_block()


def test_admin_switch_off_keeps_status_and_refuses_changes_without_io(provider_factory, send):
    provider = provider_factory({"allow_context_graph_admin_tools": False})
    provider._cache["memory"] = [{"target": "memory", "content": "remember"}]
    schemas = {schema["name"]: schema for schema in provider.get_tool_schemas()}
    assert "dkg_read_graphs_status" in schemas and "dkg_read_graphs_set" not in schemas
    create = schemas["dkg_context_graph_create"]["parameters"]["properties"]
    assert not {"read_graphs", "read_graph_layer"} & set(create) and {"name", "public", "allowed_agents"} <= set(create)
    prompt = provider.system_prompt_block()
    assert "dkg_read_graphs_status — See where queries search across assets" in prompt and "dkg_read_graphs_status/set" not in prompt
    provider_factory.post.reset_mock()
    for tool, args in [
        ("dkg_read_graphs_set", {"context_graph_id": "team", "mode": "on"}),
        ("dkg_context_graph_create", {"name": "Team", "read_graphs": "on"}),
        ("dkg_context_graph_create", {"name": "Team", "read_graph_layer": "all"}),
    ]:
        assert json.loads(provider.handle_tool_call(tool, args)) == {"error": GUARD}
    send.assert_not_called()
    provider_factory.post.assert_not_called()
    assert json.loads(provider.handle_tool_call("dkg_read_graphs_status", {}))["summary"] == SUMMARY
    provider_factory.post.return_value = {"created": "team", "uri": "did:dkg:context-graph:team"}
    assert json.loads(provider.handle_tool_call("dkg_context_graph_create", {"name": "Team"})) == {"created": "team", "uri": "did:dkg:context-graph:team"}


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_token_makes_exactly_one_request(client_class, monkeypatch, hermes_host, status):
    client, calls = _client_answering(client_class, monkeypatch, _Response(status, {"error": "Requires a node-level admin token."}))
    assert client.read_graph_settings()["status"] == status
    assert len(calls) == 1
    assert client.set_read_graph_settings({"contextGraphId": "team", "layers": {"verifiable-memory": "off"}})["status"] == status
    assert len(calls) == 2
