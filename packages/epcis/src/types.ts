// EPCIS Document types based on GS1 EPCIS 2.0

export interface EPCISDocument {
  '@context': string | string[] | Record<string, unknown>;
  type: 'EPCISDocument';
  schemaVersion: string;
  creationDate: string;
  epcisBody?: {
    eventList: EPCISEvent[];
  };
  eventList?: EPCISEvent[];
  [key: string]: unknown;
}

/** Standard event fields reconstructed by queries and accepted by captures. */
export interface EPCISEventFields {
  eventID?: string;
  type?: string;
  eventTime?: string;
  eventTimeZoneOffset?: string;
  configurationId?: string;
  shipmentId?: string;
  epcList?: string[];
  parentID?: string;
  childEPCs?: string[];
  inputEPCList?: string[];
  outputEPCList?: string[];
  action?: string;
  bizStep?: string;
  disposition?: string;
  readPoint?: { id: string };
  bizLocation?: { id: string };
}

export interface EPCISEvent extends EPCISEventFields {
  type: string;
  eventTime: string;
  bizTransactionList?: Array<{ type: string; bizTransaction: string }>;
  sensorElementList?: unknown[];
  [key: string]: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
  eventCount?: number;
}

export interface CaptureAcceptedResult {
  captureID: string;
  receivedAt: string;
  eventCount: number;
  status: 'accepted';
}

export interface CaptureOptions {
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers?: string[];
}

/**
 * Options the EPCIS handler hands to the async publisher. Wire-level
 * `publishOptions` (CaptureOptions) plus a per-payload `subGraphName`
 * lifted from the top of the capture body.
 */
export interface PublisherCaptureOpts extends CaptureOptions {
  subGraphName?: string;
}

export interface AsyncPublisher {
  publishAsync(
    contextGraphId: string,
    content: unknown,
    opts?: PublisherCaptureOpts,
  ): Promise<{ captureID: string }>;
}

// --- Events query types ---

export interface EpcisQueryParams {
  eventID?: string;
  epc?: string;
  bizStep?: string;
  bizLocation?: string;
  from?: string;
  to?: string;
  parentID?: string;
  childEPC?: string;
  inputEPC?: string;
  outputEPC?: string;
  anyEPC?: string;
  configurationId?: string;
  shipmentId?: string;
  eventType?: string;
  action?: string;
  disposition?: string;
  readPoint?: string;
  finalized?: boolean;
  subGraphName?: string;
  perPage?: number;
  limit?: number;
  offset?: number;
}

/** Generic SELECT row; unbound columns remain undefined until a consumer decodes them. */
export type SparqlBinding = Record<string, string | undefined>;

/** Dependency-inversion boundary: the EPCIS package needs something that can run SPARQL queries. */
export interface QueryEngine {
  query(
    sparql: string,
    opts?: {
      contextGraphId?: string;
      /**
       * Sub-graph name within the context graph. Must match the sub-graph
       * the query was built for so the engine's scope guard admits the
       * `<cg>/<sub>` data graph (and the sub-graph private/meta graphs).
       */
      subGraphName?: string;
      /**
       * Route the scoped read to the shared-memory partition
       * (`<cg>[/<sub>]/_shared_memory`). Set for `finalized=false` queries,
       * which read non-finalized (SWM) events.
       */
      graphSuffix?: '_shared_memory';
      /**
       * Allow the scoped query to reference the context graph's own
       * `_private` partition. The EPCIS events query always references
       * `<cg>[/<sub>]/_private`, so this must be set or the engine's scope
       * guard rejects the query.
       */
      includePrivate?: boolean;
    },
  ): Promise<{ bindings: SparqlBinding[] }>;
}

/** Legacy sparse projection: typed known fields plus dynamically inspected extension fields. */
export interface EPCISEventProjection extends Omit<EPCISEventFields, 'eventID'> {
  'dkg:ual'?: string;
  [key: string]: unknown;
}

/** Query response adds the validated reusable identity to the open projection contract. */
export interface EPCISQueryEvent extends EPCISEventProjection {
  eventID: string;
}

export interface EPCISQueryDocumentResponse {
  '@context': Array<string | Record<string, string>>;
  type: 'EPCISQueryDocument';
  schemaVersion: '2.0';
  epcisBody: {
    queryResults: {
      queryName: 'SimpleEventQuery';
      resultsBody: {
        eventList: EPCISQueryEvent[];
      };
    };
  };
}
