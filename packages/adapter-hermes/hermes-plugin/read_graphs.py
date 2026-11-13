"""Search across assets (the node's read graphs) for the Hermes DKG tools.

The values the tools accept, and what they say, in the words users see: the
feature is "search across assets", with the modes Off, Preview and On.
Requests and stored values keep the engine values ``off``, ``build`` and
``serve``. The sentences match ``@origintrail-official/dkg-core``'s
``read-graph-settings`` module, which the MCP and OpenClaw tools use.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

LAYERS = ("verifiable-memory", "shared-working-memory", "working-memory")
LAYER_INPUTS = LAYERS + ("all",)
MODE_INPUTS = ("off", "preview", "on")
CREATE_MODE_INPUTS = ("preview", "on")
SEMANTICS_INPUTS = ("merged", "per-asset", "none")

_CONTEXT_GRAPH_URI_PREFIX = "did:dkg:context-graph:"
_MODE_WORDS = {"off": "Off", "build": "Preview", "serve": "On"}
# Each memory as a list label, and inside a sentence.
_LAYER_WORDS = {
    "verifiable-memory": "Published assets",
    "shared-working-memory": "Shared memory, shared with your team",
    "working-memory": "Private drafts",
}
_LAYER_PHRASES = {
    "verifiable-memory": "published assets",
    "shared-working-memory": "shared memory",
    "working-memory": "private drafts",
}
# The layer labels GET /api/store/read-graphs gives each read graph.
_LAYER_LABELS = {"vm": "verifiable-memory", "swm": "shared-working-memory", "wm": "working-memory"}
_PREVIEW_NOTE = "Preview shows how results would change before it is turned on."


def is_context_graph_id(value: Any) -> bool:
    """A context graph id or URI that names one; the client strips the URI prefix once."""
    return isinstance(value, str) and _sent_id(value) != ""


def _sent_id(value: Any) -> str:
    """A context graph id as the client sends it: trimmed, with one URI prefix taken off."""
    text = value.strip() if isinstance(value, str) else ""
    return text[len(_CONTEXT_GRAPH_URI_PREFIX):] if text.startswith(_CONTEXT_GRAPH_URI_PREFIX) else text


def mode_of(value: str) -> str:
    """The engine value of a mode argument: Preview is ``build``, On is ``serve``."""
    return {"preview": "build", "on": "serve"}.get(value, "off")


def modes_for(layer: str, mode: str) -> Dict[str, str]:
    """``mode`` for one layer, or for all three."""
    layers = LAYERS if layer == "all" else (layer,)
    return {name: mode for name in layers}


def create_option(args: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """The create tool's ``read_graphs`` and ``read_graph_layer``: ``(readGraphs, None)``,
    ``(None, None)`` when not asked, or ``(None, error)``."""
    mode = args.get("read_graphs")
    layer = args.get("read_graph_layer")
    if mode is None:
        return (None, None) if layer is None else (None, '"read_graph_layer" needs "read_graphs".')
    if mode not in CREATE_MODE_INPUTS:
        return None, f'"read_graphs" must be one of {", ".join(CREATE_MODE_INPUTS)}.'
    if layer is not None and layer not in LAYER_INPUTS:
        return None, f'"read_graph_layer" must be one of {", ".join(LAYER_INPUTS)}.'
    return {"layers": modes_for(layer or "verifiable-memory", mode_of(mode))}, None


def change_of(args: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """The set tool's arguments as the ``PUT`` body, or what is wrong with them."""
    cg = args.get("context_graph_id")
    mode = args.get("mode")
    layer = args.get("layer")
    semantics = args.get("default_semantics")
    if not is_context_graph_id(cg):
        return None, '"context_graph_id" is required.'
    if mode is not None and mode not in MODE_INPUTS:
        return None, f'"mode" must be one of {", ".join(MODE_INPUTS)}.'
    if layer is not None and layer not in LAYER_INPUTS:
        return None, f'"layer" must be one of {", ".join(LAYER_INPUTS)}.'
    if semantics is not None and semantics not in SEMANTICS_INPUTS:
        return None, f'"default_semantics" must be one of {", ".join(SEMANTICS_INPUTS)}.'
    if mode is None and semantics is None:
        return None, 'Give "mode", "default_semantics", or both.'
    if mode is None and layer is not None:
        return None, '"layer" needs "mode".'
    change: Dict[str, Any] = {"contextGraphId": cg}
    if mode is not None:
        change["layers"] = modes_for(layer or "verifiable-memory", mode_of(mode))
    if semantics is not None:
        change["viewSemantics"] = None if semantics == "none" else semantics
    return change, None


