import { toEpcisEvent, type EPCISQueryEvent } from '../dist/index.js';

// Existing QueryEngine consumers pass generic rows to this public helper.
const row: Record<string, string> = { event: 'urn:event:1' };
const event: EPCISQueryEvent = toEpcisEvent(row);
const reusableId: string = event.eventID;
void reusableId;

// Reconstructed standard fields retain the capture model's useful types.
const timestamp: string | undefined = event.eventTime?.toUpperCase();
const readPoint: string | undefined = event.readPoint?.id;
const firstChild: string | undefined = event.childEPCs?.[0];
const provenance: string | undefined = event['dkg:ual'];
const extension: unknown = event['example:extension'];
void [timestamp, readPoint, firstChild, provenance, extension];

// @ts-expect-error Standard fields cannot drift to untyped extension values.
event.readPoint = 'urn:location:1';
// @ts-expect-error Every query result requires its reusable identifier.
const missingId: EPCISQueryEvent = { eventTime: '2026-09-07T00:00:00Z' };
void missingId;
