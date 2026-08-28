/**
 * Pins the session-pin plumbing this side of the wire: an integration's
 * defaultSessionId (provided by daemon metadata.activeMemorySessionId) must
 * reach an outgoing chat request whenever the panel holds no sticky selection,
 * and a sticky selection must win over the pin. The api-level pass-through of
 * an explicit sessionId is covered separately in ui-api-stream.test.ts — this
 * suite covers the hop that test does not: defaultSessionId → conversation →
 * request body.
 */

import { describe, expect, it, vi } from 'vitest';

import { LocalAgentApiError, streamLocalAgentChat, type LocalAgentIntegration } from '../src/ui/api.js';
import {
  resolveLocalAgentConversation,
  resolveLocalAgentSelectionState,
} from '../src/ui/components/Shell/PanelRight/selection.js';

const pinnedIntegration = {
  id: 'prime-agent',
  name: 'Prime Agent',
  persistentChat: true,
  defaultSessionId: 'prime-agent:dkg-ui:019f-session-a',
} as unknown as LocalAgentIntegration;

describe('prime-agent session pin plumbing', () => {
  it('resolves the conversation to the pin when no sticky session is selected', () => {
    const conversation = resolveLocalAgentConversation({
      integrationId: 'prime-agent',
      sessionId: null,
      defaultSessionId: pinnedIntegration.defaultSessionId,
    });
    expect(conversation.sessionId).toBe('prime-agent:dkg-ui:019f-session-a');
    expect(conversation.stateKey).toBe('prime-agent:dkg-ui:019f-session-a');
  });

  it('lets a sticky selection win over the pin, and a cleared selection fall back to it', () => {
    expect(
      resolveLocalAgentConversation({
        integrationId: 'prime-agent',
        sessionId: 'prime-agent:dkg-ui:019f-session-b',
        defaultSessionId: 'prime-agent:dkg-ui:019f-session-a',
      }).sessionId,
    ).toBe('prime-agent:dkg-ui:019f-session-b');
    // The self-heal re-homes a dead-pinned conversation by resolving against
    // the refreshed pin as an explicit session — same resolution shape.
    expect(
      resolveLocalAgentConversation({
        integrationId: 'prime-agent',
        sessionId: null,
        defaultSessionId: 'prime-agent:dkg-ui:019f-session-c',
      }).sessionId,
    ).toBe('prime-agent:dkg-ui:019f-session-c');
  });

  it('selection state carries the pin into the selected conversation', () => {
    const state = resolveLocalAgentSelectionState({
      integrations: [pinnedIntegration],
      selectedIntegrationId: 'prime-agent',
      selectedSessionId: null,
      localMessagesByConversation: {},
      sessions: [],
    });
    expect(state.selectedConversation?.sessionId).toBe('prime-agent:dkg-ui:019f-session-a');
  });

  it('sends the pin-resolved conversation sessionId in the outgoing request body', async () => {
    const savedFetch = globalThis.fetch;
    let payload: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body ?? '{}'));
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"type":"final","text":"ok","correlationId":"c-pin","sessionId":"019f-session-a"}\n\n',
          ));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof globalThis.fetch;

    try {
      // The exact hop PanelRightContainer performs: resolve the conversation
      // from the mapped integration, then send with the resolved sessionId.
      const conversation = resolveLocalAgentConversation({
        integrationId: 'prime-agent',
        sessionId: null,
        defaultSessionId: pinnedIntegration.defaultSessionId,
      });
      await streamLocalAgentChat('prime-agent', 'hello', {
        sessionId: conversation.sessionId ?? undefined,
        liveSession: {
          sessionId: 'prime-agent:dkg-ui:019f-session-a',
          rawSessionId: '019f-session-a',
        },
      });
      expect(payload).toMatchObject({ text: 'hello', sessionId: '019f-session-a' });
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('maps the daemon 409 body into the code the self-heal path keys on', async () => {
    // End-to-end through the real error path: if the daemon renamed the field
    // or buildLocalAgentApiError stopped copying `code`, the dead-session pin
    // would never be marked and every retry would 409 — this must fail then.
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: 'No live Prime Agent session 019f-dead',
          code: 'PRIME_AGENT_NO_SESSION',
          source: 'prime-agent-channel',
          correlationId: 'c-409',
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      )) as typeof globalThis.fetch;

    try {
      let caught: unknown;
      await streamLocalAgentChat('prime-agent', 'hello', {
        sessionId: 'prime-agent:dkg-ui:019f-dead',
        liveSession: {
          sessionId: 'prime-agent:dkg-ui:019f-dead',
          rawSessionId: '019f-dead',
        },
      })
        .catch((err) => { caught = err; });
      expect(caught).toBeInstanceOf(LocalAgentApiError);
      expect(caught).toMatchObject({ code: 'PRIME_AGENT_NO_SESSION', status: 409 });
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  it('rejects a mismatched raw-and-memory Prime session pair before transport', async () => {
    const savedFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      await expect(streamLocalAgentChat('prime-agent', 'hello', {
        sessionId: 'prime-agent:dkg-ui:session-a',
        liveSession: {
          sessionId: 'prime-agent:dkg-ui:session-b',
          rawSessionId: 'session-b',
        },
      })).rejects.toThrow('Prime Agent live session does not match the selected conversation');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});
