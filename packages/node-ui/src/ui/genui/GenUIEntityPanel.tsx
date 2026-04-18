/**
 * Streams OpenUI Lang from the daemon's /api/genui/render endpoint and renders
 * the resulting component tree progressively using @openuidev/react-lang's
 * Renderer.
 *
 * Drop this in anywhere we show an entity detail — e.g. EntityDetail panel
 * in the LayerContent tabs. Falls back to a `fallback` prop if the LLM is
 * not configured on the daemon (`503`) or streaming errors out.
 */
import React from 'react';
import { Renderer } from '@openuidev/react-lang';
import { genuiLibrary, getGenuiLibraryPrompt } from './registry.js';
import { streamGenUI } from './streamGenUI.js';
import { useTabsStore } from '../stores/tabs.js';

export interface GenUIEntityPanelProps {
  contextGraphId: string;
  entityUri: string;
  /** Rendered while the first delta hasn't arrived yet. */
  placeholder?: React.ReactNode;
  /** Rendered when LLM not configured, 404, or the stream errors. */
  fallback?: (err: string) => React.ReactNode;
}

export const GenUIEntityPanel: React.FC<GenUIEntityPanelProps> = ({
  contextGraphId,
  entityUri,
  placeholder,
  fallback,
}) => {
  const [response, setResponse] = React.useState<string>('');
  const [isStreaming, setIsStreaming] = React.useState<boolean>(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    let accumulated = '';
    setResponse('');
    setError(null);
    setIsStreaming(true);

    (async () => {
      try {
        const libraryPrompt = getGenuiLibraryPrompt();
        for await (const ev of streamGenUI({
          contextGraphId,
          entityUri,
          libraryPrompt,
          signal: controller.signal,
        })) {
          if (ev.type === 'delta') {
            accumulated += ev.text;
            setResponse(accumulated);
          } else if (ev.type === 'final') {
            if (ev.content) {
              accumulated = ev.content;
              setResponse(ev.content);
            }
          } else if (ev.type === 'error') {
            setError(ev.error);
            break;
          } else if (ev.type === 'done') {
            break;
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message);
        }
      } finally {
        setIsStreaming(false);
      }
    })();

    return () => controller.abort();
  }, [contextGraphId, entityUri]);

  if (error) {
    if (fallback) return <>{fallback(error)}</>;
    return <GenUIErrorBlock error={error} />;
  }

  if (!response && isStreaming) {
    return <>{placeholder ?? <div className="v10-genui-loading">Composing detail view…</div>}</>;
  }

  return (
    <div className="v10-genui-panel">
      <Renderer
        response={response}
        library={genuiLibrary}
        isStreaming={isStreaming}
      />
    </div>
  );
};

// ── Error block ──────────────────────────────────────────────
// The most common failure mode in practice is the daemon responding 503
// because no LLM API key is configured. Detect that specifically and
// offer a one-click jump to the Settings tab where the key is set.
const LLM_NOT_CONFIGURED_HINT = 'LLM not configured';

const GenUIErrorBlock: React.FC<{ error: string }> = ({ error }) => {
  const openTab = useTabsStore((s) => s.openTab);
  const isLlmMissing = error.includes(LLM_NOT_CONFIGURED_HINT);

  if (!isLlmMissing) {
    return <div className="v10-genui-error">GenUI unavailable: {error}</div>;
  }

  return (
    <div className="v10-genui-error v10-genui-error-cta">
      <div className="v10-genui-error-head">
        <span className="v10-genui-error-icon">⚙</span>
        <div>
          <div className="v10-genui-error-title">Set up your LLM to enable GenUI</div>
          <div className="v10-genui-error-desc">
            GenUI streams entity detail views from an OpenAI-compatible model.
            Add an API key in Settings and open this entity again.
          </div>
        </div>
      </div>
      <button
        className="v10-genui-error-cta-btn"
        onClick={() => openTab({ id: 'settings', label: 'Settings', closable: true })}
      >
        Open Settings →
      </button>
    </div>
  );
};
