import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { CodeBlock } from './CodeBlock.js';

interface MarkdownMessageProps {
  content: string;
}

// Treat a URL as absolute (and therefore worth opening in a new tab) only if
// it has an explicit scheme. Relative routes, hash anchors, and mailto: should
// keep their normal navigation semantics so an in-app link doesn't strand the
// user in a popup.
function isExternalHref(href: string | undefined): boolean {
  if (!href) return false;
  return /^https?:\/\//i.test(href);
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
            const external = isExternalHref(href);
            return external
              ? (
                <a className="v10-md-link" href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              )
              : (
                <a className="v10-md-link" href={href}>
                  {children}
                </a>
              );
          },
          blockquote: ({ children }) => <blockquote className="v10-md-blockquote">{children}</blockquote>,
          hr: () => <hr className="v10-md-hr" />,
          table: ({ children }) => (
            <div className="v10-md-table-scroll">
              <table className="v10-md-table">{children}</table>
            </div>
          ),
          thead: ({ children, ...props }) => <thead className="v10-md-thead" {...props}>{children}</thead>,
          tbody: ({ children, ...props }) => <tbody className="v10-md-tbody" {...props}>{children}</tbody>,
          tr: ({ children, ...props }) => <tr className="v10-md-tr" {...props}>{children}</tr>,
          // Spread remaining props so remark-gfm's column-alignment metadata
          // (`style={{ textAlign: 'right' | 'center' }}` derived from
          // `|:---|---:|:---:|` syntax) survives our wrapper.
          th: ({ children, ...props }) => <th className="v10-md-th" {...props}>{children}</th>,
          td: ({ children, ...props }) => <td className="v10-md-td" {...props}>{children}</td>,
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
