import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { CodeBlock } from './CodeBlock.js';

interface MarkdownMessageProps {
  content: string;
}

// Chat content is untrusted. Relative hrefs (`/admin`, `../foo`, `#section`)
// would otherwise resolve against the current origin and silently navigate
// the user away inside the app. Limit clickable links to an explicit safe
// scheme allow-list — http(s) and mailto — and render anything else as
// inert text so the user can still see the literal URL but cannot be
// hijacked into a same-origin navigation by an agent message.
function classifyHref(href: string | undefined): 'http' | 'mailto' | 'inert' {
  if (!href) return 'inert';
  if (/^https?:\/\//i.test(href)) return 'http';
  if (/^mailto:/i.test(href)) return 'mailto';
  return 'inert';
}

export function MarkdownMessage({ content }: MarkdownMessageProps) {
  return (
    <div className="v10-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          // Agent output is untrusted. The default `img` renderer would fetch
          // arbitrary URLs (`![pixel](https://attacker.example/x.png)`),
          // introducing a privacy/tracking surface that the previous regex
          // renderer never had. Replace with an inert placeholder chip that
          // surfaces the alt text + URL so the user can decide whether to
          // open it manually — `disallowedElements` would just drop the
          // node, including its alt text.
          img: ({ src, alt, title }) => (
            <span
              className="v10-md-image-placeholder"
              title={title || (typeof src === 'string' ? src : undefined)}
            >
              [image{alt ? `: ${alt}` : ''}]
            </span>
          ),
          h1: ({ children }) => <h1 className="v10-md-h1">{children}</h1>,
          h2: ({ children }) => <h2 className="v10-md-h2">{children}</h2>,
          h3: ({ children }) => <h3 className="v10-md-h3">{children}</h3>,
          h4: ({ children }) => <h4 className="v10-md-h4">{children}</h4>,
          h5: ({ children }) => <h5 className="v10-md-h5">{children}</h5>,
          h6: ({ children }) => <h6 className="v10-md-h6">{children}</h6>,
          p: ({ children }) => <p className="v10-md-p">{children}</p>,
          ul: ({ children }) => <ul className="v10-md-ul">{children}</ul>,
          ol: ({ children }) => <ol className="v10-md-ol">{children}</ol>,
          li: ({ children }) => <li className="v10-md-li">{children}</li>,
          a: ({ href, children }) => {
            const kind = classifyHref(href);
            if (kind === 'http') {
              return (
                <a className="v10-md-link" href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            }
            if (kind === 'mailto') {
              return (
                <a className="v10-md-link" href={href}>
                  {children}
                </a>
              );
            }
            // Relative / fragment / javascript:/data: hrefs from untrusted
            // chat content render as inert text so an agent can't silently
            // navigate the user away inside the app. The literal URL is
            // exposed via `title` so the user can still inspect it.
            return (
              <span className="v10-md-link v10-md-link-inert" title={href}>
                {children}
              </span>
            );
          },
          blockquote: ({ children }) => <blockquote className="v10-md-blockquote">{children}</blockquote>,
          hr: () => <hr className="v10-md-hr" />,
          table: ({ children }) => (
            <div className="v10-md-table-scroll">
              <table className="v10-md-table">{children}</table>
            </div>
          ),
          // react-markdown passes a synthetic `node` (HAST node) prop into
          // every component renderer. Spreading remaining props onto a
          // DOM element forwards `node` to the underlying tag, which
          // React then flags as an unknown DOM attribute in dev / test
          // builds. Destructure `node` out before the spread so it
          // never reaches the DOM — Codex CG3L5.
          thead: ({ children, node: _node, ...props }) => <thead className="v10-md-thead" {...props}>{children}</thead>,
          tbody: ({ children, node: _node, ...props }) => <tbody className="v10-md-tbody" {...props}>{children}</tbody>,
          tr: ({ children, node: _node, ...props }) => <tr className="v10-md-tr" {...props}>{children}</tr>,
          // Spread remaining props so remark-gfm's column-alignment metadata
          // (`style={{ textAlign: 'right' | 'center' }}` derived from
          // `|:---|---:|:---:|` syntax) survives our wrapper.
          th: ({ children, node: _node, ...props }) => <th className="v10-md-th" {...props}>{children}</th>,
          td: ({ children, node: _node, ...props }) => <td className="v10-md-td" {...props}>{children}</td>,
          pre: ({ children, node }) => {
            // Block-vs-inline detection lives here, NOT in the `code`
            // renderer. react-markdown does not populate `node.parent`
            // reliably, so the previous `parent?.tagName === 'pre'` test
            // missed unlabelled fenced blocks like:
            //   ```
            //   foo
            //   ```
            // In markdown, however, a `<pre>` always wraps a fenced code
            // block — there's no other source construct that produces
            // one. Read the inner <code> AST node directly from this
            // renderer to get the language class + raw text, regardless
            // of whether the fence had a language tag.
            const codeAstNode = (
              node as
                | {
                    children?: Array<{
                      tagName?: string;
                      properties?: { className?: string[] };
                      children?: Array<{ value?: string }>;
                    }>;
                  }
                | undefined
            )?.children?.[0];
            if (codeAstNode?.tagName === 'code') {
              const classNameValue = codeAstNode.properties?.className?.[0] ?? '';
              const match = /language-([\w-]+)/.exec(classNameValue);
              const rawText = (codeAstNode.children ?? [])
                .map((n) => n?.value ?? '')
                .join('')
                .replace(/\n$/, '');
              return <CodeBlock code={rawText} lang={match?.[1]} />;
            }
            return <pre>{children}</pre>;
          },
          code: ({ children }) => {
            // Fenced blocks are handled in the `pre` renderer above —
            // this path is strictly inline code now.
            return <code className="v10-md-code">{children}</code>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
