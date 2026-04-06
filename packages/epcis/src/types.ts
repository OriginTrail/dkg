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

export interface EPCISEvent {
  type: string;
  eventTime: string;
  eventTimeZoneOffset?: string;
  epcList?: string[];
  action?: string;
  bizStep?: string;
  disposition?: string;
  readPoint?: { id: string };
  bizLocation?: { id: string };
  bizTransactionList?: Array<{ type: string; bizTransaction: string }>;
  sensorElementList?: unknown[];
  [key: string]: unknown;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
  eventCount?: number;
}

export interface CaptureResult {
  ual: string;
  kcId: string;
  receivedAt: string;
  eventCount: number;
  status: string;
}

export interface CaptureOptions {
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers?: string[];
}

/** Dependency-inversion boundary: the EPCIS package needs something that can publish JSON-LD. */
export interface Publisher {
  publish(
    contextGraphId: string,
    content: unknown,
    opts?: CaptureOptions,
  ): Promise<{ ual: string; kcId: string; status: string }>;
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
  eventType?: string;
  action?: string;
  disposition?: string;
  readPoint?: string;
  perPage?: number;
  limit?: number;
  offset?: number;
}

/** Dependency-inversion boundary: the EPCIS package needs something that can run SPARQL queries. */
export interface QueryEngine {
  query(
    sparql: string,
    opts?: { contextGraphId?: string },
  ): Promise<{ bindings: Record<string, string>[] }>;
}

export interface EPCISQueryDocumentResponse {
  '@context': Array<string | Record<string, string>>;
  type: 'EPCISQueryDocument';
  schemaVersion: '2.0';
  epcisBody: {
    queryResults: {
      queryName: 'SimpleEventQuery';
      resultsBody: {
        eventList: Record<string, unknown>[];
      };
    };
  };
}
