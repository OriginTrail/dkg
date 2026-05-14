import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useLayoutStore } from '../../stores/layout.js';

type Highlighter = {
  codeToHtml: (code: string, opts: { lang: string; theme: string }) => string;
};

// Curated allow-list — kept narrow so the lazy-loaded shiki bundle stays
// small. Includes languages this monorepo actually uses in fenced blocks:
// Solidity contracts, Rust/Go adapters, SPARQL, TOML configs, diffs in
// review threads, and Dockerfiles for deployment notes.
const SUPPORTED_LANGS = [
  'ts', 'tsx', 'js', 'jsx', 'py', 'sh', 'bash', 'json', 'yaml',
  'sql', 'sparql', 'md', 'html', 'css',
  'solidity', 'rust', 'go', 'toml', 'diff', 'dockerfile', 'xml',
] as const;

type SupportedLang = typeof SUPPORTED_LANGS[number];

let highlighterPromise: Promise<Highlighter> | null = null;

function loadHighlighter(): Promise<Highlighter> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = import('shiki').then((shiki) =>
    shiki.createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [...SUPPORTED_LANGS],
    }) as Promise<Highlighter>,
  ).catch((err) => {
    // Reset so the next code block retries instead of holding a dead promise.
    highlighterPromise = null;
    throw err;
  });
  return highlighterPromise;
}

function normalizeLang(raw: string | undefined): SupportedLang | null {
  if (!raw) return null;
  const lang = raw.toLowerCase().trim();
  if ((SUPPORTED_LANGS as readonly string[]).includes(lang)) return lang as SupportedLang;
  // Aliases for languages users commonly tag with shorthand or alternate names.
  if (lang === 'typescript') return 'ts';
  if (lang === 'javascript') return 'js';
  if (lang === 'python') return 'py';
  if (lang === 'shell' || lang === 'zsh') return 'sh';
  if (lang === 'yml') return 'yaml';
  if (lang === 'markdown') return 'md';
  if (lang === 'sol') return 'solidity';
  if (lang === 'rs') return 'rust';
  if (lang === 'golang') return 'go';
  if (lang === 'patch') return 'diff';
  if (lang === 'docker') return 'dockerfile';
  return null;
}

interface CodeBlockProps {
  code: string;
  lang?: string;
}

export function CodeBlock({ code, lang }: CodeBlockProps) {
  const normalizedLang = normalizeLang(lang);
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Read theme from the layout store (the same source that drives `body.light`
  // via App.tsx's effect). Sampling `document.body.classList` here raced with
  // that effect — on initial load with a saved light theme, code blocks would
  // mount before the body class flipped and stay locked to `github-dark`
  // until something else re-rendered them.
  const theme = useLayoutStore((s) => s.theme);
  const themeKey = theme === 'light' ? 'github-light' : 'github-dark';
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!normalizedLang) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    loadHighlighter()
      .then((highlighter) => {
        if (cancelled) return;
        try {
          setHtml(highlighter.codeToHtml(code, { lang: normalizedLang, theme: themeKey }));
        } catch {
          setHtml(null);
        }
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => { cancelled = true; };
  }, [code, normalizedLang, themeKey]);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard may be unavailable (insecure context, denied permission);
      // silently retain idle state — user retries.
    }
  };

  return (
    <div className="v10-md-pre">
      <button
        type="button"
        className="v10-md-copy"
        onClick={onCopy}
        aria-label={copied ? 'Copied' : 'Copy code'}
        title={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
      <span className="v10-md-copy-announce" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
      {normalizedLang && (
        <span className="v10-md-pre-lang" aria-hidden="true">{normalizedLang}</span>
      )}
      {html ? (
        <div className="v10-md-pre-rendered" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="v10-md-pre-fallback"><code>{code}</code></pre>
      )}
    </div>
  );
}
