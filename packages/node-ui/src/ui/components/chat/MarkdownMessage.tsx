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

export function MarkdownMessage({ content }: MarkdownMessageProps) {
  return (
    <div className="v10-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
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
          a: ({ href, children }) => (
            <a className="v10-md-link" href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          blockquote: ({ children }) => <blockquote className="v10-md-blockquote">{children}</blockquote>,
          hr: () => <hr className="v10-md-hr" />,
          table: ({ children }) => (
            <div className="v10-md-table-scroll">
              <table className="v10-md-table">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="v10-md-thead">{children}</thead>,
          tbody: ({ children }) => <tbody className="v10-md-tbody">{children}</tbody>,
          tr: ({ children }) => <tr className="v10-md-tr">{children}</tr>,
          th: ({ children }) => <th className="v10-md-th">{children}</th>,
          td: ({ children }) => <td className="v10-md-td">{children}</td>,
          pre: ({ children }) => {
            // Unwrap: fenced-block <code> children are rendered via CodeBlock
            // directly, so <pre> should just pass through to avoid double-wrapping.
            return <>{children}</>;
          },
          code: ({ className, children }) => {
            const match = /language-([\w-]+)/.exec(className || '');
            const text = extractCodeText(children).replace(/\n$/, '');
            // Fenced code blocks always carry a `language-*` className, or are
            // emitted as multi-line `<code>` children inside <pre>. Anything
            // else is inline.
            if (match || text.includes('\n')) {
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
