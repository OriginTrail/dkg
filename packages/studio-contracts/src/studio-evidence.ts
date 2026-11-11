import { STUDIO_MAX_INPUTS, STUDIO_MAX_OUTPUTS } from './studio-interface-limits.js';
import {
  studioRecord,
  studioUuid,
  sha,
  bounded,
  programIri,
  blockId,
  invalid,
} from './studio-values.js';
import { parseStudioGraph } from './studio-graph.js';
export { studioRecord, studioUuid } from './studio-values.js';
export { parseStudioGraph } from './studio-graph.js';
import type { StudioReusableComponent } from './studio-composition.js';
import { canonicalJson } from './canonical-json.js';
import {
  expandStudioComponents,
  parseStudioReusableComponent,
  componentCapability,
} from './studio-composition.js';
import { isStudioParameter, type StudioParameter } from './studio-parameter.js';
export type { StudioParameter } from './studio-parameter.js';
export type StudioDescriptor = {
  id: string;
  name: string;
  category: string;
  nodeType: string;
  version: number;
  input: string;
  inputs?: 2;
  outputs: string[];
  mode: string;
  parameters: Record<string, StudioParameter>;
  sampleItems: Record<string, unknown>[];
  connection?: string;
  writes?: boolean;
};
export type StudioCapability = {
  reusable?: StudioReusableComponent;
  /** Authoring adapters; absent on the native KA protocol. Library entries grant no execution. */
  adapter?: 'document' | 'library';
  kaRef: string;
  sourceHash: string;
  graphId: string;
  name: string;
  version: string;
  kind: 'component' | 'program';
  operationIri?: string;
  authorAgentAddress?: string;
  language?: string;
  available: boolean;
  retired?: boolean;
  requiresExportAuthorization?: boolean;
  unavailableReason?: string;
  descriptor: StudioDescriptor;
};
export type {
  StudioBlock,
  StudioEdge,
  StudioGraph,
  StudioDefinition,
} from './workflow-definition.js';
import type { StudioDefinition } from './workflow-definition.js';
export type StudioWorkflow = {
  unavailableReason?: string;
  definition: StudioDefinition;
  kaRef: string;
  sourceHash: string;
  graphId: string;
  mode: string;
  approved: boolean;
  requiresExportAuthorization: boolean;
  activation: { active: boolean; count?: number; expiresAt?: number };
  readbackVerified: true;
};
export type StudioOutput = {
  ok: boolean;
  itemsJson: string;
  portsJson: string;
  error: string;
  traceJson?: string;
};
export type StudioReceipt = {
  kaRef: string;
  sourceHash: string;
  /** Account-scoped API idempotency key, when distinct from the executor invocation. */
  runKey?: string;
  invocationId: string;
  executionIri: string;
  executor?: 'n8n' | 'dkg';
  n8nExecutionId?: string;
  workflowSha256?: string;
  output: StudioOutput;
  /** Account-scoped journal diagnostic; never rewrites the retained native output. */
  failure?: {
    nodeId: string;
    code: 'GRAPH_CREATE_REFUSED' | 'GRAPH_ALREADY_EXISTS' | 'GRAPH_CREATE_UNCONFIRMED';
  };
  persisted: true;
  readbackVerified: true;
  steps?: {
    nodeId: string;
    componentId: string;
    kaRef: string;
    node: string;
    status: string;
    items: number[];
    outputHash: string;
    sourceHash?: string;
    programVersion?: string;
    executionIris?: string[];
    n8nExecutionIds?: string[];
  }[];
};
export type StudioHistory = {
  activation: StudioWorkflow['activation'];
  eventPath?: string;
  executions: { invocationId: string; triggerExecutionId: string; receipt: StudioReceipt | null }[];
};
/** Account projection of a manual invocation. Receipt fields retain their runtime-issued ids. */
export type StudioRun = {
  accountId: string;
  runKey: string;
  startedBy: string;
  createdAt: number;
  target: { jobId: string; peerId: string };
  workflow: StudioWorkflow;
  state: 'unconfirmed' | 'succeeded' | 'failed' | 'refused';
  receipt: StudioReceipt | null;
};
export type StudioRunPage = { items: StudioRun[]; nextCursor: string | null };

