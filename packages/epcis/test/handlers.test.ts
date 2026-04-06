import { describe, it, expect, vi } from 'vitest';
import { handleCapture } from '../src/handlers.js';
import type { Publisher } from '../src/types.js';
import { VALID_OBJECT_EVENT_DOC, INVALID_DOC, EMPTY_EVENT_LIST_DOC } from './fixtures/bicycle-story.js';

const CONTEXT_GRAPH_ID = 'test-paranet';

function mockPublisher(overrides?: Partial<Publisher>): Publisher {
  return {
    publish: vi.fn().mockResolvedValue({ ual: 'did:dkg:test:ual1', kcId: '42', status: 'confirmed' }),
    ...overrides,
  };
}

describe('handleCapture', () => {
  it('validates, publishes, and returns result on success', async () => {
    const publisher = mockPublisher();
    const result = await handleCapture(
      { epcisDocument: VALID_OBJECT_EVENT_DOC },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(result.status).toBe('confirmed');
    expect(result.ual).toBe('did:dkg:test:ual1');
    expect(result.kcId).toBe('42');
    expect(result.eventCount).toBe(1);
    expect(result.receivedAt).toBeDefined();
    expect(publisher.publish).toHaveBeenCalledOnce();
  });

  it('returns validation errors for an invalid document', async () => {
    const publisher = mockPublisher();

    await expect(
      handleCapture({ epcisDocument: INVALID_DOC }, { contextGraphId: CONTEXT_GRAPH_ID, publisher }),
    ).rejects.toThrow(/validation failed/i);

    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('returns validation error for empty eventList', async () => {
    const publisher = mockPublisher();

    await expect(
      handleCapture({ epcisDocument: EMPTY_EVENT_LIST_DOC }, { contextGraphId: CONTEXT_GRAPH_ID, publisher }),
    ).rejects.toThrow(/validation failed/i);

    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('propagates publish errors', async () => {
    const publisher = mockPublisher({
      publish: vi.fn().mockRejectedValue(new Error('chain unavailable')),
    });

    await expect(
      handleCapture({ epcisDocument: VALID_OBJECT_EVENT_DOC }, { contextGraphId: CONTEXT_GRAPH_ID, publisher }),
    ).rejects.toThrow('chain unavailable');
  });

  it('forwards accessPolicy to publisher', async () => {
    const publisher = mockPublisher();
    await handleCapture(
      { epcisDocument: VALID_OBJECT_EVENT_DOC, publishOptions: { accessPolicy: 'ownerOnly' } },
      { contextGraphId: CONTEXT_GRAPH_ID, publisher },
    );

    expect(publisher.publish).toHaveBeenCalledWith(
      CONTEXT_GRAPH_ID,
      VALID_OBJECT_EVENT_DOC,
      expect.objectContaining({ accessPolicy: 'ownerOnly' }),
    );
  });
});
