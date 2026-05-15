// @vitest-environment happy-dom
//
// Covers PR3 MarkdownMessage rendering: GFM (lists, tables, task lists),
// headings, links (target/rel hardening), inline code, blockquotes, the
// react-markdown sanitization default (no raw HTML), remark-breaks soft-break
// → <br>, fenced code blocks → <CodeBlock> with plain-text fallback for
// unsupported languages, and the lazy-shiki gate (no fenced block → no
// dynamic import of `shiki`).

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

// IMPORTANT: this mock asserts the "shiki must not load when there are no
// fenced blocks" contract. Any markdown without a fenced code block that
// triggers `import('shiki')` will throw and fail the test. The mock returns
// a benign `createHighlighter` stub for the cases that DO load shiki on
// purpose (covered in code-block.test.ts).
let shikiImportCount = 0;
vi.mock('shiki', () => {
  shikiImportCount += 1;
  return {
    createHighlighter: async () => ({
      codeToHtml: (code: string) =>
        `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`,
    }),
  };
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function render(content: string): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
  const { MarkdownMessage } = await import('../src/ui/components/chat/MarkdownMessage.js');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(MarkdownMessage, { content }));
  });
  // Let react-markdown's child effects settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('MarkdownMessage rendering', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    // Clear Vitest's module cache so every test re-imports MarkdownMessage
    // (and therefore CodeBlock) from a fresh state. Without this, the
    // `vi.mock('shiki', ...)` factory above only runs once per test file:
    // after the first fenced-block test imports shiki, the module is
    // cached and any subsequent `import('shiki')` resolves without
    // re-invoking the factory, so the `lazy-shiki gate` assertion can
    // false-pass even if a real load happens. Codex CHMS6.
    vi.resetModules();
    shikiImportCount = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('wraps the rendered tree in .v10-md', async () => {
    const { container, unmount } = await render('hello');
    expect(container.querySelector('.v10-md')).toBeTruthy();
    await unmount();
  });

  it('renders headings h1-h6 with .v10-md-h1..h6 classes', async () => {
    const md = ['# H1', '## H2', '### H3', '#### H4', '##### H5', '###### H6'].join('\n\n');
    const { container, unmount } = await render(md);
    for (let i = 1; i <= 6; i++) {
      const el = container.querySelector(`.v10-md-h${i}`);
      expect(el?.tagName.toLowerCase()).toBe(`h${i}`);
      expect(el?.textContent).toBe(`H${i}`);
    }
    await unmount();
  });

  it('renders unordered lists with .v10-md-ul + .v10-md-li', async () => {
    const { container, unmount } = await render('- one\n- two\n- three\n');
    const ul = container.querySelector('ul.v10-md-ul');
    expect(ul).toBeTruthy();
    const items = container.querySelectorAll('li.v10-md-li');
    expect(items.length).toBe(3);
    expect(items[0]?.textContent).toContain('one');
    await unmount();
  });

  it('renders ordered lists with .v10-md-ol', async () => {
    const { container, unmount } = await render('1. first\n2. second\n3. third\n');
    expect(container.querySelector('ol.v10-md-ol')).toBeTruthy();
    expect(container.querySelectorAll('li.v10-md-li').length).toBe(3);
    await unmount();
  });

  it('renders GFM task lists with native checkboxes', async () => {
    const { container, unmount } = await render('- [ ] todo\n- [x] done\n');
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(2);
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);
    await unmount();
  });

  it('renders GFM tables wrapped in .v10-md-table-scroll', async () => {
    const md = [
      '| Name | Value |',
      '| ---- | ----- |',
      '| foo  | 1     |',
      '| bar  | 2     |',
    ].join('\n');
    const { container, unmount } = await render(md);
    const scroll = container.querySelector('.v10-md-table-scroll');
    expect(scroll).toBeTruthy();
    const table = scroll!.querySelector('table.v10-md-table');
    expect(table).toBeTruthy();
    expect(container.querySelectorAll('th.v10-md-th').length).toBe(2);
    expect(container.querySelectorAll('td.v10-md-td').length).toBe(4);
    // Codex CG3L5: react-markdown passes a synthetic `node` (HAST node)
    // prop into custom renderers. Spreading `...props` onto a DOM
    // element used to forward `node` to the underlying tag, which React
    // flags as an unknown DOM attribute. Pin down that none of the
    // table-family tags carry a `node` attribute.
    for (const sel of ['thead.v10-md-thead', 'tbody.v10-md-tbody', 'tr.v10-md-tr', 'th.v10-md-th', 'td.v10-md-td']) {
      for (const el of container.querySelectorAll(sel)) {
        expect(el.hasAttribute('node'), `${sel} should not carry a 'node' DOM attribute`).toBe(false);
      }
    }
    await unmount();
  });

  it('renders blockquotes with .v10-md-blockquote', async () => {
    const { container, unmount } = await render('> quoted text\n');
    const bq = container.querySelector('blockquote.v10-md-blockquote');
    expect(bq).toBeTruthy();
    expect(bq?.textContent?.trim()).toBe('quoted text');
    await unmount();
  });

  it('renders horizontal rule with .v10-md-hr', async () => {
    const { container, unmount } = await render('before\n\n---\n\nafter\n');
    expect(container.querySelector('hr.v10-md-hr')).toBeTruthy();
    await unmount();
  });

  it('renders links with target="_blank" and rel="noopener noreferrer" (G2 hardening)', async () => {
    const { container, unmount } = await render('See [the docs](https://example.test/path) for more.');
    const link = container.querySelector('a.v10-md-link') as HTMLAnchorElement | null;
    expect(link).toBeTruthy();
    expect(link!.getAttribute('href')).toBe('https://example.test/path');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toBe('noopener noreferrer');
    await unmount();
  });

  it('renders mailto links as anchors (no target=_blank — system mail client opens out-of-band)', async () => {
    const { container, unmount } = await render('email [team](mailto:team@example.test)');
    const link = container.querySelector('a.v10-md-link') as HTMLAnchorElement | null;
    expect(link).toBeTruthy();
    expect(link!.getAttribute('href')).toBe('mailto:team@example.test');
    expect(link!.getAttribute('target')).toBeNull();
    await unmount();
  });

  it('renders relative links from untrusted chat content as inert text (Codex CFThj)', async () => {
    // Chat content is untrusted. An agent emitting `[click here](/admin)`
    // must not produce a clickable same-origin link — that would be a
    // silent navigation hijack. The literal href is exposed via `title`
    // so the user can still see what was claimed.
    const { container, unmount } = await render('check [the admin page](/admin)');
    expect(container.querySelector('a.v10-md-link')).toBeNull();
    const inert = container.querySelector('.v10-md-link-inert') as HTMLSpanElement | null;
    expect(inert).toBeTruthy();
    expect(inert!.tagName.toLowerCase()).toBe('span');
    expect(inert!.getAttribute('title')).toBe('/admin');
    expect(inert!.textContent).toContain('the admin page');
    await unmount();
  });

  it('renders javascript: / data: / fragment hrefs as inert (broader CFThj coverage)', async () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>1</script>', '#section', '../foo']) {
      const { container, unmount } = await render(`see [link](${href})`);
      expect(container.querySelector('a.v10-md-link')).toBeNull();
      expect(container.querySelector('.v10-md-link-inert')).toBeTruthy();
      await unmount();
    }
  });

  it('renders inline code with .v10-md-code (not CodeBlock)', async () => {
    const { container, unmount } = await render('use `npm test` to run tests');
    const inline = container.querySelector('code.v10-md-code');
    expect(inline).toBeTruthy();
    expect(inline?.textContent).toBe('npm test');
    // No CodeBlock wrapper.
    expect(container.querySelector('.v10-md-pre')).toBeNull();
    await unmount();
  });

  it('renders strong/em (bold/italic)', async () => {
    const { container, unmount } = await render('**bold** and *italic*');
    expect(container.querySelector('strong')).toBeTruthy();
    expect(container.querySelector('em')).toBeTruthy();
    await unmount();
  });

  it('renders fenced code blocks via CodeBlock wrapper (.v10-md-pre)', async () => {
    const md = '```ts\nconst x = 1;\n```';
    const { container, unmount } = await render(md);
    const pre = container.querySelector('.v10-md-pre');
    expect(pre).toBeTruthy();
    // The plain-text fallback is rendered immediately while shiki resolves.
    expect(container.querySelector('.v10-md-pre-fallback, .v10-md-pre-rendered')).toBeTruthy();
    // Copy button is part of the CodeBlock.
    expect(container.querySelector('.v10-md-copy')).toBeTruthy();
    await unmount();
  });

  it('renders UNLABELLED fenced code blocks via CodeBlock — not inline (Codex BOjOQ)', async () => {
    // Block detection moved into the `pre` renderer so it doesn't rely on
    // react-markdown's flaky `node.parent`. Fence without a language tag
    // must still produce a CodeBlock (.v10-md-pre + .v10-md-copy), not an
    // inline `<code class="v10-md-code">`.
    const md = '```\nfoo\n```';
    const { container, unmount } = await render(md);
    expect(container.querySelector('.v10-md-pre')).toBeTruthy();
    expect(container.querySelector('.v10-md-copy')).toBeTruthy();
    // The text content survives as a code block, not as an inline chip.
    expect(container.textContent ?? '').toContain('foo');
    expect(container.querySelector('.v10-md-code')).toBeNull();
    await unmount();
  });

  it('G1 sanitization: <script> in content is rendered as escaped text, not as a script tag', async () => {
    const md = '<script>alert(1)</script>\n\nhello';
    const { container, unmount } = await render(md);
    // react-markdown default sanitizes raw HTML — there should be no real
    // script tag in the rendered DOM.
    expect(container.querySelector('script')).toBeNull();
    // The literal characters survive somewhere as visible text.
    expect(container.textContent ?? '').toContain('alert(1)');
    expect(container.textContent ?? '').toContain('hello');
    await unmount();
  });

  it('G3 plaintext fallback: unsupported lang ("pascal") renders the plain <pre><code> fallback (no shiki)', async () => {
    const md = '```pascal\nbegin\nend.\n```';
    const { container, unmount } = await render(md);

    const pre = container.querySelector('.v10-md-pre');
    expect(pre).toBeTruthy();
    // CodeBlock's plain-text fallback path: normalizeLang returns null and the
    // effect short-circuits — `.v10-md-pre-fallback` stays in the DOM and
    // `.v10-md-pre-rendered` is NOT set.
    expect(container.querySelector('.v10-md-pre-fallback')).toBeTruthy();
    expect(container.querySelector('.v10-md-pre-rendered')).toBeNull();
    // The original source is preserved verbatim in the fallback <code>.
    const code = container.querySelector('.v10-md-pre-fallback code');
    expect(code?.textContent).toBe('begin\nend.');
    // CRITICAL: with no supported language, shiki must never load.
    // `beforeEach` resets the module cache + counter, so this is the
    // exact load count for THIS test — no delta arithmetic needed.
    expect(shikiImportCount).toBe(0);
    await unmount();
  });

  it('lazy-shiki gate: rendering markdown with NO fenced blocks does not trigger import("shiki")', async () => {
    const md = '# Heading\n\nSome **bold** text with `inline code` and a [link](https://x.test).\n\n- a\n- b\n';
    const { container, unmount } = await render(md);
    // Sanity: rich markdown rendered.
    expect(container.querySelector('.v10-md-h1')).toBeTruthy();
    expect(container.querySelector('code.v10-md-code')).toBeTruthy();
    expect(container.querySelector('.v10-md-link')).toBeTruthy();
    // Gate: shiki should not have been imported.
    expect(shikiImportCount).toBe(0);
    await unmount();
  });

  it('remark-breaks: single newline inside a paragraph becomes a <br>', async () => {
    const { container, unmount } = await render('Line 1\nLine 2');
    const p = container.querySelector('.v10-md-p');
    expect(p).toBeTruthy();
    expect(p!.querySelector('br')).toBeTruthy();
    // The paragraph still contains both lines as text content.
    expect(p!.textContent ?? '').toContain('Line 1');
    expect(p!.textContent ?? '').toContain('Line 2');
    await unmount();
  });

  it('renders a paragraph wrapped in .v10-md-p', async () => {
    const { container, unmount } = await render('just a paragraph');
    const p = container.querySelector('p.v10-md-p');
    expect(p).toBeTruthy();
    expect(p?.textContent).toBe('just a paragraph');
    await unmount();
  });

  it('combines bold + inline code in a single paragraph (legacy fixture: "Hello **world**\\n`code`")', async () => {
    // Matches the legacy fixture team-lead carried into panel-right.logic
    // after the regex-renderer was removed.
    const { container, unmount } = await render('Hello **world**\n`code`');
    const p = container.querySelector('.v10-md-p');
    expect(p).toBeTruthy();
    expect(p?.querySelector('strong')?.textContent).toBe('world');
    expect(p?.querySelector('code.v10-md-code')?.textContent).toBe('code');
    expect(p?.querySelector('br')).toBeTruthy();
    await unmount();
  });
});

