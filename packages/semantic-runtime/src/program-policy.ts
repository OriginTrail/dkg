/** A closed, bounded contract for the actual result returned by a named query. */
export type SemanticQueryOutputSchema =
  | { type: 'object'; properties: Record<string, SemanticQueryOutputSchema>; required: string[]; additionalProperties: false }
  | { type: 'array'; items: SemanticQueryOutputSchema; minItems?: number; maxItems: number }
  | { type: 'string'; minLength?: number; maxLength: number; enum?: string[]; format?: 'rdf-integer' | 'rdf-decimal' | 'rdf-boolean' }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' | 'null' };

export interface SemanticQueryPin {
  selector: string;
  queryIri: string;
  definitionSha256: string;
  outputSchema: SemanticQueryOutputSchema;
  outputSchemaSha256: string;
}

export interface SemanticProgramPin {
  programIri: string;
  sourceHash: string;
  /** Omission permits no named queries in pinned execution mode. */
  queries?: SemanticQueryPin[];
}

/** Explicit permission to send a prompt and selected child outputs to a model. */
export interface SemanticDisclosurePolicy {
  policyId: string;
  promptSha256s: string[];
  programs: Array<{
    programIri: string;
    sourceHash: string;
    outputIndexes: number[];
    /** Omission releases each complete selected output string. Pointers select scalars only. */
    allowedJsonPointers?: string[];
  }>;
}

/** Operator-owned local execution policy; never taken from invocation input or a Program. */
export interface SemanticProgramPolicy {
  contextGraphIds: string[];
  programs: SemanticProgramPin[];
  /** Without a disclosure policy, model effects are unavailable in pinned mode. */
  disclosure?: SemanticDisclosurePolicy;
}

/** Raw reads use the tenant-selected graph, layer and closed result contract. */
export interface SemanticSparqlReadGrant {
  toolIri: string;
  layer: 'wm' | 'swm' | 'vm';
  timeoutMs: number;
  maxResultItems: number;
  maxOutputBytes: number;
  outputSchema: SemanticQueryOutputSchema;
  outputSchemaSha256: string;
}

/** A reviewed n8n workflow exposed through a TypeScript Program KA. */
export interface SemanticN8nGrant {
  toolIri: 'urn:dkg:tool:n8n';
  workflowId: string;
  workflowSha256: string;
  inputSchema: SemanticQueryOutputSchema;
  outputSchema: SemanticQueryOutputSchema;
  /** Read native node results after an early webhook acknowledgement. */
  result?: {
    nodes: string[];
    ports?: string[];
    traceNodes?: string[];
    sinks?: { node: string; port: number; name: string }[];
    allowObservation?: boolean;
  };
}

/** Operator installation. Credentials never belong to a Program or approval. */
export interface SemanticN8nConfig {
  baseUrl: string;
  apiTokenFile: string;
  webhookTokenFile: string;
  workflows: Array<{
    contextGraphId: string;
    executorAgentAddress: string;
    workflowId: string;
    workflowSha256: string;
  }>;
}

/** Tenant-owned invoke grant. Only the host may select the executor and data graph. */
export interface SemanticProgramBinding {
  /** API-owned permission revision; changes invalidate previous invocation identities. */
  authorizationRevision?: number;
  operationIri: string;
  contextGraphId: string;
  enabled: boolean;
  allowedCallerAgentAddresses: string[];
  executorAgentAddress: string;
  program: {
    contextGraphId: string;
    programIri: string;
    programLayer: 'wm' | 'swm' | 'vm';
    authorAgentAddress: string;
    sourceHash: string;
  };
  query?: SemanticQueryPin;
  sparqlRead?: SemanticSparqlReadGrant;
  /** Explicit tenant-approved creation tool; never inferred from read permission. */
  assetCreation?: { toolIri: string };
  /** Native graph-scoped read-only chat. Pins the operator model/tool configuration. */
  localLlm?: { toolIri: string; configurationSha256: string };
  /** Requires both this tenant grant and an operator-installed workflow. */
  n8n?: SemanticN8nGrant;
  /** TypeScript calls share these tool grants and may also invoke pinned child operations. */
  typescript?: SemanticTypeScriptGrant;
  /** Output assets inherit this execution layer; defaults to wm for compatibility. */
  executionLayer?: 'wm' | 'swm' | 'vm';
}

export interface SemanticTypeScriptGrant {
  /** Server-pinned requested tool identities. Omission permits no direct tools. */
  requiredTools?: string[];
  children: Array<{ contextGraphId: string; operationIri: string; programIri: string; bindingDigest: string }>;
  maxCalls: number;
  maxConcurrency: number;
  timeoutMs: number;
}
