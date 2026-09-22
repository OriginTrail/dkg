/** Compatible with ethers Wallet, hardware wallets and external signing services. */
export interface AgentSigner {
  getAddress(): Promise<string>;
  signMessage(message: string | Uint8Array): Promise<string>;
}

export type MemoryLayer = 'wm' | 'swm' | 'vm';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type GraphComputerOptions = GraphComputerConnection & (
  | { signer: AgentSigner; localAgent?: never }
  | { signer?: never; localAgent: { address: string; authToken: string } }
);

interface GraphComputerConnection {
  nodeUrl: string;
  /** Receiving node's physical peer ID, obtained through trusted configuration. */
  peerId: string;
  /** Set for remote execution through this node. May be overridden per invocation. */
  executorPeerId?: string;
  /** Per-attempt deadline, including signing and reading the response. Default 60 seconds. */
  timeoutMs?: number;
  /** Additional attempts for reads/invocations only. Default 2; maximum 5. */
  retries?: number;
  /** Initial exponential retry delay. Default 250 ms, capped at 5 seconds. */
  retryDelayMs?: number;
  /** Maximum HTTP response size. Default 4 MiB. */
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions { signal?: AbortSignal }
export interface Operation { graphId: string; operationIri: string }
export interface RevisionedOperation extends Operation { expectedRevision: number }

/** Exact source pins returned by upload; safe to pass directly to approve. */
export interface ProgramReference {
  graphId: string;
  programIri: string;
  programLayer: MemoryLayer;
  authorAgentAddress: string;
  sourceHash: string;
}

export interface UploadProgram {
  graphId: string;
  source: string;
  language?: 'sexpr-v1' | 'typescript-v1';
  /** Child Program IRIs declared by TypeScript source; approval pins their operation grants. */
  permittedPrograms?: string[];
  /** Previous Program IRI when saving an edited version. */
  derivedFrom?: string;
  /** Defaults to a fresh urn:dkg:program:<UUID>. Use a new IRI for a new version. */
  programIri?: string;
  /** Knowledge Asset name; defaults to a fresh program-<UUID>. */
  name?: string;
  /** Human-readable RDF label, defaulting to the asset name. */
  label?: string;
  version?: string;
  /** Tool IRIs declared by the Program. This does not grant permission to use them. */
  requiredTools: string[];
  /** Stored request only; the graph owner must separately approve these permissions. */
  requestedPermissions?: RequestedToolPermissions;
}

export interface StoredProgram {
  label?: string;
  contextGraphId: string;
  programIri: string;
  layer: MemoryLayer;
  language: 'sexpr-v1' | 'typescript-v1';
  version: string;
  source: string;
  sourceHash: string;
  authorAgentAddress: string;
  requiredTools: string[];
  /** Stored request only; the graph owner must separately approve these permissions. */
  requestedPermissions?: RequestedToolPermissions;
  permittedPrograms: string[];
}

export interface UploadedProgram extends ProgramReference {
  name: string;
  /** Unmodified Knowledge Asset lifecycle response. */
  asset: Record<string, unknown>;
}

/** The closed, bounded schema accepted by the Program approval API. */
export type OutputSchema =
  | { type: 'object'; properties: Record<string, OutputSchema>; required: string[]; additionalProperties: false }
  | { type: 'array'; items: OutputSchema; minItems?: number; maxItems: number }
  | { type: 'string'; minLength?: number; maxLength: number; enum?: string[]; format?: 'rdf-integer' | 'rdf-decimal' | 'rdf-boolean' }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' | 'null' };

export interface SparqlReadPermission {
  toolIri: string;
  layer: MemoryLayer;
  timeoutMs: number;
  maxResultItems: number;
  maxOutputBytes: number;
  outputSchema: OutputSchema;
}

export interface QueryPermission { selector: string; outputSchema: OutputSchema }

export interface ApproveProgram extends Operation {
  program: ProgramReference;
  allowedCallers: string[];
  /** Defaults to this client's signer. The executor needs that custodial identity. */
  executorAgentAddress?: string;
  executionLayer?: MemoryLayer;
  sparqlRead?: SparqlReadPermission;
  query?: QueryPermission;
  assetCreation?: { toolIri: string };
  typescript?: {
    /** Pinned tool identities; the server fills these from the stored Program. */
    requiredTools?: string[];
    children: Array<{ graphId: string; operationIri: string; programIri?: string; bindingDigest?: string }>;
    maxCalls?: number; maxConcurrency?: number; timeoutMs?: number;
  };
}

/** Server response, retaining canonical wire field names and computed pins. */
export interface ProgramBinding {
  contextGraphId: string;
  operationIri: string;
  enabled: boolean;
  allowedCallerAgentAddresses: string[];
  executorAgentAddress: string;
  authorizationRevision?: number;
  program: Omit<ProgramReference, 'graphId'> & { contextGraphId: string };
  executionLayer?: MemoryLayer;
  sparqlRead?: SparqlReadPermission & { outputSchemaSha256: string };
  query?: QueryPermission & { queryIri: string; definitionSha256: string; outputSchemaSha256: string };
  assetCreation?: { toolIri: string };
  typescript?: {
    /** Pinned tool identities; the server fills these from the stored Program. */
    requiredTools?: string[];
    children: Array<{ contextGraphId: string; operationIri: string; programIri: string; bindingDigest: string }>;
    maxCalls: number; maxConcurrency: number; timeoutMs: number;
  };
}

export interface ConfigurationRecord {
  contextGraphId: string;
  operationIri: string;
  revision: number;
  origin: 'api' | 'configuration-file';
  updatedBy?: string;
  updatedAt?: number;
}

export interface Approval extends ConfigurationRecord {
  binding: ProgramBinding;
  bindingDigest: string;
  resolution?: { executable: boolean; [key: string]: unknown };
}

export interface ProgramRoute extends Operation { targetPeerId: string }
export interface Route extends ConfigurationRecord {
  route: { contextGraphId: string; operationIri: string; targetPeerId: string } | null;
}

export interface InvokeProgram extends Operation {
  /** TypeScript run(...inputs) arguments. Signed and retained on every retry. */
  inputs?: JsonValue[];
  /** Omit for a new execution; retain the ID for every retry of that execution. */
  invocationId?: string;
  executorPeerId?: string;
}

/** Persist this before sending when recovery across application restarts matters. */
export interface PreparedInvocation extends InvokeProgram { invocationId: string }

export interface ProgramCallTrace {
  id: string; kind: 'tool' | 'program'; target: string;
  startedAt: string; durationMs?: number; status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  result?: JsonValue; resultTruncated?: boolean; error?: string; executionIri?: string;
}
/** Detailed intermediate results are returned only to the operation's executor agent. */
export interface ProgramExecutionTrace {
  version: 1; executionIri: string; startedAt: string; durationMs?: number;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'; calls: ProgramCallTrace[];
  failure?: { location: string; message: string };
}

export interface Execution {
  trace?: ProgramExecutionTrace;
  invocationId: string;
  executionIri: string;
  executionLayer: MemoryLayer;
  executionUal?: string;
  persisted: true;
  /** JSON outputs are decoded; plain-text outputs remain strings. RDF terms are unchanged. */
  outputs: JsonValue[];
  rawOutputs: string[];
}

/** Exact requested tool scope stored with a TypeScript Program. Never grants authority itself. */
export interface RequestedToolPermissions {
  graphId: string;
  executionLayer?: MemoryLayer;
  query?: QueryPermission;
  sparqlRead?: SparqlReadPermission;
  assetCreation?: { toolIri: string };
}
