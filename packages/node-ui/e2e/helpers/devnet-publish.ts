/**
 * Devnet API helpers for Playwright e2e — WM → SWM → VM publish flows.
 * Mirrors patterns from `devnet/rich-scenario/automated.test.ts`.
 */
import { devnetApiFetch, readDevnetNode } from './devnet.js';

export interface PublishQuads {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

export function buildTestQuads(cgId: string, stamp: number, label: string): PublishQuads[] {
  const subject = `urn:e2e:ui:entity:${stamp}`;
  const graph = `did:dkg:context-graph:${cgId}`;
  return [
    {
      subject,
      predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      object: 'http://dkg.io/ontology/core/Entity',
      graph,
    },
    {
      subject,
      predicate: 'http://www.w3.org/2000/01/rdf-schema#label',
      object: `"${label}"`,
      graph,
    },
  ];
}

export async function listContextGraphs(nodeNum = 1): Promise<Array<{ id: string; name: string }>> {
  const res = await devnetApiFetch('/api/context-graphs', { nodeNum });
  if (!res.ok) throw new Error(`context-graphs: ${res.status}`);
  const json = (await res.json()) as { contextGraphs: Array<{ id: string; name: string }> };
  return json.contextGraphs ?? [];
}

export async function createWmAssertion(opts: {
  contextGraphId: string;
  name: string;
  quads: PublishQuads[];
  promote?: boolean;
  nodeNum?: number;
}): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await devnetApiFetch('/api/assertion/create', {
    method: 'POST',
    nodeNum: opts.nodeNum ?? 1,
    body: JSON.stringify({
      contextGraphId: opts.contextGraphId,
      name: opts.name,
      quads: opts.quads,
      finalize: true,
      promote: opts.promote ?? false,
    }),
  });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

export async function promoteAssertion(opts: {
  contextGraphId: string;
  assertionName: string;
  nodeNum?: number;
}): Promise<Response> {
  const encoded = encodeURIComponent(opts.assertionName);
  return devnetApiFetch(`/api/assertion/${encoded}/promote`, {
    method: 'POST',
    nodeNum: opts.nodeNum ?? 1,
    body: JSON.stringify({
      contextGraphId: opts.contextGraphId,
    }),
  });
}

export async function publishToVm(opts: {
  contextGraphId: string;
  assertionName: string;
  nodeNum?: number;
  clearAfter?: boolean;
}): Promise<{ status?: string; kaId?: string; txHash?: string }> {
  const res = await devnetApiFetch('/api/shared-memory/publish', {
    method: 'POST',
    nodeNum: opts.nodeNum ?? 1,
    body: JSON.stringify({
      contextGraphId: opts.contextGraphId,
      assertionName: opts.assertionName,
      clearAfter: opts.clearAfter ?? false,
    }),
  });
  if (!res.ok) {
    throw new Error(`publish failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { status?: string; kaId?: string; txHash?: string };
}

export async function runWmSwmVmPipeline(opts: {
  contextGraphId: string;
  stamp?: number;
  nodeNum?: number;
}): Promise<{ assertionName: string; label: string; kaId?: string }> {
  const stamp = opts.stamp ?? Date.now();
  const assertionName = `e2e-ui-pipeline-${stamp}`;
  const label = `E2E Pipeline ${stamp}`;
  const quads = buildTestQuads(opts.contextGraphId, stamp, label);

  const wm = await createWmAssertion({
    contextGraphId: opts.contextGraphId,
    name: assertionName,
    quads,
    promote: false,
    nodeNum: opts.nodeNum,
  });
  if (!wm.ok) throw new Error(`WM create failed: ${wm.status} ${wm.body}`);

  const promoteRes = await promoteAssertion({
    contextGraphId: opts.contextGraphId,
    assertionName,
    nodeNum: opts.nodeNum,
  });
  if (!promoteRes.ok) {
    throw new Error(`SWM promote failed: ${promoteRes.status} ${await promoteRes.text()}`);
  }

  const vm = await publishToVm({
    contextGraphId: opts.contextGraphId,
    assertionName,
    nodeNum: opts.nodeNum,
  });

  return { assertionName, label, kaId: vm.kaId };
}

export async function registerAgent(nodeNum: number, label: string): Promise<{ agentAddress: string; authToken: string }> {
  const res = await devnetApiFetch('/api/agent/register', {
    method: 'POST',
    nodeNum,
    body: JSON.stringify({ name: `e2e-${label}-${Date.now()}`, framework: 'playwright-e2e' }),
  });
  if (!res.ok) throw new Error(`register agent: ${res.status} ${await res.text()}`);
  return (await res.json()) as { agentAddress: string; authToken: string };
}

export async function addParticipant(cgId: string, agentAddress: string, nodeNum = 1): Promise<Response> {
  return devnetApiFetch(`/api/context-graph/${encodeURIComponent(cgId)}/add-participant`, {
    method: 'POST',
    nodeNum,
    body: JSON.stringify({ agentAddress }),
  });
}

export function devnetNodeHome(num: number): string | null {
  return readDevnetNode(num)?.home ?? null;
}
