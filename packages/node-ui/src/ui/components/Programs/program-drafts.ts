import type { ProgramReference } from '@origintrail-official/dkg-graph-computer';

export type DraftChild = { graphId: string; operationIri: string; programIri: string };
export interface ProgramDraft {
  schema: 1; updatedAt: string;
  name: string; source: string; version: string; graphId: string; operationIri: string;
  callers: string; toolsText: string; permissionsText: string; children: DraftChild[];
  maxCalls: number; maxConcurrency: number; timeoutMs: number; inputs: string;
  savedProgram?: ProgramReference;
}
export function programDraftKey(origin: string, address: string, graph: string, existing?: { programIri: string; programLayer: string }) {
  return `dkg-program-draft:v1:${JSON.stringify([origin, address.toLowerCase(), graph.replace(/^did:dkg:context-graph:/, ''), existing?.programIri ?? 'new', existing?.programLayer ?? 'wm'])}`;
}
export function readProgramDraft(key: string): ProgramDraft | null {
  const raw = window.localStorage.getItem(key);
  if (!raw) return null;
  if (raw.length > 1_048_576) throw new Error('Stored draft is too large.');
  const d = JSON.parse(raw);
  const strings = ['updatedAt', 'name', 'source', 'version', 'graphId', 'operationIri', 'callers', 'toolsText', 'permissionsText', 'inputs'];
  if (!d || d.schema !== 1 || strings.some(k => typeof d[k] !== 'string')
    || !['maxCalls', 'maxConcurrency', 'timeoutMs'].every(k => Number.isFinite(d[k]))
    || !Array.isArray(d.children) || d.children.length > 256
    || d.children.some((c: any) => !c || ['graphId', 'operationIri', 'programIri'].some(k => typeof c[k] !== 'string'))
    || (d.savedProgram && ['graphId', 'programIri', 'programLayer', 'sourceHash', 'authorAgentAddress'].some(k => typeof d.savedProgram[k] !== 'string')))
    throw new Error('Stored draft could not be read.');
  return d;
}
export function writeProgramDraft(key: string, draft: ProgramDraft) {
  const raw = JSON.stringify(draft);
  if (new TextEncoder().encode(raw).length > 1_048_576) throw new Error('Draft exceeds the 1 MiB browser storage limit.');
  window.localStorage.setItem(key, raw);
}