describe('MarkdownMessage streaming caret (PR5 item C)', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    vi.resetModules();
    shikiImportCount = 0;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  async function renderStreaming(
    content: string,
    streaming: boolean,
  ): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
    const { MarkdownMessage } = await import('../src/ui/components/chat/MarkdownMessage.js');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(MarkdownMessage, { content, streaming }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    return {
      container,
      unmount: async () => {
        await act(async () => { root.unmount(); });
        container.remove();
      },
    };
  }

  it('renders no caret when not streaming', async () => {
    const { container, unmount } = await renderStreaming('# Title\n\n- a\n- b', false);
    expect(container.querySelectorAll('.v10-chat-cursor').length).toBe(0);
    await unmount();
  });

  it('injects exactly one caret inside the last text node, not as a block sibling', async () => {
    const { container, unmount } = await renderStreaming('# Title\n\nFirst para\n\n- a\n- b', true);
    const carets = container.querySelectorAll('.v10-chat-cursor');
    expect(carets.length).toBe(1);
    // The caret lives inside the LAST list item (last rendered text),
    // not as a trailing child of `.v10-md`.
    const lastLi = container.querySelector('.v10-md-li:last-child');
    expect(lastLi?.querySelector('.v10-chat-cursor')).toBeTruthy();
    const md = container.querySelector('.v10-md')!;
    expect(md.lastElementChild?.classList.contains('v10-chat-cursor')).toBe(false);
    await unmount();
  });

  it('places the caret at the end of a trailing paragraph', async () => {
    const { container, unmount } = await renderStreaming('Hello world', true);
    const p = container.querySelector('.v10-md-p');
    expect(p?.querySelector('.v10-chat-cursor')).toBeTruthy();
    // Visible text is unaffected — no sentinel glyph leaks.
    expect(p?.textContent).toBe('Hello world');
    await unmount();
  });

  it('injects the caret into a trailing INLINE code span (not skipped like fenced code)', async () => {
    // Regression for Codex PR5: inline code is a bare <code> with no
    // <pre> ancestor — a stream ending in `inline` must still show the
    // caret, otherwise the message looks finished early.
    const { container, unmount } = await renderStreaming('run `npm test`', true);
    const inlineCode = container.querySelector('code.v10-md-code');
    expect(inlineCode).toBeTruthy();
    expect(inlineCode?.querySelector('.v10-chat-cursor')).toBeTruthy();
    expect(container.querySelectorAll('.v10-chat-cursor').length).toBe(1);
    await unmount();
  });

  it('suppresses the caret (not parked at stale prose) when a fenced block trails prose', async () => {
    // Regression for Codex PR5: prose then a trailing fenced code block.
    // The last non-code text target is the *earlier* prose; splicing the
    // caret there would park it mid-message before the code block. The
    // caret must be fully suppressed in that case (ChatGPT parity /
    // ux-lead-approved no-caret-while-tail-is-code), NOT left on the
    // stale prose.
    const { container, unmount } = await renderStreaming('Here is the code:\n\n```\nx = 1\n```', true);
    const fenced = container.querySelector('.v10-md-pre');
    expect(fenced).toBeTruthy();
    // Zero carets anywhere — and specifically none parked in the prose.
    expect(container.querySelectorAll('.v10-chat-cursor').length).toBe(0);
    const prose = container.querySelector('.v10-md-p');
    expect(prose?.textContent).toContain('Here is the code:');
    expect(prose?.querySelector('.v10-chat-cursor')).toBeFalsy();
    await unmount();
  });

  it('still places the caret in the last prose when code is NOT the trailing block', async () => {
    // Inverse guard: code earlier, prose after → caret belongs in the
    // trailing prose (trailingCode reset by the later text target).
    const { container, unmount } = await renderStreaming('```\nx = 1\n```\n\nDone explaining', true);
    const carets = container.querySelectorAll('.v10-chat-cursor');
    expect(carets.length).toBe(1);
    const paras = [...container.querySelectorAll('.v10-md-p')];
    const last = paras[paras.length - 1];
    expect(last?.textContent).toContain('Done explaining');
    expect(last?.querySelector('.v10-chat-cursor')).toBeTruthy();
    await unmount();
  });

  it('falls back to a trailing caret when the stream ends with no text node (image)', async () => {
    // Regression for Codex PR5: a streamed message ending in an image
    // has no HAST text node, so the per-text-node anchor finds nothing.
    // Without the fallback the turn looks finished while still
    // streaming. Expect exactly one caret, appended after the content.
    const { container, unmount } = await renderStreaming('![diagram](https://example.com/x.png)', true);
    expect(container.querySelector('.v10-md-image-placeholder')).toBeTruthy();
    expect(container.querySelectorAll('.v10-chat-cursor').length).toBe(1);
    await unmount();
  });

  it('falls back to a trailing caret when an image follows earlier prose (not parked at prose)', async () => {
    // Codex generalization: a non-text tail (image) after prose left the
    // caret stale on the earlier prose. Expect one caret, not in prose.
    const { container, unmount } = await renderStreaming(
      'See diagram\n\n![img](https://example.com/x.png)',
      true,
    );
    expect(container.querySelectorAll('.v10-chat-cursor').length).toBe(1);
    const prose = container.querySelector('.v10-md-p');
    expect(prose?.textContent).toContain('See diagram');
    expect(prose?.querySelector('.v10-chat-cursor')).toBeFalsy();
    await unmount();
  });

  it('falls back to a trailing caret when a horizontal rule follows prose', async () => {
    const { container, unmount } = await renderStreaming('Done\n\n---', true);
    expect(container.querySelector('.v10-md-hr')).toBeTruthy();
    expect(container.querySelectorAll('.v10-chat-cursor').length).toBe(1);
    const prose = container.querySelector('.v10-md-p');
    expect(prose?.querySelector('.v10-chat-cursor')).toBeFalsy();
    await unmount();
  });

  it('keeps the caret in the last text line when a <br> is mid-paragraph (not a tail)', async () => {
    // remark-breaks turns a single newline into <br>. A mid-paragraph
    // <br> is followed by more text, so the caret stays inline at the
    // real end — the leaf tail only triggers when nothing text follows.
    const { container, unmount } = await renderStreaming('line one\nline two', true);
    const p = container.querySelector('.v10-md-p');
    expect(p?.querySelector('.v10-chat-cursor')).toBeTruthy();
    expect(container.querySelectorAll('.v10-chat-cursor').length).toBe(1);
    await unmount();
  });

  it('keeps NO caret for a code-only stream (fallback must not regress the ux-approved behavior)', async () => {
    // A stream that is only a fenced code block has text, but all of it
    // is code (rebuilt by CodeBlock). Per ux-lead sign-off this shows
    // no caret (ChatGPT parity). The image fallback must not leak a
    // caret here — `sawCodeText` suppresses it.
    const { container, unmount } = await renderStreaming('```\ncode only\n```', true);
    expect(container.querySelector('.v10-md-pre')).toBeTruthy();
    expect(container.querySelectorAll('.v10-chat-cursor').length).toBe(0);
    await unmount();
  });
});
