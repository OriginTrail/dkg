import {
  handleEventsQuery,
  toEpcisEvent,
  type EPCISEventProjection,
  type EPCISQueryEvent,
  type QueryEngine,
  type SparqlBinding,
} from '../dist/index.js';

const row: Record<string, string> = { event: 'urn:event:1', eventTime: '"2026-09-07T00:00:00Z"' };
const projection: EPCISEventProjection = toEpcisEvent(row);
const projectedTime: string | undefined = projection.eventTime;
const projectedLocation: string | undefined = projection.readPoint?.id;
const projectedChildren: string | undefined = projection.childEPCs?.[0];
const dynamicProjection: unknown = projection['example:extension'];
void [projectedTime, projectedLocation, projectedChildren, dynamicProjection];

// The legacy converter does not promise a validated identity.
// @ts-expect-error eventID belongs only to decoded query responses.
const uncheckedProjectionId: string = projection.eventID;
void uncheckedProjectionId;

declare const response: Awaited<ReturnType<typeof handleEventsQuery>>;
const event = response.body.epcisBody.queryResults.resultsBody.eventList[0];
const eventID: string = event.eventID;
const eventTime: string | undefined = event.eventTime;
const readPoint: { id: string } | undefined = event.readPoint;
const epcs: string[] | undefined = event.epcList;
const provenance: string | undefined = event['dkg:ual'];
const dynamicResponseField: unknown = event['example:extension'];
void [eventID, eventTime, readPoint, epcs, provenance, dynamicResponseField];

// @ts-expect-error Known response fields retain their concrete types.
event.eventTime = 42;
// @ts-expect-error Every decoded query event requires a reusable identity.
const missingID: EPCISQueryEvent = { eventTime: '2026-09-07T00:00:00Z' };
void missingID;

const sparseRow: SparqlBinding = { event: undefined, eventTime: undefined };
// @ts-expect-error Raw store rows require validation before identity use.
const uncheckedID: string = sparseRow.event;
void uncheckedID;
const genericEngine: QueryEngine = { query: async () => ({ bindings: [row] }) };
const sparseEngine: QueryEngine = { query: async () => ({ bindings: [sparseRow] }) };
const unrelatedProjectionEngine: QueryEngine = { query: async () => ({ bindings: [{ count: '1' }] }) };
void [genericEngine, sparseEngine, unrelatedProjectionEngine];
