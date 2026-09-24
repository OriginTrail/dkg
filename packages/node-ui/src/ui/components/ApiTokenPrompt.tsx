import { useEffect, useState, type FormEvent } from 'react';
import {
  apiTokenRequired,
  enteredApiToken,
  forgetEnteredApiToken,
  hasServedApiToken,
  saveEnteredApiToken,
} from '../lib/apiToken.js';

type PromptState = 'hidden' | 'required' | 'rejected';

/**
 * Asks for the node API token when the node rejects the page's credentials.
 *
 * The daemon embeds its token only when the dashboard is opened on the node
 * host itself, so a dashboard opened from another machine (or under another
 * host name) loads without one. Nothing shows when the page was served with a
 * token or when authentication is disabled.
 */
export function ApiTokenPrompt({ reload = () => window.location.reload() }: { reload?: () => void }) {
  const [state, setState] = useState<PromptState>('hidden');
  const [value, setValue] = useState('');

  useEffect(() => {
    if (hasServedApiToken()) return;
    let cancelled = false;
    void apiTokenRequired().then((required) => {
      if (cancelled || !required) return;
      const hadEnteredToken = Boolean(enteredApiToken());
      if (hadEnteredToken) forgetEnteredApiToken();
      setState(hadEnteredToken ? 'rejected' : 'required');
    });
    return () => {
      cancelled = true;
    };
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
