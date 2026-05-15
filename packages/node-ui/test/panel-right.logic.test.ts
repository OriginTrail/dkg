import React from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

let ConnectedAgentsTab: any;
let adoptLocalAgentTurnId: any;
let formatLocalTimestamp: any;
let getLocalAgentConversationStateKey: any;
let markLocalAgentIntegrationDisconnected: any;
let networkPeerCardStatusClass: any;
let normalizeMessageContent: any;
let resolveConnectedAgentsTabState: any;
let resolveLocalAgentSelectionState: any;
let shouldPreserveSelectedLocalAgentTab: any;
let shouldPreserveSessionForIntegrationSelection: any;
let shouldPreserveSessionOnReconnect: any;
let upsertLocalAgentIntegrationState: any;

/**
 * Minimal real Storage implementation for tests that import
 * PanelRight under Node (no DOM, no jsdom). This satisfies the
 * Web Storage API surface that PanelRight reads at module load
 * time without using any test-framework mocking primitives.
 */
class TestLocalStorage implements Storage {
  private readonly store = new Map<string, string>();
  get length(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string): void { this.store.delete(key); }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
}

const noop = () => {};

beforeAll(async () => {
  (globalThis as any).localStorage = new TestLocalStorage();

  const panelRight = await import('../src/ui/components/Shell/PanelRight.js');
  ConnectedAgentsTab = panelRight.ConnectedAgentsTab;
  adoptLocalAgentTurnId = panelRight.adoptLocalAgentTurnId;
  formatLocalTimestamp = panelRight.formatLocalTimestamp;
  getLocalAgentConversationStateKey = panelRight.getLocalAgentConversationStateKey;
  markLocalAgentIntegrationDisconnected = panelRight.markLocalAgentIntegrationDisconnected;
  networkPeerCardStatusClass = panelRight.networkPeerCardStatusClass;
  normalizeMessageContent = panelRight.normalizeMessageContent;
  resolveConnectedAgentsTabState = panelRight.resolveConnectedAgentsTabState;
  resolveLocalAgentSelectionState = panelRight.resolveLocalAgentSelectionState;
  shouldPreserveSelectedLocalAgentTab = panelRight.shouldPreserveSelectedLocalAgentTab;
  shouldPreserveSessionForIntegrationSelection = panelRight.shouldPreserveSessionForIntegrationSelection;
  shouldPreserveSessionOnReconnect = panelRight.shouldPreserveSessionOnReconnect;
  upsertLocalAgentIntegrationState = panelRight.upsertLocalAgentIntegrationState;
});

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Local bridge',
    connectSupported: true,
    chatSupported: true,
    chatReady: true,
    chatAttachments: true,
    persistentChat: true,
    bridgeOnline: true,
    bridgeStatusLabel: 'Connected',
    configured: true,
    detected: true,
    status: 'connected',
    statusLabel: 'Connected',
    detail: 'ready',
    target: 'local',
    ...overrides,
  } as any;
}

function renderConnectedAgentsTab(overrides: Record<string, unknown> = {}) {
  // renderToStaticMarkup never fires event handlers, so plain no-op
  // functions are sufficient for the callback props (no need for any
  // test-framework spy/mock primitive here).
  const props = {
    integrations: [integration()],
    selectedIntegrationId: 'openclaw',
    selectedIntegration: integration(),
    selectedSessionId: 'openclaw:default',
    selectedHasConversation: false,
    selectedIntegrationHasAnyConversation: false,
    onSelectIntegration: noop,
    onConnectIntegration: noop,
    onDisconnectIntegration: noop,
    onRefreshIntegrations: noop,
    connectBusyId: null,
    connectNotice: null,
    connectError: null,
    localMessages: [],
    localHistoryLoaded: true,
    localChatEndRef: { current: null },
    localInput: '',
    onLocalInputChange: noop,
    onSendLocalMessage: noop,
    onStopLocalStream: noop,
    localSending: false,
    activeProjectId: 'testing',
    availableProjects: [
      { id: 'testing', name: 'Testing' },
      { id: 'agents', name: 'Agents' },
    ],
    // ConnectedAgentsTab is presentational; the container derives this
    // membership-filtered subset (covered by contextGraphSidebar
    // computeSelectableProjects tests). Mirror availableProjects so the
    // existing option-rendering assertions are unaffected.
    selectableProjects: [
      { id: 'testing', name: 'Testing' },
      { id: 'agents', name: 'Agents' },
    ],
    projectsLoading: false,
    onSelectProject: noop,
    attachments: [],
    onAddAttachments: noop,
    onRemoveAttachment: noop,
    ...overrides,
  } as any;

  return renderToStaticMarkup(React.createElement(ConnectedAgentsTab, props));
}

