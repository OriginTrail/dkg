import React, { useState } from 'react';
import JsonView from '@uiw/react-json-view';
import './json-viewer.css';

/** RDF property values are already decoded by useMemoryEntities. */
export function parseJsonContainer(text: string): object | undefined {
  if (!/^[\s]*[\[{]/.test(text)) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : undefined;
  } catch { return undefined; }
}

export function JsonText({ text, label }: { text: string; label: string }) {
  const value = parseJsonContainer(text);
  return value === undefined ? <pre>{text}</pre> : <JsonViewer value={value} label={label} />;
}

/** Read-only JSON tree. Viewing/copying a permission never changes its approval. */
export function JsonViewer({ value, label = 'JSON' }: { value: object; label?: string }) {
  const [expansion, setExpansion] = useState({ collapsed: 1 as number | boolean, revision: 0 });
  const [copyStatus, setCopyStatus] = useState('');
  const count = Object.keys(value).length;
  const toggleAll = (collapsed: boolean) => setExpansion(current => ({ collapsed, revision: current.revision + 1 }));

  const copy = async () => {
    const text = JSON.stringify(value, null, 2);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Node dashboards are also served over HTTP, without the Clipboard API.
        const active = document.activeElement;
        const input = document.createElement('textarea');
        input.value = text;
        input.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.append(input);
        try {
          input.select();
          if (!document.execCommand('copy')) throw new Error('Copy unavailable');
        } finally {
          input.remove();
          if (active instanceof HTMLElement) active.focus({ preventScroll: true });
        }
      }
      setCopyStatus('Copied');
    } catch { setCopyStatus('Copy failed'); }
  };

  return <section className="v10-json-viewer" aria-label={label}>
    <div className="v10-json-toolbar">
      <span className="v10-json-caption">JSON <span>{count} {Array.isArray(value) ? 'items' : 'keys'}</span></span>
      <div className="v10-json-actions">
        <button type="button" onClick={() => toggleAll(false)}>Expand all</button>
        <button type="button" onClick={() => toggleAll(true)}>Collapse all</button>
        <button type="button" onClick={copy}>Copy JSON</button>
      </div>
      {copyStatus && <span className="v10-json-copy-status" role="status">{copyStatus}</span>}
    </div>
    <div className="v10-json-tree" tabIndex={0} aria-label={`${label} tree`}>
      <JsonView key={expansion.revision} value={value} collapsed={expansion.collapsed}
        displayDataTypes={false} enableClipboard={false} highlightUpdates={false}
        shortenTextAfterLength={80} indentWidth={18} style={{ fontSize: 12, lineHeight: 1.8 }}>
        <JsonView.Arrow render={({ style }, { keyName }) => <button type="button"
          className="v10-json-toggle" style={style} aria-label={`Toggle ${keyName ?? 'JSON'}`}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>} />
      </JsonView>
    </div>
  </section>;
}
