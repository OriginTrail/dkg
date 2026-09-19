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
  /** Output assets inherit this execution layer; defaults to wm for compatibility. */
  executionLayer?: 'wm' | 'swm' | 'vm';
}