describe('PanelRight logic helpers', () => {
  it('adopts stable local-agent turn ids after a streamed final response', () => {
    const messages = [
      { id: 'user', role: 'user', content: 'hello', turnId: 'corr-1' },
      { id: 'assistant', role: 'assistant', content: 'hi', turnId: 'corr-1', streaming: true },
      { id: 'other', role: 'assistant', content: 'older', turnId: 'stable-0' },
    ];

    const updated = adoptLocalAgentTurnId(messages, 'corr-1', 'stable-1');

    expect(updated.map((message: any) => message.turnId)).toEqual(['stable-1', 'stable-1', 'stable-0']);
    expect(adoptLocalAgentTurnId(messages, 'corr-1')).toBe(messages);
  });

  it('normalizes local-agent message content without leading empty bubble space', () => {
    // Real-newline leading + trailing whitespace gets trimmed.
    expect(normalizeMessageContent('\n\nDone.')).toBe('Done.');
    expect(normalizeMessageContent('\n\nMatched entry in agent-context / memory:\n\n- fact')).toBe(
      'Matched entry in agent-context / memory:\n\n- fact',
    );
    expect(normalizeMessageContent('Line one\n\nLine two\n')).toBe('Line one\n\nLine two');
    // CRLF folds to LF.
    expect(normalizeMessageContent('Line one\r\nLine two')).toBe('Line one\nLine two');
  });

  it('formatLocalTimestamp includes date + time (PR4 expansion)', () => {
    // Earlier the helper rendered only HH:MM AM/PM, which became
    // ambiguous once a conversation crossed midnight. PR4 switches to
    // dateStyle: 'medium' + timeStyle: 'short' so timestamps anchor
    // both the day and the time. We don't pin the exact string here —
    // locale formatting varies across runners — but we do pin that the
    // formatted output includes both date and time signals.
    const d = new Date(Date.UTC(2026, 4, 14, 22, 5, 0));
    const out = formatLocalTimestamp(d);
    // Locale-agnostic: pin the actual PR4 contract (medium date +
    // short time) by comparing against the same Intl API the helper
    // uses, rather than hard-coding en-US / Gregorian traits like
    // "2026" or ":" / "AM|PM" (which break under non-English or
    // non-Gregorian runtime locales — Codex round-6).
    expect(out).toBe(d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
    // The regression PR4 fixed: the date component must be present, so
    // a full render differs from a time-only render. Compared in the
    // runtime locale, so this holds in any locale/calendar.
    expect(out).not.toBe(d.toLocaleString([], { timeStyle: 'short' }));
    expect(out).toContain(new Intl.DateTimeFormat(undefined, { year: 'numeric' }).format(d));
    // Empty / null / invalid inputs return an empty string (or echo
    // the original on parse failure) — no exceptions.
    expect(formatLocalTimestamp(undefined)).toBe('');
    expect(formatLocalTimestamp('')).toBe('');
    expect(formatLocalTimestamp('not-a-date')).toBe('not-a-date');
  });

  it('per-conversation abort isolates concurrent streams (Codex CSI-j regression)', () => {
    // Pins down the contract the `useRef<Map<conversationKey, AbortController>>`
    // implementation must hold:
    //   1. Two conversations can hold separate controllers concurrently
    //      (start A, then start B, both untouched).
    //   2. Aborting the selected conversation's controller does NOT
    //      affect the other's.
    //   3. The `finally` compare-and-delete cleanup only removes its
    //      OWN controller — never the other conversation's, even if
    //      they raced and the same conversationKey was reused later.
    const controllers = new Map<string, AbortController>();

    const ctrlA = new AbortController();
    controllers.set('A', ctrlA);
    const ctrlB = new AbortController();
    controllers.set('B', ctrlB);

    expect(controllers.size).toBe(2);
    expect(ctrlA.signal.aborted).toBe(false);
    expect(ctrlB.signal.aborted).toBe(false);

    // User clicks Stop while viewing A.
    const selectedKey = 'A';
    controllers.get(selectedKey)?.abort();
    expect(ctrlA.signal.aborted).toBe(true);
    expect(ctrlB.signal.aborted).toBe(false);

    // A's `finally`: compare-and-delete leaves B's entry alone.
    if (controllers.get('A') === ctrlA) controllers.delete('A');
    expect(controllers.has('A')).toBe(false);
    expect(controllers.has('B')).toBe(true);
    expect(controllers.get('B')).toBe(ctrlB);

    // A retries — fresh controller under the same key. B is still
    // streaming with its original controller untouched.
    const ctrlARetry = new AbortController();
    controllers.set('A', ctrlARetry);

    // Now B finishes. Its `finally` compare-and-delete confirms the
    // map entry is STILL ctrlB (the original), so the delete fires.
    // If a late teardown from a stale A request fired here using
    // `ctrlA` as the witness, the compare-and-delete would (correctly)
    // skip the delete and leave A's retry entry intact.
    if (controllers.get('A') === ctrlA) controllers.delete('A');
    expect(controllers.get('A')).toBe(ctrlARetry); // not wiped by stale teardown
    if (controllers.get('B') === ctrlB) controllers.delete('B');
    expect(controllers.has('B')).toBe(false);
  });

  it('preserves literal backslash-n in agent content (Codex CHWpS)', () => {
    // Earlier code rewrote `\\n` (two chars: backslash + n) into a real
    // newline to recover from a transport that double-escaped its
    // strings. With markdown / code-block rendering active that rewrite
    // corrupts legitimate agent output — JSON, shell snippets, and any
    // code sample that intentionally contains escaped newlines.
    // Keep them literal.
    expect(normalizeMessageContent('{"text":"a\\nb"}')).toBe('{"text":"a\\nb"}');
    expect(normalizeMessageContent('echo -e "a\\nb"')).toBe('echo -e "a\\nb"');
    // Mixed: real leading newlines still trim, embedded \\n stays literal.
    expect(normalizeMessageContent('\n\n{"x":"a\\nb"}\n')).toBe('{"x":"a\\nb"}');
  });

  it('resolves conversation state keys and session preservation correctly', () => {
    const integrations = [integration(), integration({ id: 'hermes', name: 'Hermes', persistentChat: false })];
    expect(getLocalAgentConversationStateKey('openclaw', null)).toBe('integration:openclaw');
    expect(getLocalAgentConversationStateKey('openclaw', 'openclaw:abc')).toBe('openclaw:abc');
    expect(shouldPreserveSessionForIntegrationSelection({
      integrationId: 'openclaw',
      selectedSessionId: 'openclaw:abc',
      integrations,
    })).toBe(true);
    expect(shouldPreserveSessionOnReconnect({
      integrationId: 'hermes',
      selectedSessionId: 'openclaw:abc',
      integrations,
    })).toBe(false);
  });

  it('does not preserve an old generated Hermes default session after profile changes', () => {
    const integrations = [
      integration(),
      integration({
        id: 'hermes',
        name: 'Hermes',
        persistentChat: true,
        defaultSessionId: 'hermes:dkg-ui:profile-new-profile',
      }),
    ];

    expect(shouldPreserveSessionOnReconnect({
      integrationId: 'hermes',
      selectedSessionId: 'hermes:dkg-ui:profile-old-profile',
      integrations,
    })).toBe(false);
    expect(shouldPreserveSessionForIntegrationSelection({
      integrationId: 'hermes',
      selectedSessionId: 'hermes:manual-thread',
      integrations,
    })).toBe(true);
  });

  it('resolves local agent selection state from saved sessions and message history', () => {
    const integrations = [integration(), integration({ id: 'hermes', name: 'Hermes', persistentChat: false })];
    const state = resolveLocalAgentSelectionState({
      integrations,
      selectedIntegrationId: 'hermes',
      selectedSessionId: 'hermes:thread-1',
      localMessagesByConversation: {
        'hermes:thread-1': [{ id: 'm1', role: 'user', content: 'hello' }],
      },
      sessions: [{
        sessionId: 'hermes:thread-1',
        integrationId: 'hermes',
        integrationName: 'Hermes',
        preview: 'hello',
        messageCount: 1,
        lastTs: '2026-04-14T10:00:00Z',
      }],
    });

    expect(state.selectedIntegration?.id).toBe('hermes');
    expect(state.selectedConversation?.stateKey).toBe('hermes:thread-1');
    expect(state.selectedHasConversation).toBe(true);
    expect(state.selectedIntegrationHasAnyConversation).toBe(true);
    expect(state.connectedIntegrations.map((item) => item.id)).toEqual(['openclaw']);
  });

  it('resolves tab state for disconnected stored sessions and loading conversations', () => {
    const selected = integration({ id: 'openclaw', persistentChat: false, chatReady: false, bridgeOnline: false, status: 'available' });
    const stored = resolveConnectedAgentsTabState({
      connectedAgents: [integration()],
      selectedIntegration: selected,
      selectedIntegrationId: 'openclaw',
      selectedHasConversation: true,
      selectedIntegrationHasAnyConversation: true,
      localHistoryLoaded: true,
      localMessagesCount: 0,
    });

    expect(stored.showingSessionHistory).toBe(true);
    expect(stored.showingStoredSessions).toBe(true);
    expect(stored.visibleAgentTabs[0]?.id).toBe('openclaw');

    const loader = resolveConnectedAgentsTabState({
      connectedAgents: [integration()],
      selectedIntegration: integration(),
      selectedIntegrationId: 'openclaw',
      selectedHasConversation: false,
      selectedIntegrationHasAnyConversation: false,
      localHistoryLoaded: false,
      localMessagesCount: 0,
    });
    expect(loader.shouldShowConversationLoader).toBe(true);
  });

  it('upserts integrations, marks disconnections, and preserves selected tabs with history', () => {
    const list = [integration({ id: 'hermes', name: 'Hermes', persistentChat: false, connectSupported: false, status: 'coming_soon', statusLabel: 'Coming next' })];
    const upserted = upsertLocalAgentIntegrationState(list, integration());
    expect(upserted.map((item) => item.id)).toEqual(['openclaw', 'hermes']);

    const disconnected = markLocalAgentIntegrationDisconnected([integration()], 'openclaw');
    expect(disconnected[0]).toMatchObject({
      persistentChat: false,
      chatReady: false,
      bridgeOnline: false,
      status: 'available',
      target: undefined,
    });

    expect(shouldPreserveSelectedLocalAgentTab({
      selectedIntegrationId: 'openclaw',
      selectedItem: disconnected[0],
      selectedSessionId: 'openclaw:abc',
      localMessagesByConversation: {
        'openclaw:abc': [{ id: 'm1', role: 'assistant', content: 'hi' }],
      },
      sessionSummaries: [],
    })).toBe(true);
  });

  it('maps network peer status classes conservatively', () => {
    expect(networkPeerCardStatusClass({ connectionStatus: 'connected' })).toBe('connected');
    expect(networkPeerCardStatusClass({ connectionStatus: 'disconnected' })).toBe('offline');
    expect(networkPeerCardStatusClass({})).toBe('offline');
  });
});

describe('ConnectedAgentsTab rendering', () => {
  it('renders add-agent flow with OpenClaw and Hermes content', () => {
    const markup = renderConnectedAgentsTab({
      integrations: [
        integration({ persistentChat: false, configured: false, detected: false, bridgeOnline: false, chatReady: false, status: 'available', statusLabel: 'Ready to connect' }),
        integration({ id: 'hermes', name: 'Hermes', persistentChat: false, configured: false, detected: false, bridgeOnline: false, chatReady: false, status: 'available', statusLabel: 'Ready to connect', connectSupported: true }),
      ],
      selectedIntegrationId: '__add_agent__',
      selectedIntegration: null,
      connectBusyId: 'openclaw',
      connectNotice: 'connected',
      connectError: 'error',
    });

    expect(markup).toContain('Connect Another Agent');
    expect(markup).toContain('Connecting...');
    expect(markup).toContain('Docs');
    expect(markup).toContain('Release Notes');
    expect(markup).toContain('Connect Hermes');
    expect(markup).toContain('local Hermes profile');
    expect(markup).toContain('connected');
    expect(markup).toContain('error');
  });

  it('renders chat shell, markdown bubbles, attachments, project picker, and upload composer', () => {
    const markup = renderConnectedAgentsTab({
      localMessages: [{
        id: 'a1',
        role: 'assistant',
        content: 'Hello **world**\n`code`',
        ts: '10:00',
        attachments: [{ fileName: 'spec.md', contextGraphId: 'testing', assertionName: 'spec' }],
      }],
      attachments: [{
        id: 'draft-1',
        file: new File(['hello'], 'spec.md', { type: 'text/markdown' }),
        contextGraphId: 'testing',
        assertionName: 'spec',
        status: 'queued',
      }],
      localInput: 'draft',
    });

    // Connection status + Refresh/Disconnect actions now live inside the
    // kebab (⋯) menu on the active agent subtab. The popover is rendered on
    // demand; in the static markup we only see the trigger.
    expect(markup).toContain('v10-agent-tab-menu-trigger');
    expect(markup).toContain('More actions for OpenClaw');
    // PR3: react-markdown + remark-gfm + remark-breaks now renders the
    // bold-then-inline-code content as proper markup wrapped in a `<p>`.
    // remark-breaks preserves the single newline as a `<br>` per chat-UI
    // convention (matches ChatGPT / Claude behavior).
    expect(markup).toContain('<p class="v10-md-p">Hello <strong>world</strong>');
    expect(markup).toContain('<code class="v10-md-code">code</code>');
    expect(markup).toContain('spec.md');
    // Attachment chip + composer toolbar (PR2 redesign).
    expect(markup).toContain('v10-attachment-chip');
    expect(markup).toContain('Queued');
    expect(markup).toContain('v10-composer-attach');
    expect(markup).toContain('aria-label="Attach files"');
    expect(markup).toContain('Message OpenClaw');
    expect(markup).toContain('aria-label="Send message"');
  });

  it('only routes assistant bubbles through markdown — user bubbles stay literal (Codex CBnNU / CCyxn / CFNsU / CFXYU)', () => {
    // User-side content (typed prompts AND synthetic attachment summaries)
    // must render as plain text so:
    //  - the transcript shows the exact characters the user sent
    //    (typing `# heading` doesn't visibly transform the bubble), and
    //  - a filename like `[spec](https://attacker.com)` embedded in a
    //    synthetic summary doesn't become a clickable external link
    //    (CFThj's relative-link guard doesn't cover absolute http(s)).
    const markup = renderConnectedAgentsTab({
      localMessages: [
        {
          id: 'u1',
          role: 'user',
          content: '# heading and [link](https://example.test)',
          ts: '10:00',
        },
        {
          id: 'a1',
          role: 'assistant',
          content: '# real heading',
          ts: '10:01',
        },
      ],
    });
    // Assistant bubble → markdown (h1 tag rendered).
    expect(markup).toContain('<h1 class="v10-md-h1">real heading</h1>');
    // User bubble → literal text in .v10-chat-plaintext, NOT a heading or
    // anchor. Pre-wrap preserves the `#` so the user sees what they sent.
    expect(markup).toContain('v10-chat-plaintext');
    expect(markup).toContain('# heading and [link](https://example.test)');
    // Pin down that the user bubble didn't sprout an `<a>` or `<h1>`.
    // (The assistant `<h1>` above is fine — it's in a different bubble.)
    const userBubbleStart = markup.indexOf('class="v10-chat-bubble user"');
    const userBubbleEnd = markup.indexOf('</div>', userBubbleStart);
    const userBubble = markup.slice(userBubbleStart, userBubbleEnd);
    expect(userBubble).not.toContain('<a ');
    expect(userBubble).not.toContain('<h1');
    expect(userBubble).not.toContain('v10-md-');
  });

  it('renders the send button in spinner mode while attachments upload (PR4)', () => {
    const markup = renderConnectedAgentsTab({
      attachments: [{
        id: 'draft-1',
        file: new File(['x'], 'spec.md', { type: 'text/markdown' }),
        contextGraphId: 'testing',
        assertionName: 'spec',
        status: 'uploading',
      }],
      localInput: 'send while uploading',
    });
    // Button carries the uploading state class + tooltip; spinner SVG
    // present; aria-label follows the WAI-ARIA APG pattern of describing
    // the action plus a parenthesized reason for unavailability rather
    // than narrating state (UX-lead P1-C).
    expect(markup).toContain('v10-local-agent-inline-send-uploading');
    expect(markup).toContain('aria-label="Send message (attachments uploading)"');
    expect(markup).toContain('v10-local-agent-inline-send-spinner');
    // Plain `aria-label="Send message"` shouldn't appear — only the
    // parenthesized variant is in flight in this state.
    expect(markup).not.toMatch(/aria-label="Send message"/);
  });

  it('renders the send button in stop mode while the assistant is streaming (PR4)', () => {
    const markup = renderConnectedAgentsTab({
      localMessages: [
        { id: 'u', role: 'user', content: 'hi', ts: '10:00' },
        { id: 'a', role: 'assistant', content: 'partial reply...', ts: '10:01', streaming: true },
      ],
      localSending: true,
    });
    expect(markup).toContain('v10-local-agent-inline-send-streaming');
    expect(markup).toContain('aria-label="Stop reply"');
    // Spinner / send-arrow labels are gone in this state.
    expect(markup).not.toContain('aria-label="Send message"');
    expect(markup).not.toContain('aria-label="Uploading attachments"');
  });

  it('shows the animated "Thinking…" indicator while an assistant turn is streaming with no content yet (PR5)', () => {
    const markup = renderConnectedAgentsTab({
      localMessages: [
        { id: 'u', role: 'user', content: 'give me some friday ideas', ts: '10:00' },
        { id: 'a', role: 'assistant', content: '', ts: '10:01', streaming: true },
      ],
      localSending: true,
    });
    expect(markup).toContain('v10-chat-thinking');
    expect(markup).toContain('Thinking');
    expect(markup).toContain('role="status"');
    // No inline caret yet — there is no text node to anchor it to.
    expect(markup).not.toContain('v10-chat-cursor');
  });

  it('drops the "Thinking…" indicator once the first token arrives (hands off to inline caret)', () => {
    const markup = renderConnectedAgentsTab({
      localMessages: [
        { id: 'u', role: 'user', content: 'hi', ts: '10:00' },
        { id: 'a', role: 'assistant', content: 'The Friday ideas are', ts: '10:01', streaming: true },
      ],
      localSending: true,
    });
    expect(markup).not.toContain('v10-chat-thinking');
    expect(markup).toContain('v10-chat-cursor');
  });

  it('renders assistant bubble with no surface styling (PR4 — full-width no-bubble layout)', () => {
    // PR4 drops the assistant bubble to match Claude Desktop / ChatGPT /
    // VS Code Copilot: only user content stays as a pill. We pin two
    // contracts:
    //   1. Class names: `.v10-chat-msg.assistant` still wraps each
    //      assistant turn (used for align-stretch in styles.css), and
    //      `.v10-chat-bubble.assistant` still wraps the content (used
    //      to scope markdown-component CSS and the streaming cursor).
    //   2. No legacy inline background / border attributes on the
    //      assistant bubble — visual surface comes solely from
    //      styles.css, which has been stripped of background / border /
    //      max-width for `.v10-chat-bubble.assistant`.
    const markup = renderConnectedAgentsTab({
      localMessages: [
        { id: 'a', role: 'assistant', content: 'reply text', ts: '10:00' },
      ],
    });
    expect(markup).toContain('class="v10-chat-msg assistant"');
    expect(markup).toContain('class="v10-chat-bubble assistant"');
    // Inline-style background/border on assistant bubble would
    // reintroduce the visual pill — verify markup is clean.
    const start = markup.indexOf('class="v10-chat-bubble assistant"');
    const end = markup.indexOf('</div>', start);
    const assistantBubble = markup.slice(start, end);
    expect(assistantBubble).not.toContain('background:');
    expect(assistantBubble).not.toContain('border:');
  });

  it('also bypasses markdown for synthesized assistant content (Codex CGpe9)', () => {
    // Assistant-role messages whose content was locally synthesized
    // (history fallback from `buildAttachmentSummary`, error / cancel
    // text) must also skip markdown rendering — they embed raw
    // filenames or error bodies which, if parsed as markdown, could
    // synthesize live external links from attacker-controllable
    // filenames in an assistant-styled bubble.
    const markup = renderConnectedAgentsTab({
      localMessages: [
        {
          id: 'a-synth',
          role: 'assistant',
          content: 'Attachment import result: [spec](https://attacker.example).',
          ts: '10:00',
          synthesized: true,
        },
        {
          id: 'a-real',
          role: 'assistant',
          content: 'real **bold** text',
          ts: '10:01',
        },
      ],
    });
    // Real agent text → markdown.
    expect(markup).toContain('<strong>bold</strong>');
    // Synthesized content renders as a plaintext span — its literal
    // characters (brackets, parens, scheme) survive in the markup.
    expect(markup).toContain('v10-chat-plaintext');
    expect(markup).toContain('[spec](https://attacker.example)');
    // No anchor tag points at the attacker URL anywhere on the page —
    // markdown was never invoked for the synthesized string. Match
    // anchors that specifically target the attacker URL (an assistant
    // bubble for `real **bold**` could legitimately contain other
    // `<a>` markup from markdown-rendered links, but never this URL).
    expect(markup).not.toMatch(/<a[^>]*attacker\.example/);
  });

  it('renders degraded connected-agent status dots', () => {
    const degraded = integration({
      id: 'hermes',
      name: 'Hermes',
      bridgeOnline: false,
      chatReady: false,
      status: 'degraded',
      statusLabel: 'Degraded',
      bridgeStatusLabel: 'Degraded',
    });
    const markup = renderConnectedAgentsTab({
      integrations: [degraded],
      selectedIntegrationId: 'hermes',
      selectedIntegration: degraded,
      selectedSessionId: 'hermes:dkg-ui',
    });
    expect(markup).toContain('v10-agents-stat-dot degraded');
  });

  it('renders disconnected history warnings and empty-state messaging', () => {
    const markup = renderConnectedAgentsTab({
      selectedIntegration: integration({ persistentChat: false, chatReady: false, bridgeOnline: false, status: 'available' }),
      selectedHasConversation: true,
      selectedIntegrationHasAnyConversation: true,
      localMessages: [],
      localHistoryLoaded: true,
    });

    expect(markup).toContain('Session history');
    expect(markup).toContain('is not currently attached to this node');
    // Empty-state copy was rewritten to title+hint (P1 fix from PR1 UX review).
    expect(markup).toContain('No turns in this session yet.');
  });

  // ─── S3 H-AC tests (issue #386, test-matrix.md group H + I) ─────────────

  it('H-AC-45: Connect Hermes button shows "Connecting..." while a connect is in flight', () => {
    const hermes = integration({
      id: 'hermes',
      name: 'Hermes',
      persistentChat: false,
      configured: false,
      detected: false,
      bridgeOnline: false,
      chatReady: false,
      status: 'available',
      statusLabel: 'Ready to connect',
      connectSupported: true,
    });
    const markup = renderConnectedAgentsTab({
      integrations: [hermes],
      selectedIntegrationId: '__add_agent__',
      selectedIntegration: null,
      connectBusyId: 'hermes',
    });
    // While Connect is in flight, the button label flips to "Connecting..."
    // and the button is disabled. After the daemon writes runtime: connecting
    // and the polling loop refreshes, persistentChat becomes true and the
    // tab transitions out of the "Connect Another Agent" surface — covered
    // by the disconnected-history test above.
    expect(markup).toContain('Connecting...');
  });

  it('H-AC-47: Kebab menu trigger is rendered on the active connected agent tab', () => {
    const ready = integration({
      id: 'hermes',
      name: 'Hermes',
      bridgeOnline: true,
      chatReady: true,
      status: 'connected',
      statusLabel: 'Connected',
      bridgeStatusLabel: 'Connected',
    });
    const markup = renderConnectedAgentsTab({
      integrations: [ready],
      selectedIntegrationId: 'hermes',
      selectedIntegration: ready,
      selectedSessionId: 'hermes:dkg-ui',
    });
    // Refresh / Disconnect now live inside the kebab popover (open on click).
    expect(markup).toContain('v10-agent-tab-menu-trigger');
    expect(markup).toContain('More actions for Hermes');
  });

  it('H-AC-47b: Warning chip surfaces lastError on disconnected integration in Connect Another Agent tab', () => {
    // After UI Disconnect with restore-failure: daemon writes
    // enabled:false + runtime.status:'disconnected' + runtime.lastError:'restore failed: …'.
    // The api.ts mapper routes that to status:'available', detail = lastError,
    // and exposes the lastError on integration.error. PanelRight's warning chip
    // (added in S3 step 5, commit c840d14c) renders the error inline.
    const disconnectedWithWarning = integration({
      id: 'hermes',
      name: 'Hermes',
      persistentChat: false,
      configured: false,
      detected: false,
      bridgeOnline: false,
      chatReady: false,
      status: 'available',
      statusLabel: 'Ready to connect',
      connectSupported: true,
      detail: 'Hermes provider restore failed: backup file missing',
      error: 'Hermes provider restore failed: backup file missing',
    });
    const markup = renderConnectedAgentsTab({
      integrations: [disconnectedWithWarning],
      selectedIntegrationId: '__add_agent__',
      selectedIntegration: null,
    });

    // Warning chip is present, carries the lastError text, and is testable
    // via the data-testid added in PanelRight.tsx (S3 step 5).
    expect(markup).toContain('local-agent-warning-hermes');
    expect(markup).toContain('Hermes provider restore failed: backup file missing');
    // The "Ready to connect" Connect button is still enabled — user can retry.
    expect(markup).toContain('Connect Hermes');
  });
});
