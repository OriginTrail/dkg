import { afterEach, describe, expect, it, vi } from 'vitest';
import { SemanticEnrichmentWorker } from '../src/SemanticEnrichmentWorker.js';
import type { DkgDaemonClient, SemanticEnrichmentEventLease } from '../src/dkg-client.js';
import type { OpenClawPluginApi } from '../src/types.js';

function makeApi(runtime?: OpenClawPluginApi['runtime']): OpenClawPluginApi {
  return {
    config: {},
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    on: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    runtime,
  };
}

function makeClient(overrides: Partial<DkgDaemonClient> = {}): DkgDaemonClient {
  return {
    baseUrl: 'http://127.0.0.1:9200',
    getAuthToken: vi.fn(),
    getStatus: vi.fn(),
    query: vi.fn(),
    storeChatTurn: vi.fn(),
    claimSemanticEnrichmentEvent: vi.fn().mockResolvedValue({ event: null }),
    renewSemanticEnrichmentEvent: vi.fn().mockResolvedValue({ renewed: true }),
    appendSemanticEnrichmentEvent: vi.fn().mockResolvedValue({
      applied: true,
      completed: true,
      semanticEnrichment: {
        eventId: 'evt-1',
        status: 'completed',
        semanticTripleCount: 1,
        updatedAt: new Date().toISOString(),
      },
    }),
    completeSemanticEnrichmentEvent: vi.fn(),
    failSemanticEnrichmentEvent: vi.fn().mockResolvedValue({ status: 'pending' }),
    fetchFileText: vi.fn(),
    ...overrides,
  } as unknown as DkgDaemonClient;
}

describe('SemanticEnrichmentWorker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('probes api.runtime.subagent and reports missing methods when the surface is incomplete', () => {
    const worker = new SemanticEnrichmentWorker(
      makeApi({
        subagent: {
          run: vi.fn(),
          waitForRun: vi.fn(),
        } as any,
      }),
      makeClient(),
    );

    const probe = worker.getRuntimeProbe();
    expect(probe.supported).toBe(false);
    expect(probe.missing).toEqual(expect.arrayContaining(['getSessionMessages', 'deleteSession']));
    expect(probe.subagent).toBeNull();
  });

  it('dedupes direct and background wakes while executing work only through the daemon lease queue', async () => {
    const claim = vi.fn<() => Promise<{ event: SemanticEnrichmentEventLease | null }>>()
      .mockResolvedValueOnce({
        event: {
          id: 'evt-1',
          kind: 'chat_turn',
          payload: {
            kind: 'chat_turn',
            sessionId: 'openclaw:dkg-ui',
            turnId: 'turn-123',
            contextGraphId: 'agent-context',
            assertionName: 'chat-turns',
            assertionUri: 'did:dkg:context-graph:agent-context/assertion/peer/chat-turns',
            sessionUri: 'urn:dkg:chat:session:openclaw:dkg-ui',
            turnUri: 'urn:dkg:chat:turn:turn-123',
            userMessage: 'hello',
            assistantReply: 'hi',
            persistenceState: 'stored',
            projectContextGraphId: 'project-42',
          },
          status: 'leased',
          attempts: 1,
          maxAttempts: 5,
          leaseOwner: 'worker',
          leaseExpiresAt: Date.now() + 60_000,
          nextAttemptAt: Date.now(),
        },
      })
      .mockResolvedValueOnce({ event: null })
      .mockResolvedValue({ event: null });
    const query = vi.fn().mockResolvedValue({
      result: {
        bindings: [
          {
            s: { value: 'https://schema.org/Person' },
            p: { value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' },
            o: { value: 'http://www.w3.org/2000/01/rdf-schema#Class' },
          },
        ],
      },
    });
    const append = vi.fn().mockResolvedValue({
      applied: true,
      completed: true,
      semanticEnrichment: {
        eventId: 'evt-1',
        status: 'completed',
        semanticTripleCount: 1,
        updatedAt: new Date().toISOString(),
      },
    });
    const client = makeClient({
      claimSemanticEnrichmentEvent: claim,
      query,
      appendSemanticEnrichmentEvent: append,
    });
    const run = vi.fn().mockResolvedValue({ runId: 'run-1' });
    const waitForRun = vi.fn().mockResolvedValue({ status: 'completed' });
    const getSessionMessages = vi.fn().mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          text: '{"triples":[{"subject":"urn:dkg:chat:turn:turn-123","predicate":"https://schema.org/about","object":"https://schema.org/Person"}]}',
        },
      ],
    });
    const deleteSession = vi.fn().mockResolvedValue(undefined);

    const worker = new SemanticEnrichmentWorker(
      makeApi({
        subagent: {
          run,
          waitForRun,
          getSessionMessages,
          deleteSession,
        } as any,
      }),
      client,
    );

    worker.noteWake({
      kind: 'chat_turn',
      eventKey: 'turn-123',
      triggerSource: 'direct',
      uiContextGraphId: 'project-42',
      payload: { userMessage: 'hello' },
    });
    worker.noteWake({
      kind: 'chat_turn',
      eventKey: 'turn-123',
      triggerSource: 'background',
      uiContextGraphId: 'project-42',
      payload: { assistantReply: 'hi' },
    });

    expect(worker.getPendingSummaries()).toHaveLength(1);
    expect(worker.getPendingSummaries()[0].triggerSources.sort()).toEqual(['background', 'direct']);

    await worker.flush();

    expect(claim.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(waitForRun).toHaveBeenCalledTimes(1);
    expect(getSessionMessages).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(
      'evt-1',
      worker.getWorkerInstanceId(),
      [
        {
          subject: 'urn:dkg:chat:turn:turn-123',
          predicate: 'https://schema.org/about',
          object: 'https://schema.org/Person',
        },
      ],
    );
    expect(worker.getPendingSummaries()).toHaveLength(0);
  });
});
