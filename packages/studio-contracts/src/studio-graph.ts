import { STUDIO_MAX_OUTPUTS } from './studio-interface-limits.js';
import { parseStudioInputs } from './studio-inputs.js';
import type { StudioGraph } from './workflow-definition.js';
import {
  studioRecord,
  studioUuid,
  sha,
  bounded,
  programIri,
  blockId,
  invalid,
} from './studio-values.js';

/** Complete plain-graph boundary, independent of saved snapshot and recipe models. */
export function parseStudioGraph(
  v: unknown,
  draft = false,
): StudioGraph {
  if (studioRecord(v) && (v.composition !== undefined || v.schemaVersion !== undefined || v.target !== undefined))
    return invalid();
  if (
    !studioRecord(v) ||
    !studioUuid(v.id) ||
    !bounded(v.name, 80) ||
    !bounded(v.entryId, 40) ||
    !Array.isArray(v.nodes) ||
    (!draft && !v.nodes.length) ||
    !Array.isArray(v.edges)
  )
    return invalid();
  for (const n of v.nodes)
    if (
      !studioRecord(n) ||
      !blockId(n.id) ||
      (n.label !== undefined && (!bounded(n.label, 80) || !n.label.trim())) ||
      (n.groupId !== undefined && !blockId(n.groupId)) ||
      !blockId(n.componentId) ||
      !bounded(n.kaRef, 240) ||
      !(n.componentId === 'run-program'
        ? programIri(n.kaRef) && studioRecord(n.params) && programIri(n.params.operationIri)
        : n.kaRef.startsWith('urn:nos:component:') ||
          /^urn:demo:n8n:component:[a-z0-9:-]{1,100}$/.test(n.kaRef)) ||
      !sha(n.sourceHash) ||
      !studioRecord(n.params) ||
      (n.inputValues !== undefined &&
        (!studioRecord(n.inputValues) ||
          JSON.stringify(n.inputValues).length > 2048 ||
          Object.keys(n.inputValues).some(
            (key) =>
              !/^[A-Za-z][A-Za-z0-9_]{0,29}$/.test(key) ||
              ['constructor', 'prototype', '__proto__'].includes(key) ||
              key.startsWith('__nos'),
          ))) ||
      // Compact inputs aggregate exposed native fields; expansion is parsed again
      // with the native per-step budget before persistence. HTTP body limits are unchanged.
      JSON.stringify(n.params).length >
        (n.componentId === 'workflow-component' ? 16384 : 2048) ||
      ![n.x, n.y].every(
        (x) =>
          typeof x === 'number' &&
          Number.isFinite(x) &&
          Number.isInteger(x) &&
          x >= 0 &&
          x <= 10000,
      )
    )
      return invalid();
  const ids = new Set(v.nodes.map((n) => n.id));
  if (
    v.groups !== undefined &&
    (!Array.isArray(v.groups) ||
      !v.groups.every(
        (g) =>
          studioRecord(g) &&
          blockId(g.id) &&
          bounded(g.name, 80) &&
          g.name.trim() &&
          ['purple', 'teal', 'amber', 'neutral'].includes(String(g.tone)),
      ) ||
      new Set(v.groups.map((g) => g.id)).size !== v.groups.length)
  )
    return invalid();
  if (
    v.nodes.some(
      (n) =>
        n.groupId !== undefined &&
        !(v.groups as StudioGraph['groups'])?.some((g) => g.id === n.groupId),
    )
  )
    return invalid();
  if (ids.size !== v.nodes.length || (!draft && !ids.has(v.entryId))) return invalid();
  for (const e of v.edges)
    if (
      !studioRecord(e) ||
      !ids.has(e.from) ||
      !ids.has(e.to) ||
      !Number.isInteger(e.output) ||
      Number(e.output) < 0 ||
      Number(e.output) >= STUDIO_MAX_OUTPUTS ||
      !Number.isInteger(e.input) ||
      Number(e.input) < 0 ||
      Number(e.input) > 1
    )
      return invalid();
  if (v.inputs !== undefined) parseStudioInputs(v.inputs, v as StudioGraph, true, draft);
  return v as StudioGraph;
}
