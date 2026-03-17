import { describe, it, expect, vi } from 'vitest';
import { handleEventsQuery, EpcisQueryError } from '../src/handlers.js';
import type { QueryEngine } from '../src/types.js';

const PARANET_ID = 'test-paranet';

function mockQueryEngine(bindings: Record<string, string>[] = []): QueryEngine {
  return {
    query: vi.fn().mockResolvedValue({ bindings }),
  };
}

function makeBindings(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    event: 'urn:uuid:event-1',
    eventType: 'https://gs1.github.io/EPCIS/ObjectEvent',
    eventTime: '2024-03-01T08:00:00.000Z',
    bizStep: 'https://ref.gs1.org/cbv/BizStep-receiving',
    bizLocation: 'urn:epc:id:sgln:4012345.00001.0',
    disposition: 'https://ref.gs1.org/cbv/Disp-in_progress',
    readPoint: 'urn:epc:id:sgln:4012345.00001.0',
    action: 'ADD',
    parentID: '',
    epcList: 'urn:epc:id:sgtin:4012345.011111.1001',
    childEPCList: '',
    inputEPCs: '',
    outputEPCs: '',
    ual: 'did:dkg:mock:31337/42',
    ...overrides,
  };
}

describe('handleEventsQuery', () => {
  it('returns events with pagination on success', async () => {
    const engine = mockQueryEngine([makeBindings()]);
    const sp = new URLSearchParams('epc=urn:epc:id:sgtin:4012345.011111.1001');

    const result = await handleEventsQuery(sp, { paranetId: PARANET_ID, queryEngine: engine });

    expect(result.count).toBe(1);
    expect(result.pagination).toEqual({ limit: 100, offset: 0 });
    expect(result.events).toHaveLength(1);
    expect(result.events[0].eventType).toBe('https://gs1.github.io/EPCIS/ObjectEvent');
    expect(result.events[0].ual).toBe('did:dkg:mock:31337/42');

    // Verify the query engine was called with paranetId
    expect(engine.query).toHaveBeenCalledOnce();
    const [sparql, opts] = (engine.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sparql).toContain('GRAPH <did:dkg:paranet:test-paranet>');
    expect(opts).toEqual({ paranetId: PARANET_ID });
  });

  it('returns multiple events', async () => {
    const engine = mockQueryEngine([
      makeBindings({ event: 'urn:uuid:event-1', eventTime: '2024-03-01T08:00:00Z' }),
      makeBindings({ event: 'urn:uuid:event-2', eventTime: '2024-03-02T08:00:00Z' }),
      makeBindings({ event: 'urn:uuid:event-3', eventTime: '2024-03-03T08:00:00Z' }),
    ]);

    const result = await handleEventsQuery(
      new URLSearchParams('bizStep=receiving'),
      { paranetId: PARANET_ID, queryEngine: engine },
    );

    expect(result.count).toBe(3);
    expect(result.events).toHaveLength(3);
  });

  it('respects custom pagination params', async () => {
    const engine = mockQueryEngine([]);

    const result = await handleEventsQuery(
      new URLSearchParams('epc=urn:test&limit=25&offset=50'),
      { paranetId: PARANET_ID, queryEngine: engine },
    );

    expect(result.pagination).toEqual({ limit: 25, offset: 50 });
  });

  it('throws EpcisQueryError with 400 when no filters provided', async () => {
    const engine = mockQueryEngine();

    await expect(
      handleEventsQuery(new URLSearchParams(''), { paranetId: PARANET_ID, queryEngine: engine }),
    ).rejects.toThrow(EpcisQueryError);

    try {
      await handleEventsQuery(new URLSearchParams('limit=50'), { paranetId: PARANET_ID, queryEngine: engine });
    } catch (err) {
      expect(err).toBeInstanceOf(EpcisQueryError);
      expect((err as EpcisQueryError).statusCode).toBe(400);
      expect((err as EpcisQueryError).message).toMatch(/at least one filter/i);
    }
  });

  it('throws EpcisQueryError with 400 when date range is invalid', async () => {
    const engine = mockQueryEngine();

    try {
      await handleEventsQuery(
        new URLSearchParams('epc=urn:test&from=2024-12-31T00:00:00Z&to=2024-01-01T00:00:00Z'),
        { paranetId: PARANET_ID, queryEngine: engine },
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EpcisQueryError);
      expect((err as EpcisQueryError).statusCode).toBe(400);
      expect((err as EpcisQueryError).message).toMatch(/date range/i);
    }
  });

  it('does not call query engine when validation fails', async () => {
    const engine = mockQueryEngine();

    await expect(
      handleEventsQuery(new URLSearchParams(''), { paranetId: PARANET_ID, queryEngine: engine }),
    ).rejects.toThrow();

    expect(engine.query).not.toHaveBeenCalled();
  });
});
