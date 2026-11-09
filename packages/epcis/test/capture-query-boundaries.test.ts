import { describe, expect, it, vi } from 'vitest';
import { epcisDocumentForValidation, normalizeCaptureEventTypes } from '../src/capture-event-types.js';
import { EpcisValidationError, handleCaptureAsync, handleEventsQuery, toEpcisEvent } from '../src/handlers.js';
import { createValidator } from '../src/validation.js';
import { decodePageToken, encodePageToken, parseQueryParams } from '../src/utils.js';
import type { EPCISDocument } from '../src/types.js';
import { VALID_OBJECT_EVENT_DOC } from './fixtures/bicycle-story.js';

const validator = createValidator();

describe('capture input boundaries', () => {
  it.each([null, 7, 'ObjectEvent', [], {}, { type: 7 }, { type: 'not a valid type' }])(
    'does not manufacture event declarations for malformed input %j', event => {
      const document = { ...VALID_OBJECT_EVENT_DOC, epcisBody: { eventList: [event] } };
      const before = structuredClone(document);
      expect(normalizeCaptureEventTypes(document)).toEqual(before);
      expect(epcisDocumentForValidation(document)).toEqual(before);
      expect(validator.validate(document).valid).toBe(false);
      expect(document).toEqual(before);
    },
  );

  it.each([null, false, 42, 'not a document', [], { public: undefined }, { private: undefined }])(
    'rejects invalid capture payload %j before publication', async epcisDocument => {
      const publishAsync = vi.fn();
      await expect(handleCaptureAsync({ epcisDocument }, { contextGraphId: 'boundary', publisher: { publishAsync } }))
        .rejects.toBeInstanceOf(EpcisValidationError);
      expect(publishAsync).not.toHaveBeenCalled();
    },
  );

  it('extracts legacy top-level events before nested events, retaining identity and explicit emptiness', () => {
    const event = VALID_OBJECT_EVENT_DOC.epcisBody!.eventList[0];
    const nested = [{ ...event, eventID: 'urn:event:nested' }];
    const legacy = [{ ...event, eventID: 'urn:event:legacy' }];
    const document: EPCISDocument = { ...VALID_OBJECT_EVENT_DOC, eventList: legacy, epcisBody: { eventList: nested } };
    expect(validator.extractEvents(document)).toBe(legacy);
    expect(validator.extractEvents({ ...document, eventList: [] })).toEqual([]);
    expect(validator.extractEvents({ ...document, eventList: undefined })).toBe(nested);
    expect(validator.extractEvents({ ...document, eventList: undefined, epcisBody: undefined })).toEqual([]);
  });
});

describe('query response and continuation boundaries', () => {
  it('omits an absent event type instead of inventing one or dropping available fields', () => {
    expect(toEpcisEvent({ eventTime: '"2024-03-01T00:00:00Z"', action: '"OBSERVE"' }))
      .toEqual({ eventTime: '2024-03-01T00:00:00Z', action: 'OBSERVE' });
    expect(toEpcisEvent({ eventType: '""' })).toEqual({});
  });

  it('replaces old pagination controls while retaining the event filter and route', async () => {
    const params = new URLSearchParams({ eventID: 'urn:event:target', perPage: '1', offset: '999', nextPageToken: encodePageToken(3) });
    const original = params.toString();
    const query = vi.fn(async (_sparql: string) => ({ bindings: [{ action: 'ADD' }, { action: 'OBSERVE' }] }));
    const result = await handleEventsQuery(params, { contextGraphId: 'boundary', basePath: '/custom/epcis/events', queryEngine: { query } });
    expect(query.mock.calls[0][0]).toContain('FILTER(?event = <urn:event:target>)');
    expect(query.mock.calls[0][0]).toContain('OFFSET 3');
    expect(result.body.epcisBody.queryResults.resultsBody.eventList).toEqual([{ action: 'ADD' }]);
    expect(result.headers?.link).toMatch(/^<\/custom\/epcis\/events\?.*>; rel="next"$/);
    const url = new URL(result.headers!.link!.split('>')[0].slice(1), 'http://localhost');
    expect([...url.searchParams.keys()].sort()).toEqual(['eventID', 'nextPageToken', 'perPage']);
    expect(url.searchParams.get('eventID')).toBe('urn:event:target');
    expect(decodePageToken(url.searchParams.get('nextPageToken')!)).toBe(4);
    expect(params.toString()).toBe(original);
  });

  it.each(['offset:-1', 'offset:1junk', 'page:3', ''])('ignores a decoded malformed cursor %j and uses the explicit offset', raw => {
    const token = Buffer.from(raw).toString('base64');
    expect(decodePageToken(token)).toBeNull();
    expect(parseQueryParams(new URLSearchParams({ nextPageToken: token, offset: '8' }))).toMatchObject({ offset: 8 });
  });
});
