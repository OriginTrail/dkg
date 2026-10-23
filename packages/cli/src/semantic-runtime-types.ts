import { type LocalLlmProgramProvider } from './semantic-runtime-local-llm-adapter.js';
import { TypeScriptProgramHost, type ProgramExecutionTrace, RuntimeAdapterRegistry, SemanticRuntimeStore, type AdmittedPlanSummary, type SemanticProgramBinding, type SemanticRuntimeHost, type SemanticRuntimeHostOptions } from '@origintrail-official/dkg-semantic-runtime';
import { SemanticProgramConfiguration } from './semantic-runtime-configuration.js';

export interface StoredSemanticProgram {
  contextGraphId: string;
  programIri: string;
  layer: SemanticMemoryLayer;
  authorAgentAddress: string;
  language: string;
  version: string;
  source: string;
  requiredTools: string[];
  requestedPermissions?: Record<string, unknown>;
  permittedPrograms: string[];
  label?: string;
  description?: string;
}

export type SemanticMemoryLayer = 'wm' | 'swm' | 'vm';

export interface SemanticToolResolution {
  toolIri: string;
  operation: string | null;
  semanticVersion: string | null;
  witInterface: string | null;
  requested: true;
  offered: boolean;
  policyAllowed: boolean;
  locallyInstalled: boolean;
  locallyEnabled: boolean;
  adapterVersion: string | null;
  adapterHash: string | null;
  effective: boolean;
  unavailableReason: string | null;
}

export interface SemanticProgramResolution {
  contextGraphId: string;
  programIri: string;
  programLayer: SemanticMemoryLayer;
  executingNode: string;
  selectedPolicy: { iri: string; version: string; hash: string };
  requiredTools: SemanticToolResolution[];
  previousExecutions: string[];
  executable: boolean;
}

export interface SemanticInvocationResult {
  /** Intermediate results are only returned to the executor agent, never ordinary callers. */
  trace?: ProgramExecutionTrace;
  invocationId: string;
  executionIri: string;
  executionLayer: SemanticMemoryLayer;
  executionUal?: string;
  outputs?: string[];
  persisted: true;
}

export type SemanticProgramChildInvoker = (input: {
  contextGraphId: string;
  programIri: string;
  invocationId: string;
  programLayer: SemanticMemoryLayer;
  executionLayer: SemanticMemoryLayer;
  callerAgentAddress: string;
}) => Promise<SemanticInvocationResult>;

export interface SemanticProgramForkResult {
  programIri: string;
  programLayer: SemanticMemoryLayer;
  programUal?: string;
  authorAgentAddress: string;
  derivedFrom: string;
  persisted: true;
}

export class SemanticProgramError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public trace?: ProgramExecutionTrace,
  ) {
    super(message);
  }
}

export interface ConfiguredSemanticRuntimeService {
  readonly localLlmProvider?: LocalLlmProgramProvider;
  host: SemanticRuntimeHost;
  store: SemanticRuntimeStore;
  configuration: SemanticProgramConfiguration;
  typescript?: TypeScriptProgramHost;
  inFlight: Map<string, {
    requestIdentity: string;
    promise: Promise<SemanticInvocationResult>;
  }>;
  stop(): Promise<void>;
}

export interface ConfiguredSemanticRuntimeDeps {
  localLlmProvider?: LocalLlmProgramProvider;
  log: (message: string) => void;
  dataDirectory?: string;
  start?: (options: SemanticRuntimeHostOptions) => Promise<SemanticRuntimeHost>;
  openStore?: () => SemanticRuntimeStore;
  /** Only a management request already authenticated as owner/operator may opt in. */
  activate?: boolean;
}

/** Host-created context; never decoded from an HTTP or inbox payload. */
export interface BoundProgramInvocation {
  binding: SemanticProgramBinding;
  digest: string;
  assertAuthorized(): Promise<void>;
}

export interface TypeScriptComposition {
  ancestors: string[];
  budget: { calls: number; maximum: number; deadline: number; cancelled: boolean; uncertainEffect?: SemanticProgramError };
  assertParent(): Promise<void>;
}

export interface LocalInvocationScope {
  ancestors: string[];
  assertAncestors?: () => Promise<void>;
}

export interface InternalResolution {
  public: SemanticProgramResolution;
  program: StoredSemanticProgram;
  plan: AdmittedPlanSummary;
  registry: RuntimeAdapterRegistry;
  operatorAddress: string;
  policyHashHex: string;
}

export interface PersistenceEvidence {
  layer: SemanticMemoryLayer;
  ual?: string;
}
