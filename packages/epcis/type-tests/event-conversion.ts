import { toEpcisEvent, type EPCISQueryEvent } from '../dist/index.js';

// Existing QueryEngine consumers pass generic rows to this public helper.
const row: Record<string, string> = { event: 'urn:event:1' };
const event: EPCISQueryEvent = toEpcisEvent(row);
const reusableId: string = event.eventID;
void reusableId;
