import { useEffect, useState, type FormEvent } from 'react';
import {
  apiTokenStatus,
  enteredApiToken,
  forgetEnteredApiToken,
  hasServedApiToken,
  saveEnteredApiToken,
} from '../lib/apiToken.js';

type PromptState = 'hidden' | 'required' | 'rejected';

// Delay before asking again after an inconclusive probe, by attempt; the last
// value repeats.
const PROBE_RETRY_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

function defaultProbeRetryMs(attempt: number): number {
  return PROBE_RETRY_MS[Math.min(attempt, PROBE_RETRY_MS.length - 1)];
}

/**
 * Asks for the node API token when the node rejects the page's credentials.
 *
 * The daemon embeds its token only when the dashboard is opened on the node
 * host itself, so a dashboard opened from another machine (or under another
 * host name) loads without one. Nothing shows when the page was served with a
 * token or when authentication is disabled.
 */
export function ApiTokenPrompt({
  reload = () => window.location.reload(),
  probeRetryMs = defaultProbeRetryMs,
}: {
  reload?: () => void;
  probeRetryMs?: (attempt: number) => number;
}) {
  const [state, setState] = useState<PromptState>('hidden');
  const [value, setValue] = useState('');

  useEffect(() => {
    if (hasServedApiToken()) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const probe = async (attempt: number) => {
      const status = await apiTokenStatus();
      if (cancelled) return;
      if (status === 'unknown') {
        // A busy or unreachable node says nothing about the credentials.
        retryTimer = setTimeout(() => { void probe(attempt + 1); }, probeRetryMs(attempt));
        return;
      }
      if (status === 'accepted') return;
      const hadEnteredToken = Boolean(enteredApiToken());
      if (hadEnteredToken) forgetEnteredApiToken();
      setState(hadEnteredToken ? 'rejected' : 'required');
    };
    void probe(0);
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
    // The retry schedule is fixed for the lifetime of the prompt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === 'hidden') return null;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    // A token kept in tab storage survives a reload, which refetches everything
    // with it. A token that could only be kept in memory would be lost by a
    // reload, so `Root` remounts the dashboard in place instead.
    if (saveEnteredApiToken(value)) reload();
  };

  return (
    <form className="v10-token-prompt" aria-label="Node API token" onSubmit={onSubmit}>
      <span className="v10-token-prompt-text">
        <strong>API token required</strong>
        {state === 'rejected' ? ' — the node did not accept that token.' : ' —'} The node
        passes its token to the dashboard only when it is opened on the node host. Paste
        the token from <code>auth.token</code> on the node host to use this dashboard
        at <strong>{window.location.host}</strong> (kept for this tab only).
      </span>
      <input
        className="v10-token-prompt-input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        aria-label="API token"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="v10-token-prompt-submit" disabled={!value.trim()}>
        Use token
      </button>
    </form>
  );
}
