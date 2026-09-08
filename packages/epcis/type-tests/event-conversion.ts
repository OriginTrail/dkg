import { toEpcisEvent, handleEventsQuery, type EPCISEventFields, type EPCISEvent, type EPCISQueryEvent, type EPCISEventProjection, type SparqlBinding, type QueryEngine } from '../dist/index.js';

// Existing QueryEngine consumers pass generic rows to this public helper.
const row: Record<string, string> = { event: 'urn:event:1' };
const event = toEpcisEvent(row);
const sparseProjection: EPCISEventProjection = toEpcisEvent({ eventTime: '"2026-09-07T00:00:00Z"' });
const projectedTime: string | undefined = sparseProjection.eventTime;
// @ts-expect-error The sparse converter never reconstructs eventID, even as an optional property.
const uncheckedProjectionId = event.eventID;
void [projectedTime, uncheckedProjectionId];

// Reconstructed standard fields retain their useful types.
const timestamp: string | undefined = event.eventTime?.toUpperCase();
const readPoint: string | undefined = event.readPoint?.id;
const firstChild: string | undefined = event.childEPCs?.[0];
const provenance: string | undefined = event['dkg:ual'];
// @ts-expect-error Arbitrary capture extensions are not reconstructed.
const extension = event['example:extension'];
// @ts-expect-error Capture transactions are not reconstructed.
const transactions = event.bizTransactionList;
void transactions;
void [timestamp, readPoint, firstChild, provenance, extension];

// @ts-expect-error Standard fields cannot drift to untyped extension values.
event.readPoint = 'urn:location:1';
// @ts-expect-error Every query result requires its reusable identifier.
const missingId: EPCISQueryEvent = { eventTime: '2026-09-07T00:00:00Z' };
void missingId;

// Exercise the complete public response path, not just the standalone event type.
declare const response: Awaited<ReturnType<typeof handleEventsQuery>>;
const responseEvent = response.body.epcisBody.queryResults.resultsBody.eventList[0];
const responseId: string = responseEvent.eventID;
const responseTime: string | undefined = responseEvent.eventTime;
const responseLocation: { id: string } | undefined = responseEvent.bizLocation;
const responseEpcs: string[] | undefined = responseEvent.epcList;
void [responseId, responseTime, responseLocation, responseEpcs];
// @ts-expect-error The response must not widen back to generic record values.
responseEvent.eventTime = 42;
// @ts-expect-error Unsupported capture fields are absent through the public response.
void responseEvent.sensorElementList;

// Raw query rows do not promise that OPTIONAL or even required aliases were bound.
const sparseRow: SparqlBinding = { event: undefined, eventTime: undefined };
// @ts-expect-error The raw store boundary requires validation before using the event ID.
const uncheckedId: string = sparseRow.event;
void uncheckedId;
const genericEngine: QueryEngine = { query: async () => ({ bindings: [row] }) };
const sparseEngine: QueryEngine = { query: async () => ({ bindings: [sparseRow] }) };
void [genericEngine, sparseEngine];

// The generic engine accepts unrelated projections; EPCIS aliases belong to decoding.
const countEngine: QueryEngine = { query: async () => ({ bindings: [{ count: '1' }] }) };
void countEngine;

// Capture and query share standard field types without sharing extensibility or requirements.
declare const fields: EPCISEventFields;
const capture: EPCISEvent = { ...fields, type: 'ObjectEvent', eventTime: '2026-09-07T00:00:00Z', 'example:extension': 42 };
const projected: EPCISQueryEvent = { ...fields, eventID: 'urn:event:1' };
// @ts-expect-error Capture still requires its event type and timestamp.
const incompleteCapture: EPCISEvent = { eventID: 'urn:event:1' };
void [capture, projected, incompleteCapture];
