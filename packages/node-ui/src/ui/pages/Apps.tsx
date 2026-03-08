import React, { useEffect, useRef, useCallback } from 'react';

/**
 * Renders the OriginTrail Game inside the Node Dashboard by embedding
 * its standalone UI in an iframe. This avoids duplicating game code
 * and ensures the dashboard always shows the latest game UI.
 *
 * Token handoff uses a one-time nonce: on first load the parent sends a
 * random nonce to the iframe. The iframe echoes it back in its token
 * request. The parent delivers the token only when the nonce matches,
 * then marks the handshake complete. Subsequent iframe loads (e.g. from
 * navigation to untrusted content) are refused — no new nonce is issued.
 */
export function AppsPage() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const nonceRef = useRef<string | null>(null);
  const handshakeCompleteRef = useRef(false);

  const sendNonce = useCallback(() => {
    if (handshakeCompleteRef.current) return;
    if (!iframeRef.current?.contentWindow) return;
    const nonce = crypto.randomUUID();
    nonceRef.current = nonce;
    iframeRef.current.contentWindow.postMessage({ type: 'dkg-nonce', nonce }, '*');
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (
        e.data?.type === 'dkg-token-request' &&
        iframeRef.current?.contentWindow === e.source &&
        typeof e.data.nonce === 'string' &&
        e.data.nonce === nonceRef.current
      ) {
        nonceRef.current = null;
        const token = (window as any).__DKG_TOKEN__;
        if (token) {
          iframeRef.current.contentWindow!.postMessage(
            { type: 'dkg-token', token, apiOrigin: window.location.origin },
            '*',
          );
          handshakeCompleteRef.current = true;
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <iframe
      ref={iframeRef}
      src="/apps/origin-trail-game/"
      onLoad={sendNonce}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      allow="clipboard-write"
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        borderRadius: 8,
        background: '#111',
      }}
      title="OriginTrail Game"
    />
  );
}
