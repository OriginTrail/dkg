import type {
  AdmittedPlanSummary,
  AdmissionDiagnostic,
  PlanApplyResult,
  StartedPlanInspection,
} from './codec.js';

/** Immutable authority facts bound to one component execution resource. */
export interface ExecutionCapabilityDescriptor {
  executionId: string;
  invocationId: string;
  contextGraphId: string;
  callerPrincipal: string;
  programIri: string;
  sourceHash: string;
  planHash: string;
  outputLayer: 'WM' | 'SWM' | 'VM';
  tools: Array<{
    operation: string;
    version: string;
    witInterface: string;
  }>;
  policy: {
    iri: string;
    epoch: bigint;
    hash: string;
  };
  budgets: {
    maxOperations: number;
    maxToolCalls: number;
    maxModelTokens: number;
    maxDkgQueries: number;
  };
  expiresAt: number;
  revoked: boolean;
  approvals: string[];
}

export interface ComponentCompileResult {
  ok: true;
  plan: AdmittedPlanSummary;
}

export interface ComponentCompileFailure {
  ok: false;
  diagnostics: AdmissionDiagnostic[];
}

export type ComponentCompileOutcome = ComponentCompileResult | ComponentCompileFailure;

export interface ComponentStartResult extends StartedPlanInspection {
  instanceId: string;
}

export type ComponentExecutionResult = Extract<PlanApplyResult, { kind: 'completed' }>;

export type ComponentToolCall =
  | {
    kind: 'investigator';
    effectId: bigint;
    prompt: string;
  }
  | {
    kind: 'query-catalog';
    effectId: bigint;
    queryId: string;
    parameters: Array<{ name: string; value: string }>;
  }
  | {
    kind: 'remote-execute';
    effectId: bigint;
    nodeId: string;
    programIri: string;
  };

export type ComponentToolResult =
  | { kind: 'investigator'; output: string }
  | { kind: 'query-catalog'; json: string }
  | { kind: 'remote-execute'; executionIri: string; executionUal?: string };

export type ComponentToolDispatcher = (
  call: ComponentToolCall,
) => Promise<ComponentToolResult>;

export type ComponentOperationResult =
  | ComponentCompileOutcome
  | AdmittedPlanSummary
  | ComponentStartResult
  | ComponentExecutionResult
  | StartedPlanInspection
  | { dropped: true };

export function defaultExecutionCapability(
  planHash: string,
  maxOperations = 10_000,
): ExecutionCapabilityDescriptor {
  return {
    executionId: `urn:sr:execution:test:${planHash}`,
    invocationId: `test:${planHash}`,
    contextGraphId: 'test',
    callerPrincipal: 'did:dkg:agent:test',
    programIri: 'urn:sr:program:test',
    sourceHash: planHash,
    planHash,
    outputLayer: 'WM',
    tools: [],
    policy: {
      iri: 'urn:sr:policy:test-deny-all',
      epoch: 0n,
      hash: '0'.repeat(64),
    },
    budgets: {
      maxOperations,
      maxToolCalls: 0,
      maxModelTokens: 0,
      maxDkgQueries: 0,
    },
    expiresAt: Number.MAX_SAFE_INTEGER,
    revoked: false,
    approvals: [],
  };
}
