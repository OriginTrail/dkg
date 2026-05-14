// @vitest-environment happy-dom
//
// Covers PR3 CodeBlock: plain `<pre><code>` fallback before shiki resolves,
// Copy button click → clipboard.writeText(code), Copied-state flip for ~1200ms,
// and silent failure path when clipboard.writeText rejects.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { CodeBlock } from '../src/ui/components/chat/CodeBlock.js';

async function renderCodeBlock(
  props: { code: string; lang?: string },
): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(CodeBlock, props));
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

let writeTextMock: ReturnType<typeof vi.fn>;

function installClipboardMock(impl?: (value: string) => Promise<void> | void): void {
  writeTextMock = vi.fn(impl ?? (async () => undefined));
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeTextMock },
  });
}

function uninstallClipboardMock(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (navigator as any).clipboard;
  } catch {
    // happy-dom may make `clipboard` configurable but not deletable; reset.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
  }
}

describe('CodeBlock', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    document.body.classList.remove('light');
    vi.useFakeTimers();
    installClipboardMock();
  });

  afterEach(() => {
    vi.useRealTimers();
    uninstallClipboardMock();
    vi.restoreAllMocks();
  });

  it('renders the plain <pre><code> fallback for content before shiki resolves', async () => {
    const code = 'const x = 1;';
    const { container, unmount } = await renderCodeBlock({ code, lang: 'ts' });
    const fallbackPre = container.querySelector('pre.v10-md-pre-fallback');
    expect(fallbackPre).toBeTruthy();
    expect(fallbackPre!.querySelector('code')?.textContent).toBe(code);
    await unmount();
  });

  it('renders the same fallback path when lang is unsupported (normalizeLang null)', async () => {
    const { container, unmount } = await renderCodeBlock({ code: 'begin\nend.', lang: 'pascal' });
    expect(container.querySelector('pre.v10-md-pre-fallback')).toBeTruthy();
    // Shiki-rendered slot must not appear when normalizeLang yields null.
    expect(container.querySelector('.v10-md-pre-rendered')).toBeNull();
    await unmount();
  });

  it('renders the same fallback path when no lang prop is supplied', async () => {
    const { container, unmount } = await renderCodeBlock({ code: 'plain text' });
    expect(container.querySelector('pre.v10-md-pre-fallback')).toBeTruthy();
    await unmount();
  });

  it('awaits the shiki-rendered path for a supported language (Codex CHMTB)', async () => {
    // Regression cover: every other test in this suite asserts only the
    // immediate plain-text fallback. A broken shiki bundle, a botched
    // `normalizeLang` map, or a wrong theme key would still pass them
    // all — the rendered branch never executes in the assertions. Mock
    // `shiki` per-test, re-import CodeBlock through a fresh module
    // graph (the test file imports the real component at the top), then
    // wait for the async `loadHighlighter().then(setHtml)` chain to
    // settle and assert that `.v10-md-pre-rendered` actually replaced
    // the fallback with the highlighter's output.
    vi.useRealTimers(); // shiki path uses promises/microtasks, not setTimeout
    vi.resetModules();
    vi.doMock('shiki', () => ({
      createHighlighter: async () => ({
        codeToHtml: (code: string, opts: { lang: string; theme: string }) =>
          `<pre class="shiki shiki-${opts.theme}" data-lang="${opts.lang}"><code>SHIKI:${code}</code></pre>`,
      }),
    }));
    const { CodeBlock: FreshCodeBlock } = await import('../src/ui/components/chat/CodeBlock.js');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(FreshCodeBlock, { code: 'const x = 1;', lang: 'ts' }));
    });
    // Flush the loadHighlighter promise chain + the setHtml-triggered
    // re-render. Two ticks: one for the dynamic import + createHighlighter
    // resolution, one for React to commit the state update.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = container.querySelector('.v10-md-pre-rendered') as HTMLElement | null;
    expect(rendered, '.v10-md-pre-rendered should replace the fallback once shiki resolves').toBeTruthy();
    expect(container.querySelector('.v10-md-pre-fallback')).toBeNull();
    // The mocked highlighter output is what got dangerouslySetInnerHTML-ed.
    // Confirms `code`, `lang`, and the theme key (dark default) all
    // flowed through normalizeLang → useEffect → codeToHtml correctly.
    expect(rendered!.innerHTML).toContain('SHIKI:const x = 1;');
    expect(rendered!.innerHTML).toContain('data-lang="ts"');
    expect(rendered!.innerHTML).toContain('shiki-github-dark');

    await act(async () => { root.unmount(); });
    container.remove();
    vi.doUnmock('shiki');
    vi.resetModules();
  });

  it('renders a copy button with aria-label="Copy code" in the idle state', async () => {
    const { container, unmount } = await renderCodeBlock({ code: 'x', lang: 'ts' });
    const btn = container.querySelector('.v10-md-copy') as HTMLButtonElement | null;
    expect(btn).toBeTruthy();
    expect(btn!.getAttribute('aria-label')).toBe('Copy code');
    expect(btn!.getAttribute('title')).toBe('Copy code');
    // Copy icon (lucide-react SVG) is rendered inside the button.
    expect(btn!.querySelector('svg')).toBeTruthy();
    await unmount();
  });

  it('clicking the copy button calls navigator.clipboard.writeText with the code', async () => {
    const code = 'export const greeting = "hi";\n';
    const { container, unmount } = await renderCodeBlock({ code, lang: 'ts' });
    const btn = container.querySelector('.v10-md-copy') as HTMLButtonElement;

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // resolve the writeText promise + the React setState that follows
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
    });

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith(code);
    await unmount();
  });

  it('after a successful copy, button switches to aria-label="Copied" and reverts after ~1200ms', async () => {
    const { container, unmount } = await renderCodeBlock({ code: 'x', lang: 'ts' });
    const btn = () => container.querySelector('.v10-md-copy') as HTMLButtonElement;

    await act(async () => {
      btn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // flush the writeText microtask so setCopied(true) runs
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(btn().getAttribute('aria-label')).toBe('Copied');
    expect(btn().getAttribute('title')).toBe('Copied');

    // Live-region announces "Copied".
    const announce = container.querySelector('.v10-md-copy-announce');
    expect(announce?.textContent).toBe('Copied');

    // Advance past the 1200ms revert.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
    });
    expect(btn().getAttribute('aria-label')).toBe('Copy code');
    expect(container.querySelector('.v10-md-copy-announce')?.textContent).toBe('');
    await unmount();
  });

  it('failed clipboard.writeText keeps the button in the idle Copy state (no error UI)', async () => {
    installClipboardMock(async () => {
      throw new Error('blocked');
    });
    const { container, unmount } = await renderCodeBlock({ code: 'x', lang: 'ts' });
    const btn = container.querySelector('.v10-md-copy') as HTMLButtonElement;

    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(btn.getAttribute('aria-label')).toBe('Copy code');
    expect(container.querySelector('.v10-md-copy-announce')?.textContent).toBe('');
    await unmount();
  });

  it('renders the language tag .v10-md-pre-lang when lang is supported', async () => {
    const { container, unmount } = await renderCodeBlock({ code: 'x', lang: 'TypeScript' });
    const tag = container.querySelector('.v10-md-pre-lang');
    expect(tag).toBeTruthy();
    // normalizeLang lowercases + maps "TypeScript" → "ts".
    expect(tag?.textContent).toBe('ts');
    await unmount();
  });

  it('does NOT render the language tag for unsupported lang (normalizeLang null)', async () => {
    const { container, unmount } = await renderCodeBlock({ code: 'x', lang: 'pascal' });
    expect(container.querySelector('.v10-md-pre-lang')).toBeNull();
    await unmount();
  });

  it('recognises monorepo-relevant aliases (Codex CF4Ae)', async () => {
    // Solidity is the most common fenced-block language in this repo
    // (contracts, audit notes). Earlier allow-list omitted it and similar
    // languages (Rust, Go, TOML, diff, Dockerfile) — fenced blocks
    // silently fell through to the plain-text path even though the
    // panel advertises syntax-highlighted code blocks.
    const cases: Array<[string, string]> = [
      ['sol', 'solidity'],
      ['solidity', 'solidity'],
      ['rs', 'rust'],
      ['rust', 'rust'],
      ['golang', 'go'],
      ['go', 'go'],
      ['toml', 'toml'],
      ['diff', 'diff'],
      ['patch', 'diff'],
      ['docker', 'dockerfile'],
    ];
    for (const [input, expected] of cases) {
      const { container, unmount } = await renderCodeBlock({ code: 'x', lang: input });
      const tag = container.querySelector('.v10-md-pre-lang');
      expect(tag?.textContent, `expected ${input} → ${expected}`).toBe(expected);
      await unmount();
    }
  });
});