export function parseStudioRun(v: unknown, accountId: string): StudioRun {
  if (
    !studioRecord(v) ||
    v.accountId !== accountId ||
    !studioUuid(v.runKey) ||
    !bounded(v.startedBy, 128) ||
    !Number.isSafeInteger(v.createdAt) ||
    Number(v.createdAt) < 0 ||
    Number(v.createdAt) > 8.64e15 ||
    !studioRecord(v.target) ||
    !bounded(v.target.jobId, 128) ||
    !bounded(v.target.peerId, 200) ||
    !['unconfirmed', 'succeeded', 'failed', 'refused'].includes(String(v.state))
  )
    return invalid();
  const workflow = parseStudioWorkflow(v.workflow);
  if (['succeeded', 'failed'].includes(String(v.state))) {
    const receipt = parseStudioWorkflowReceipt(v.receipt, workflow, v.runKey);
    if ((v.state === 'succeeded') !== receipt.output.ok) return invalid();
  } else if (v.receipt !== null) return invalid();
  return v as StudioRun;
}
export function parseStudioCapability(v: unknown): StudioCapability {
  if (
    !studioRecord(v) ||
    !bounded(v.kaRef, 240) ||
    !(v.kind === 'program' ? programIri(v.kaRef) : /^urn:(?:nos|demo:n8n):component:[a-z0-9:-]{1,160}$/.test(v.kaRef)) ||
    !sha(v.sourceHash) ||
    typeof v.available !== 'boolean' ||
    !['component', 'program'].includes(String(v.kind)) ||
    !bounded(v.name, 80) ||
    !bounded(v.graphId, 80) ||
    !bounded(v.version, 80) ||
    !studioRecord(v.descriptor)
  )
    return invalid();
  const d = v.descriptor;
  if (
    !blockId(d.id) ||
    !bounded(d.name, 80) ||
    !bounded(d.category, 40) ||
    !bounded(d.nodeType, 100) ||
    !(v.kind === 'program'
      ? d.nodeType === 'dkg.program' &&
        d.id === 'run-program' &&
        d.mode === 'program' &&
        programIri(v.operationIri) &&
        bounded(v.authorAgentAddress, 100)
      : v.reusable
        ? d.nodeType === 'nos.workflow' && d.id === 'workflow-component'
        : String(d.nodeType).startsWith('n8n-nodes-base.')) ||
    !bounded(d.input, 20) ||
    !bounded(d.mode, 30) ||
    ![1, 2].includes(Number(d.version)) ||
    !Array.isArray(d.outputs) ||
    d.outputs.length > STUDIO_MAX_OUTPUTS ||
    !d.outputs.every((p) => bounded(p, 30)) ||
    !studioRecord(d.parameters) ||
    Object.keys(d.parameters).length > STUDIO_MAX_INPUTS ||
    !Array.isArray(d.sampleItems) ||
    d.sampleItems.length > 20 ||
    !d.sampleItems.every(studioRecord) ||
    (d.inputs !== undefined && d.inputs !== 2)
  )
    return invalid();
  for (const parameter of Object.values(d.parameters))
    if (!isStudioParameter(parameter)) return invalid();
  if (v.reusable !== undefined) {
    const recipe = parseStudioReusableComponent(v.reusable);
    const expected = componentCapability(v.kaRef, v.sourceHash, v.graphId, recipe, v.available);
    if (canonicalJson(v.descriptor) !== canonicalJson(expected.descriptor)) return invalid();
  }
  return v as StudioCapability;
}
export function parseStudioDefinition(v: unknown, draft = false): StudioDefinition {
  if (!studioRecord(v)) return invalid();
  const { composition, ...body } = v;
  const graph = parseStudioGraph(body, draft);
  if (composition !== undefined) {
    if (!studioRecord(composition) || !Array.isArray(composition.components)) return invalid();
    const authored = parseStudioGraph(composition.definition);
    const components = composition.components.map((item: unknown) => {
      if (!studioRecord(item) || !bounded(item.kaRef, 240) || !sha(item.sourceHash))
        return invalid();
      return {
        kaRef: item.kaRef,
        sourceHash: item.sourceHash,
        recipe: parseStudioReusableComponent(item.recipe),
      };
    });
    const expanded = expandStudioComponents(authored, components).definition;
    if (
      canonicalJson(JSON.parse(studioFingerprint(graph))) !==
      canonicalJson(JSON.parse(studioFingerprint(expanded)))
    )
      return invalid();
  }
  return v as StudioDefinition;
}
export function studioFingerprint(v: StudioDefinition) {
  return JSON.stringify({
    ...v,
    nodes: [...v.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...v.edges].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
}
export function parseStudioWorkflow(v: unknown): StudioWorkflow {
  if (
    !studioRecord(v) ||
    !bounded(v.kaRef, 240) ||
    !v.kaRef.startsWith('urn:demo:nos:studio:') ||
    !sha(v.sourceHash) ||
    !bounded(v.graphId, 80) ||
    typeof v.approved !== 'boolean' ||
    (v.unavailableReason !== undefined && (!bounded(v.unavailableReason, 500) || v.approved)) ||
    typeof v.requiresExportAuthorization !== 'boolean' ||
    !bounded(v.mode, 30) ||
    v.readbackVerified !== true ||
    !studioRecord(v.activation) ||
    typeof v.activation.active !== 'boolean'
  )
    return invalid();
  parseStudioDefinition(v.definition);
  return v as StudioWorkflow;
}
export function parseStudioOutput(v: unknown): StudioOutput {
  if (
    !studioRecord(v) ||
    typeof v.ok !== 'boolean' ||
    !bounded(v.itemsJson) ||
    !bounded(v.portsJson) ||
    !bounded(v.error, 512) ||
    (v.traceJson !== undefined && !bounded(v.traceJson))
  )
    return invalid();
  const items: unknown = JSON.parse(v.itemsJson),
    ports: unknown = JSON.parse(v.portsJson);
  if (
    !Array.isArray(items) ||
    items.length > 20 ||
    !items.every(studioRecord) ||
    !studioRecord(ports) ||
    Object.keys(ports).length > 16 ||
    !Object.values(ports).every((p) => Array.isArray(p) && p.length <= 20 && p.every(studioRecord))
  )
    return invalid();
  return v as StudioOutput;
}
export function parseStudioReceipt(
  v: unknown,
  ref: { kaRef: string; sourceHash: string },
  invocationId: string,
): StudioReceipt {
  if (
    !studioRecord(v) ||
    v.kaRef !== ref.kaRef ||
    v.sourceHash !== ref.sourceHash ||
    (v.runKey === undefined
      ? v.invocationId !== invocationId
      : v.runKey !== invocationId || !studioUuid(v.runKey) || !studioUuid(v.invocationId)) ||
    v.executionIri !== `urn:sr:execution:${v.invocationId}` ||
    (v.executor !== undefined && !['n8n', 'dkg'].includes(String(v.executor))) ||
    (v.executor === 'dkg' && (v.n8nExecutionId !== undefined || v.workflowSha256 !== undefined)) ||
    (v.executor !== 'dkg' &&
      (!bounded(v.n8nExecutionId, 20) ||
        !/^\d+$/.test(v.n8nExecutionId) ||
        !sha(v.workflowSha256))) ||
    v.persisted !== true ||
    v.readbackVerified !== true
  )
    return invalid();
  parseStudioOutput(v.output);
  if (
    v.steps !== undefined &&
    (!Array.isArray(v.steps) ||
      !v.steps.every(
        (s) =>
          studioRecord(s) &&
          blockId(s.nodeId) &&
          blockId(s.componentId) &&
          bounded(s.kaRef, 240) &&
          bounded(s.node, 80) &&
          ['completed', 'failed', 'skipped'].includes(String(s.status)) &&
          Array.isArray(s.items) &&
          s.items.every((n) => Number.isInteger(n) && Number(n) >= 0) &&
          sha(s.outputHash) &&
          (s.sourceHash === undefined || sha(s.sourceHash)) &&
          (s.programVersion === undefined || bounded(s.programVersion, 80)) &&
          (s.executionIris === undefined ||
            (Array.isArray(s.executionIris) &&
              s.executionIris.length <= 20 &&
              s.executionIris.every(
                (iri) => typeof iri === 'string' && /^urn:sr:execution:[a-f0-9-]{36}$/.test(iri),
              ))),
      ))
  )
    return invalid();
  if (
    v.failure !== undefined &&
    (!studioRecord(v.failure) ||
      Object.keys(v.failure).some((key) => !['nodeId', 'code'].includes(key)) ||
      !blockId(v.failure.nodeId) ||
      !['GRAPH_CREATE_REFUSED', 'GRAPH_ALREADY_EXISTS', 'GRAPH_CREATE_UNCONFIRMED'].includes(
        String(v.failure.code),
      ) ||
      !studioRecord(v.output) ||
      v.output.ok !== false ||
      !Array.isArray(v.steps) ||
      !v.steps.some(
        (step) =>
          step.nodeId === (v.failure as { nodeId: string }).nodeId &&
          step.status === 'failed' &&
          step.componentId === 'dkg-create-context-graph',
      ))
  )
    return invalid();
  return v as StudioReceipt;
}

/** The same workflow/step binding applies to a fresh response and its historical projection. */
export function parseStudioWorkflowReceipt(
  value: unknown,
  workflow: StudioWorkflow,
  invocationId: string,
): StudioReceipt {
  const receipt = parseStudioReceipt(value, workflow, invocationId);
  const nodes = [...workflow.definition.nodes].sort((a, b) => a.id.localeCompare(b.id));
  if (
    !receipt.steps ||
    receipt.steps.length !== nodes.length ||
    receipt.steps.some((step, index) => {
      const node = nodes[index]!;
      return (
        step.nodeId !== node.id ||
        step.kaRef !== node.kaRef ||
        step.componentId !== node.componentId ||
        (receipt.executor === 'dkg' &&
          (step.sourceHash !== node.sourceHash ||
            !step.executionIris ||
            (node.componentId === 'run-program' && step.programVersion !== node.params.version)))
      );
    })
  )
    return invalid();
  return receipt;
}
