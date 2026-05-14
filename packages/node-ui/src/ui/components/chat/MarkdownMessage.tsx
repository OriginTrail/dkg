import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { CodeBlock } from './CodeBlock.js';

interface MarkdownMessageProps {
  content: string;
}

function extractCodeText(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractCodeText).join('');
  if (React.isValidElement(children)) {
    const childChildren = (children.props as { children?: React.ReactNode }).children;
    return extractCodeText(childChildren);
  }
  return '';
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
        // Agent output is untrusted. The default `img` renderer would fetch
        // arbitrary URLs (`![pixel](https://attacker.example/x.png)`),
        // introducing a privacy/tracking surface that the previous regex
        // renderer never had. Strip <img> here; the alt text falls through as
        // plain prose for the user to evaluate.
        disallowedElements={['img']}
        unwrapDisallowed
        components={{
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
          pre: ({ children }) => {
            // Unwrap: fenced-block <code> children are rendered via CodeBlock
            // directly, so <pre> should just pass through to avoid double-wrapping.
            return <>{children}</>;
          },
          code: ({ className, children, node }) => {
            const match = /language-([\w-]+)/.exec(className || '');
            const text = extractCodeText(children).replace(/\n$/, '');
            // Block-vs-inline detection: react-markdown's HAST tree marks the
            // parent of a fenced block as a `<pre>` element. If the parent is
            // a `<pre>`, this is a fenced block — regardless of whether the
            // source had a language tag or only a single line of content.
            // The previous newline-based heuristic missed `\`\`\`\nfoo\n\`\`\``.
            const parent = (node as unknown as { parent?: { tagName?: string } } | undefined)?.parent;
            const isBlock = Boolean(match) || parent?.tagName === 'pre';
            if (isBlock) {
              return <CodeBlock code={text} lang={match?.[1]} />;
            }
            return <code className="v10-md-code">{children}</code>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
