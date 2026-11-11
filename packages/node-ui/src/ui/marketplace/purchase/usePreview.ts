// The node's dry run of a request, kept fresh as the request changes. Each
// answer stays tied to the request it was made for, so an answer to one
// request is never taken for the answer to another: only `current` may stand
// behind a confirmation, and it is the answer to exactly the request asked
// about now, with nothing newer on the way. The caller builds the request and
// picks the route that answers it.
import { useEffect, useRef, useState } from 'react';
import type { Preview } from '../api/types.js';

/** A dry run's answer and the request it answers. */
export interface Answered<R> { request: R; preview: Preview }

/**
 * What stays on show while a changed request's answer loads: `last` keeps the
 * previous answer (and its error), so the line does not flicker while typing;
 * `none` clears both at once.
 */
export type Retain = 'last' | 'none';

export interface PreviewState<R> {
  /** The answer on show: the request's own, or, under `retain: 'last'`, the one before while the new one loads. */
  shown: Answered<R> | null;
  /** The answer to exactly the request asked about now, once nothing newer is loading; null otherwise. */
  current: Answered<R> | null;
  err: unknown;
  busy: boolean;
}

/** How long a request must hold still before the node is asked. */
const SETTLE_MS = 250;

/**
 * Ask `ask(request)` once `request` holds still, and again whenever it or
 * `round` changes; `round` asks again for the same request (after a failed
 * send, say). A null request (invalid input, or nothing to ask) clears the
 * answer and the error. A late answer to a request no longer asked about is
 * dropped.
 */
export function usePreview<R>(
  request: R | null,
  ask: (request: R) => Promise<Preview>,
  { retain, round = 0 }: { retain: Retain; round?: number },
): PreviewState<R> {
  // The request's identity: what it asks, and in which round.
  const identity = request === null ? null : `${round}:${JSON.stringify(request)}`;
  const [answer, setAnswer] = useState<{ identity: string; answered: Answered<R> } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef({ request, ask });
  latest.current = { request, ask };

  useEffect(() => {
    if (identity === null) { setAnswer(null); setErr(null); setBusy(false); return undefined; }
    if (retain === 'none') { setAnswer(null); setErr(null); }
    const { request: asked, ask: send } = latest.current;
    let live = true;
    setBusy(true);
    const t = setTimeout(() => {
      send(asked as R)
        .then((preview) => { if (live) { setAnswer({ identity, answered: { request: asked as R, preview } }); setErr(null); } })
        .catch((e: unknown) => { if (live) { setAnswer(null); setErr(e); } })
        .finally(() => { if (live) setBusy(false); });
    }, SETTLE_MS);
    return () => { live = false; clearTimeout(t); };
  }, [identity, retain]);

  const shown = answer?.answered ?? null;
  return { shown, current: !busy && answer !== null && answer.identity === identity ? answer.answered : null, err, busy };
}
