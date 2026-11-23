import React from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import { MarkdownMessage } from '../../chat/MarkdownMessage.js';


export function normalizeMessageContent(content: string): string {
  // Normalize CRLF → LF and trim leading/trailing blank lines so chat
  // bubbles don't render with extra vertical whitespace.
  //
  // Earlier versions also rewrote literal backslash-n (`\\n` in source,
  // i.e. the two characters `\` + `n`) into real newlines, to recover
  // from a transport that double-escaped its strings. With PR3's
  // markdown / code-block rendering, that rewrite actively corrupts
  // legitimate agent output — a JSON snippet like `{"text":"a\\nb"}`
  // or a shell sample like `echo -e "a\\nb"` would get split across
  // two lines, breaking the displayed code (Codex CHWpS). Removed; if
  // a specific transport ever needs unescaping, do it at the transport
  // boundary, not in the renderer.
  return content
    .replace(/\r\n/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/(?:\n[ \t]*)+$/, '');
}

export function renderMessageContent(
  content: string,
  role: 'user' | 'assistant',
  synthesized: boolean,
  streaming: boolean,
  failureNotice?: string,
): React.ReactNode {
  const normalized = normalizeMessageContent(content);
  const normalizedFailure = failureNotice ? normalizeMessageContent(failureNotice) : '';
  // Pre-first-token wait: an assistant turn starts as `{ streaming:
  // true, content: '' }`. The inline streaming caret lives inside the
  // last text node, so with no content yet there is nothing to anchor
  // it to and the row would render blank. Show an explicit animated
  // "Connecting dots..." indicator until the first token arrives, at which
  // point this falls through to the markdown path (whose inline caret
  // then takes over). `role=status`/`aria-live` announces it to AT.
  if (role === 'assistant' && streaming && normalized.trim() === '' && !normalizedFailure) {
    return (
      <span className="v10-chat-thinking" role="status" aria-live="polite">
        <ThinkingOrb
          aria-hidden="true"
          className="v10-chat-thinking-orb"
          state="connecting"
          size={64}
          theme="auto"
        />
        <span>Connecting dots...</span>
      </span>
    );
  }
  // Markdown rendering applies only to agent-authored assistant output
  // — the only content that's actually written as markdown. Everything
  // else falls back to plain text:
  //   - User-typed bubbles: typing `# heading` would otherwise visibly
  //     transform, so the transcript no longer matches the prompt
  //     (CBnNU / CCyxn).
  //   - Synthetic strings (attachment summaries, history fallbacks,
  //     local error / cancel text) embed raw filenames or error bodies.
  //     A filename like `[spec](https://attacker.example)` would
  //     otherwise render as a live external link in an assistant-styled
  //     bubble (CFNsU / CFXYU / CGpe9). The CFThj relative-link guard
  //     doesn't help — those hrefs are absolute and allowed.
  if (role === 'assistant' && !synthesized && normalized.trim() !== '') {
    return (
      <>
        <MarkdownMessage content={normalized} streaming={streaming && !normalizedFailure} />
        {normalizedFailure && (
          <span className="v10-chat-plaintext v10-chat-failure-notice">
            {normalizedFailure}
            {streaming && <span className="v10-chat-cursor" />}
          </span>
        )}
      </>
    );
  }
  // Plaintext path (user / synthetic): keep the caret inline with the
  // text rather than as a block sibling that drops to a new line.
  const plainText = [normalized, normalizedFailure].filter(Boolean).join('\n\n');
  return (
    <span className="v10-chat-plaintext">
      {plainText}
      {streaming && <span className="v10-chat-cursor" />}
    </span>
  );
}