def describe_settings(answer: Any) -> str:
    """A GET or PUT answer in plain words: the node-wide limits, then each context
    graph's memories with the mode in force and how far its combined copy is."""
    lines: List[str] = []
    policy = _record(answer, "policy")
    if policy is not None and policy.get("enabled") is False:
        lines.append("Search across assets is switched off for this whole node.")
    refused = _record(answer, "refused")
    if refused is not None:
        lines.append(f"This node can't turn search across assets on: {_sentence(refused)}")
    node = _record(answer, "node")
    node_modes = _record(node, "layers")
    if node_modes is not None:
        modes = [f"{_LAYER_WORDS[layer]}: {_word(node_modes.get(layer, 'not set'))}" for layer in LAYERS]
        if node.get("viewSemantics") in ("merged", "per-asset"):
            modes.append(f"Queries search across assets: {'On' if node['viewSemantics'] == 'merged' else 'Off'}")
        lines.append(f"This node's default: {' · '.join(modes)}.")
    allowed = policy.get("layers") if policy is not None and isinstance(policy.get("layers"), list) else None
    context_graphs = _records(answer, "contextGraphs")
    if not context_graphs:
        lines.append("No context graph has search across assets set up.")
    for context_graph in context_graphs:
        lines.extend(_describe_context_graph(context_graph, allowed))
    return "\n".join(lines)


