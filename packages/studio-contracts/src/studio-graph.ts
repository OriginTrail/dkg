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
  allowDocuments = false,
  allowLibrary = false,
  archived = false,
): StudioGraph {
  if (studioRecord(v) && v.composition !== undefined) return invalid();
  const documentDraft =
    allowDocuments &&
    studioRecord(v) &&
    (v.schemaVersion === 1 ||
      (Array.isArray(v.nodes) &&
        v.nodes.some(
          (node) =>
            studioRecord(node) &&
            typeof node.kaRef === 'string' &&
            node.kaRef.startsWith('urn:nos:workflow-block:'),
        )));
  const definitionId = (value: unknown) =>
    documentDraft
      ? bounded(value, 64) && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)
      : blockId(value);
  if (
    !studioRecord(v) ||
    !(documentDraft
      ? bounded(v.id, 64) && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(v.id)
      : studioUuid(v.id)) ||
    !bounded(v.name, documentDraft ? 100 : 80) ||
    !bounded(v.entryId, documentDraft ? 64 : 40) ||
    !Array.isArray(v.nodes) ||
    (documentDraft && v.nodes.length > 32) ||
    (!draft && !v.nodes.length) ||
    !Array.isArray(v.edges) ||
    (documentDraft && v.edges.length > 31)
  )
    return invalid();
  for (const n of v.nodes)
    if (
      !studioRecord(n) ||
      !definitionId(n.id) ||
      (n.label !== undefined && (!bounded(n.label, documentDraft ? 100 : 80) || !n.label.trim())) ||
      (n.groupId !== undefined && !definitionId(n.groupId)) ||
      !blockId(n.componentId) ||
      !bounded(n.kaRef, 240) ||
      !(
        (draft && allowLibrary && /^urn:nos:studio-library:[a-z0-9-]+:v[12]$/.test(n.kaRef)) ||
        (!n.kaRef.startsWith('urn:nos:studio-library:') &&
          (n.componentId === 'run-program'
            ? programIri(n.kaRef) && studioRecord(n.params) && programIri(n.params.operationIri)
            : n.kaRef.startsWith('urn:nos:component:') ||
              /^urn:demo:n8n:component:[a-z0-9:-]{1,100}$/.test(n.kaRef) ||
              (archived &&
                /^urn:demo:n8n:component:[a-z0-9-]+:[a-f0-9]{12}:[a-f0-9]{12}$/.test(n.kaRef)) ||
              (documentDraft &&
                /^urn:nos:workflow-block:(document|model|review|publish|readback|wait):v1$/.test(
                  n.kaRef,
                ))))
      ) ||
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
        (documentDraft || n.componentId === 'workflow-component' ? 16384 : 2048) ||
      ![n.x, n.y].every(
        (x) =>
          typeof x === 'number' &&
          Number.isFinite(x) &&
          (documentDraft || Number.isInteger(x)) &&
          x >= (documentDraft ? -5000 : 0) &&
          x <= 10000,
      )
    )
      return invalid();
  if (
    documentDraft &&
    v.target !== undefined &&
    (!studioRecord(v.target) ||
      !['jobId', 'peerId', 'nodeBuild', 'graphName'].every((key) =>
        bounded((v.target as Record<string, unknown>)[key], 200),
      ) ||
      !['working-memory', 'verifiable-memory'].includes(String(v.target.layer)))
  )
    return invalid();
  const ids = new Set(v.nodes.map((n) => n.id));
  if (
    v.groups !== undefined &&
    (!Array.isArray(v.groups) ||
      !v.groups.every(
        (g) =>
          studioRecord(g) &&
          definitionId(g.id) &&
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