def describe_changes(answer: Any, request: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """What a PUT did, one sentence per memory; ``None`` when there is nothing to say. The node
    reports every memory of each context graph in its settings, so a memory left as it was gets
    a sentence only when ``request`` (the set tool's change) set it; a change or a refusal always does."""
    changes = [change for change in _records(answer, "changes")
               if change.get("outcome") != "unchanged" or _set_by(request, change)]
    return "\n".join(_describe_change(change) for change in changes) if changes else None


def _set_by(request: Optional[Dict[str, Any]], change: Dict[str, Any]) -> bool:
    """Whether ``request`` set this memory of this context graph."""
    layers = request.get("layers") if isinstance(request, dict) else None
    if not isinstance(layers, dict) or change.get("contextGraphId") != _sent_id(request.get("contextGraphId")):
        return False
    layer = change.get("layer")
    return isinstance(layer, str) and _LAYER_LABELS.get(layer, layer) in layers


def describe_create_outcome(context_graph_id: str, requested: Dict[str, Any], outcome: Any) -> str:
    """What the create tool adds when search across assets was asked for."""
    layers = requested.get("layers", {})
    mode = _mode(next(iter(layers.values()), None))
    where = f"{context_graph_id}'s {_phrase_list(list(layers))}"
    result = outcome if isinstance(outcome, dict) else {}
    if "refused" in result:
        code = f" ({result['code']})" if isinstance(result["refused"], str) and isinstance(result.get("code"), str) else ""
        return (f"Search across assets was not turned on for {context_graph_id}: {_reason(result['refused'])}{code} "
                "The context graph was created; search across assets can be turned on later with dkg_read_graphs_set.")
    if "applied" in result:
        if mode == "serve":
            return f"Turned search across assets on for {where}."
        if mode == "build":
            return f"Getting search across assets ready for {where}. {_PREVIEW_NOTE}"
        return f"Search across assets stays off for {where}."
    return (f"Search across assets was not turned on for {context_graph_id}: the node did not apply the setting, so it may run "
            "a DKG version from before it. Check with dkg_read_graphs_status.")


def describe_refusal(failure: Dict[str, Any], caller: str, request: Optional[Dict[str, Any]] = None) -> str:
    """What a tool says when a settings request fails (the client's ``{"success": False, ...}``);
    ``request`` as for ``describe_changes``."""
    status = failure.get("status")
    said = str(failure.get("error") or "no reason given")
    if status is None:
        return f"No answer from the node: {said}"
    if status in (401, 403):
        return (f"Only the node admin can see or change search across assets, and the node did not accept {caller}'s token "
                f"as the node admin token (HTTP {status}).")
    code = failure.get("code")
    if status == 404 and code is None:
        return "This node has no search-across-assets settings: it runs a DKG version from before them. Update the node first."
    changes = describe_changes(failure, request)
    return f"The node refused: {said}" + (f" ({code})" if isinstance(code, str) else "") + ("" if changes is None else f"\n{changes}")


def _describe_change(change: Dict[str, Any]) -> str:
    where = _where(change.get("contextGraphId"), change.get("layer"))
    to = _mode(change.get("to"))
    outcome = change.get("outcome")
    if outcome == "unchanged":
        return f"Search across assets was already {_MODE_WORDS[to] if to else str(change.get('to'))} for {where}."
    if outcome != "applied":
        refused = outcome.get("refused") if isinstance(outcome, dict) else None
        return f"Search across assets was not changed for {where}: {_reason(refused)}"
    if to == "serve":
        return f"Turned search across assets on for {where}."
    if to == "off":
        return f"Turned search across assets off for {where}; its combined copy is removed."
    if to == "build" and change.get("from") == "serve":
        return (f"Search across assets is back to Preview for {where}: queries no longer search across them, "
                "and the combined copy stays up to date.")
    if to == "build":
        return f"Getting search across assets ready for {where}. {_PREVIEW_NOTE}"
    return f"Search across assets for {where}: {change.get('to')}."


def _describe_context_graph(context_graph: Dict[str, Any], allowed: Optional[list]) -> List[str]:
    chosen = _record(context_graph, "layers") or {}
    effective = _record(context_graph, "effective")
    in_force = _record(effective, "layers") or {}
    read_graphs = _records(context_graph, "readGraphs")
    lines = [f"Search across assets in {context_graph.get('contextGraphId')}:"]
    for layer in LAYERS:
        mode = _mode(in_force.get(layer)) or _mode(chosen.get(layer))
        choice = _mode(chosen.get(layer))
        kept = mode in ("build", "serve")
        copies = [rg for rg in read_graphs if _layer(rg.get("layer")) == layer]
        # A sub-graph's copy holds what the context graph's whole copy already holds, so sizes come from
        # the whole copies: one, or one per agent in working memory, whose drafts don't overlap. States
        # come from every copy.
        whole = [rg for rg in copies if not isinstance(rg.get("subGraphName"), str)]
        assets = _count(whole, "members") if kept else None
        label = _LAYER_WORDS[layer] if assets is None else f"{_LAYER_WORDS[layer]} · {_counted(assets, 'asset')}"
        line = f"- {label}: {_MODE_WORDS[mode] if mode else 'not set'}"
        if mode and choice and choice != mode:
            why = "this node does not allow it" if allowed is not None and layer not in allowed else f"this node keeps it {_MODE_WORDS[mode]}"
            line += f" (set to {_MODE_WORDS[choice]}, but {why})"
        if kept:
            line += f": {_progress(copies, mode)}"
            facts = _count(whole, "triples")
            if facts is not None:
                line += f". About {_counted(facts, 'fact')}, at its last build"
        lines.append(line)
    semantics = (effective or {}).get("viewSemantics") or context_graph.get("viewSemantics")
    if semantics == "merged":
        lines.append("- Queries search across assets by default: On.")
    if semantics == "per-asset":
        lines.append("- Queries search across assets by default: Off, each asset is searched on its own.")
    return lines


def _progress(read_graphs: List[Dict[str, Any]], mode: str) -> str:
    if not read_graphs:
        return "Getting ready"
    counts: Dict[str, int] = {}
    for read_graph in read_graphs:
        word = _state_word(read_graph.get("state"), mode, read_graph.get("progress"))
        counts[word] = counts.get(word, 0) + 1
    if len(counts) == 1:
        return next(iter(counts))
    return ", ".join(f"{count} {word}" for word, count in counts.items())


def _count(read_graphs: List[Dict[str, Any]], key: str) -> Optional[int]:
    """What a memory's whole copies counted at their last build, ``members`` (assets)
    or ``triples`` (facts), added up; ``None`` unless every one has the count (a
    restart clears them until the next build)."""
    if not read_graphs:
        return None
    total = 0
    for read_graph in read_graphs:
        count = read_graph.get(key)
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            return None
        total += count
    return total


def _counted(count: int, noun: str) -> str:
    return f"{count:,} {noun}{'' if count == 1 else 's'}"


def _state_word(state: Any, mode: str, progress: Any) -> str:
    if state == "ready":
        return "In use" if mode == "serve" else "Ready to turn on"
    if state == "building":
        # Rounded half up, as JavaScript's Math.round does for these values.
        if isinstance(progress, (int, float)) and not isinstance(progress, bool) and 0 <= progress <= 1:
            return f"Getting ready {int(progress * 100 + 0.5)}%"
        return "Getting ready"
    if state in ("dirty", "repairing", "rebuilding"):
        return "Rebuilding"
    return str(state)


def _where(context_graph_id: Any, layer: Any) -> str:
    name = _layer(layer)
    phrase = _LAYER_PHRASES[name] if name else str(layer)
    return f"{context_graph_id}'s {phrase}" if isinstance(context_graph_id, str) and context_graph_id else phrase


def _phrase_list(layers: List[str]) -> str:
    phrases = [_LAYER_PHRASES[_layer(layer)] if _layer(layer) else layer for layer in layers]
    return "".join(phrases) if len(phrases) < 2 else f"{', '.join(phrases[:-1])} and {phrases[-1]}"


def _word(value: Any) -> str:
    mode = _mode(value)
    return _MODE_WORDS[mode] if mode else str(value)


def _mode(value: Any) -> Optional[str]:
    return value if value in ("off", "build", "serve") else None


def _layer(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    return value if value in LAYERS else _LAYER_LABELS.get(value)


def _sentence(body: Dict[str, Any]) -> str:
    said = body.get("error") if isinstance(body.get("error"), str) else "no reason given"
    return f"{said} ({body['code']})" if isinstance(body.get("code"), str) else said


def _reason(refused: Any) -> str:
    if isinstance(refused, str):
        return refused
    return _sentence(refused) if isinstance(refused, dict) else "no reason given"


def _record(value: Any, key: str) -> Optional[Dict[str, Any]]:
    field = value.get(key) if isinstance(value, dict) else None
    return field if isinstance(field, dict) else None


def _records(value: Any, key: str) -> List[Dict[str, Any]]:
    field = value.get(key) if isinstance(value, dict) else None
    return [item for item in field if isinstance(item, dict)] if isinstance(field, list) else []
